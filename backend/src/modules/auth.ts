import express from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiError } from "../utils/ApiError";
import { ok, created } from "../utils/http";
import { effectivePermissions } from "../lib/permissions";
import { randomToken, verifySecret, verifyPassword, sha256, contentDispositionFilename } from "../utils/crypto";
import { signAuthToken } from "../utils/jwt";
import {
  buildTotpUri,
  decryptTotpSecret,
  encryptTotpSecret,
  generateTotpSecret,
  qrDataUrl,
  verifyTotpCode,
} from "../utils/totp";
import { authenticate, optionalAuthenticate, requireAuth, requirePermission } from "../middleware/auth";
import { clearAuthCache, invalidateAuthSessions } from "../lib/authCache";
import { logAudit } from "../services/audit.service";
import { notifyUser } from "../services/notification.service";
import { sendTemplateEmail } from "../integrations/email/email.service";
import { storeFile, readStoredFile, STORAGE_BUCKETS } from "../storage/index";
import { upload } from "../middleware/upload";
import { authRateLimiter, totpRateLimiter } from "../middleware/rateLimit";
import { env } from "../config/env";

const router = express.Router();

const emailSchema = z.string().email().trim().toLowerCase();
const otpCodeSchema = z.string().length(6).regex(/^\d+$/);

// HR roles sign in with email + TOTP. IT_ADMIN keeps the password break-glass
// login below and is deliberately excluded from the TOTP-only HR flow.
const HR_TOTP_ROLES = ["SUPER_ADMIN", "HR_ADMIN", "HR_RECRUITER"];

const hrUserInclude = {
  roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
  departments: true,
} as const;

function setSessionCookie(res: express.Response, token: string) {
  res.cookie("emc_session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.isProd,
    path: "/",
    maxAge: env.sessionTtlHours * 60 * 60 * 1000,
  });
}

function clearSessionCookie(res: express.Response) {
  res.clearCookie("emc_session", { httpOnly: true, sameSite: "lax", secure: env.isProd, path: "/" });
}

function isExpired(d: Date) {
  return d.getTime() < Date.now();
}

function employeeLinkAvailable(invitation: { expiresAt?: Date | null }) {
  return !invitation.expiresAt || invitation.expiresAt.getTime() > Date.now();
}

/** Once HR has validated the submission, the employee can no longer change anything. */
function employeeSubmissionLocked(invitation: { submissionStatus?: string | null; status?: string | null }) {
  return invitation?.submissionStatus === "VALIDATED" || invitation?.status === "VALIDATED";
}

async function findEmployeeInvitationByToken(token: string) {
  const bySha = await prisma.employeeUpdateInvitation.findUnique({ where: { tokenHash: sha256(token) } });
  if (bySha) return bySha;
  const candidates = await prisma.employeeUpdateInvitation.findMany({ where: { usedAt: null }, take: 1000 });
  for (const invitation of candidates) {
    if (invitation.tokenHash.includes(":") && verifySecret(token, invitation.tokenHash)) {
      await prisma.employeeUpdateInvitation.update({ where: { id: invitation.id }, data: { tokenHash: sha256(token) } }).catch(() => invitation);
      return invitation;
    }
  }
  return null;
}

// How many concurrent sessions a user may hold. Oldest beyond the cap are
// revoked; active tabs are never kicked out by a routine re-login.
const MAX_SESSIONS_PER_USER = 10;

async function createSession(subjectType: "HR" | "CANDIDATE", subjectId: string, req: express.Request) {
  // Read every live session, newest last, so we can trim oldest beyond the cap.
  const existing = await prisma.authSession.findMany({
    where: { subjectType, subjectId, revokedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  const overflow = Math.max(0, existing.length - (MAX_SESSIONS_PER_USER - 1));
  const revokeIds = overflow > 0 ? existing.slice(0, overflow).map((s) => s.id) : [];

  const [session] = await Promise.all([
    prisma.authSession.create({
      data: {
        id: randomToken(),
        subjectType,
        subjectId,
        userId: subjectType === "HR" ? subjectId : undefined,
        candidateId: subjectType === "CANDIDATE" ? subjectId : undefined,
        expiresAt: new Date(Date.now() + env.sessionTtlHours * 60 * 60 * 1000),
        ip: req.ip,
        userAgent: req.get("user-agent") ?? undefined,
      },
    }),
    ...revokeIds.map((sid) => prisma.authSession.update({ where: { id: sid }, data: { revokedAt: new Date() } })),
  ]);
  if (revokeIds.length) invalidateAuthSessions(revokeIds);
  return session;
}

function hasHrTotpRole(user: { roles: Array<{ role: { key: string } }> }): boolean {
  return user.roles.some((r) => HR_TOTP_ROLES.includes(r.role.key));
}

/** Only allow plain http(s) origins for generated setup links. */
export function safeEnrollmentOrigin(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

async function finishLogin(
  req: express.Request,
  res: express.Response,
  user: {
    id: string;
    email: string;
    name: string;
    roles: Array<{ role: { key: string; permissions: Array<{ permission: { key: string } }> } }>;
    departments: Array<{ departmentId: string }>;
  },
  overrides: Array<{ effect: string; permission: { key: string } }>,
  provider: "totp" | "password",
) {
  const session = await createSession("HR", user.id, req);
  const token = signAuthToken({ sub: user.id, type: "HR", sid: session.id });
  await Promise.allSettled([
    prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }),
    logAudit(req, {
      action: "LOGIN",
      entityType: "User",
      entityId: user.id,
      actorId: user.id,
      actorEmail: user.email,
      metadata: { provider },
    }),
    notifyUser(user.id, { type: "auth.login", title: "HR portal sign-in", body: "You signed in to the HR portal." }),
  ]);
  setSessionCookie(res, token);
  const roles = user.roles.map((r) => r.role.key);
  const permissions = effectivePermissions(roles, user.roles, overrides);
  return ok(res, {
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      type: "HR" as const,
      roles,
      permissions,
      departments: user.departments.map((d) => d.departmentId),
    },
  });
}

/** Issues an admin-authorized, short-lived, single-use enrollment link. */
export async function issueTotpEnrollment(
  userId: string,
  createdById?: string | null,
  knownUser?: { name: string; email: string },
  baseUrl?: string | null,
): Promise<{ token: string; link: string; delivered: boolean }> {
  const user = knownUser ?? await prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
  if (!user) throw ApiError.notFound("User not found.");
  const token = randomToken(32);
  const origin = safeEnrollmentOrigin(baseUrl) ?? safeEnrollmentOrigin(env.appUrl) ?? env.appUrl;
  const link = `${origin.replace(/\/+$/, "")}/auth/hr/login?enrollment=${token}`;
  await prisma.totpEnrollment.updateMany({
    where: { userId, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  await prisma.totpEnrollment.create({
    data: {
      userId,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + env.totpEnrollmentTtlMinutes * 60 * 1000),
      createdById: createdById ?? null,
    },
  });
  const result = await sendTemplateEmail({
    to: user.email,
    templateKey: "hr_totp_enrollment",
    data: {
      name: user.name,
      email: user.email,
      link,
      expiresIn: `${env.totpEnrollmentTtlMinutes} minutes`,
    },
    metadata: { userId },
  });
  return { token, link, delivered: result.status === "SENT" };
}

async function registerTotpFailure(req: express.Request, user: { id: string; email: string; failedTotpAttempts: number }) {
  const failed = user.failedTotpAttempts + 1;
  const lock = failed >= env.totpMaxAttempts;
  await prisma.user.update({
    where: { id: user.id },
    data: {
      failedTotpAttempts: lock ? 0 : failed,
      lockedUntil: lock ? new Date(Date.now() + env.totpLockoutMinutes * 60 * 1000) : null,
    },
  });
  await logAudit(req, {
    action: "TOTP_VERIFY_FAILED",
    entityType: "User",
    entityId: user.id,
    actorEmail: user.email,
    metadata: { reason: "invalid_or_replayed" },
  });
  return lock;
}

/**
 * Step 1 of HR sign-in. Checks eligibility using one generic error message so
 * the endpoint cannot be used to enumerate registered accounts.
 */
router.post("/auth/hr/email-check", authRateLimiter, asyncHandler(async (req, res) => {
  const parsed = emailSchema.safeParse(req.body?.email);
  if (!parsed.success) throw ApiError.badRequest("A valid email address is required.");
  const email = parsed.data;

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      email: true,
      isActive: true,
      totpEnabled: true,
      totpSecretEncrypted: true,
      roles: { select: { role: { select: { key: true } } } },
    },
  });
  if (!user || !user.isActive || !hasHrTotpRole(user)) {
    throw ApiError.forbidden("This email is not authorized for HR access.");
  }
  if (!user.totpEnabled || !user.totpSecretEncrypted) {
    return ok(res, {
      status: "ENROLLMENT_REQUIRED",
      email: user.email,
      message: "Authenticator setup is required. Ask your administrator for a setup link.",
    });
  }
  return ok(res, { status: "TOTP_REQUIRED", email: user.email });
}));

/** Step 2: verify a 6-digit RFC 6238 code and create an authenticated session. */
router.post("/auth/hr/totp/verify", totpRateLimiter, asyncHandler(async (req, res) => {
  const body = z.object({ email: emailSchema, code: otpCodeSchema }).safeParse(req.body);
  if (!body.success) throw ApiError.badRequest("Email and a 6-digit authenticator code are required.");
  const { email, code } = body.data;

  const user = await prisma.user.findUnique({ where: { email }, include: hrUserInclude });
  if (!user || !user.isActive || !hasHrTotpRole(user)) {
    throw ApiError.forbidden("This email is not authorized for HR access.");
  }
  if (!user.totpEnabled) {
    throw ApiError.forbidden("Authenticator setup is not complete for this account.");
  }
  if (user.lockedUntil && !isExpired(user.lockedUntil)) {
    throw ApiError.tooMany("Too many incorrect codes. Please try again later.");
  }

  const secret = decryptTotpSecret(user.totpSecretEncrypted);
  if (!secret) throw ApiError.internal("Authenticator configuration is invalid. Contact your administrator.");

  const result = await verifyTotpCode(code, secret, user.totpLastUsedStep == null ? null : Number(user.totpLastUsedStep));
  if (!result.valid || result.step === undefined) {
    const locked = await registerTotpFailure(req, user);
    throw locked
      ? ApiError.tooMany("Too many incorrect codes. Please try again later.")
      : ApiError.unauthorized("Invalid or already used code. Please try again.");
  }

  // Atomic replay guard: concurrent requests with the same code both verify,
  // but only the first transaction may advance the accepted time step.
  const claimed = await prisma.user.updateMany({
    where: {
      id: user.id,
      OR: [
        { totpLastUsedStep: null },
        { totpLastUsedStep: { lt: BigInt(result.step) } },
      ],
    },
    data: { totpLastUsedStep: BigInt(result.step), failedTotpAttempts: 0, lockedUntil: null },
  });
  if (claimed.count === 0) {
    await logAudit(req, { action: "TOTP_REPLAY_REJECTED", entityType: "User", entityId: user.id, actorEmail: user.email });
    throw ApiError.unauthorized("This code has already been used. Wait for the next code.");
  }

  const overrides = await prisma.userPermissionOverride.findMany({
    where: { userId: user.id },
    include: { permission: { select: { key: true } } },
  });
  return finishLogin(req, res, user, overrides, "totp");
}));

/** Shows the QR code / manual key for a valid admin-issued enrollment link. */
router.post("/auth/hr/enrollment/start", totpRateLimiter, asyncHandler(async (req, res) => {
  const body = z.object({ token: z.string().min(20) }).safeParse(req.body);
  if (!body.success) throw ApiError.badRequest("A valid enrollment token is required.");
  const { token } = body.data;

  const enrollment = await prisma.totpEnrollment.findUnique({ where: { tokenHash: sha256(token) } });
  if (!enrollment || enrollment.consumedAt || isExpired(enrollment.expiresAt)) {
    throw ApiError.unauthorized("This setup link is invalid or has expired. Ask your administrator for a new one.");
  }
  const user = await prisma.user.findUnique({ where: { id: enrollment.userId }, include: { roles: { include: { role: true } } } });
  if (!user || !user.isActive || !hasHrTotpRole(user)) {
    throw ApiError.forbidden("This email is not authorized for HR access.");
  }
  if (user.totpEnabled) {
    throw ApiError.conflict("An authenticator is already active for this account.");
  }

  let secret = decryptTotpSecret(user.totpSecretEncrypted);
  if (!secret) {
    secret = generateTotpSecret();
    await prisma.user.update({
      where: { id: user.id },
      data: {
        totpSecretEncrypted: encryptTotpSecret(secret),
        totpEnrollmentPending: true,
        totpLastUsedStep: null,
        failedTotpAttempts: 0,
        lockedUntil: null,
      },
    });
  }
  const uri = buildTotpUri(user.email, secret);
  return ok(res, {
    status: "ENROLLMENT_PENDING",
    email: user.email,
    secret,
    uri,
    qrDataUrl: await qrDataUrl(uri),
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    expiresAt: enrollment.expiresAt,
  });
}));

/** Confirms enrollment with a generated code, activates TOTP and signs in. */
router.post("/auth/hr/enrollment/verify", totpRateLimiter, asyncHandler(async (req, res) => {
  const body = z.object({ token: z.string().min(20), code: otpCodeSchema }).safeParse(req.body);
  if (!body.success) throw ApiError.badRequest("An enrollment token and 6-digit code are required.");
  const { token, code } = body.data;

  const enrollment = await prisma.totpEnrollment.findUnique({ where: { tokenHash: sha256(token) } });
  if (!enrollment || enrollment.consumedAt || isExpired(enrollment.expiresAt)) {
    throw ApiError.unauthorized("This setup link is invalid or has expired. Ask your administrator for a new one.");
  }
  const user = await prisma.user.findUnique({ where: { id: enrollment.userId }, include: hrUserInclude });
  if (!user || !user.isActive || !hasHrTotpRole(user)) {
    throw ApiError.forbidden("This email is not authorized for HR access.");
  }
  if (user.totpEnabled) throw ApiError.conflict("An authenticator is already active for this account.");
  if (user.lockedUntil && !isExpired(user.lockedUntil)) {
    throw ApiError.tooMany("Too many incorrect codes. Please try again later.");
  }

  const secret = decryptTotpSecret(user.totpSecretEncrypted);
  if (!secret) throw ApiError.badRequest("Enrollment has not been started. Please reopen your setup link.");

  const result = await verifyTotpCode(code, secret);
  if (!result.valid || result.step === undefined) {
    const locked = await registerTotpFailure(req, user);
    throw locked
      ? ApiError.tooMany("Too many incorrect codes. Please try again later.")
      : ApiError.unauthorized("That code did not match. Check your authenticator and try again.");
  }

  // Consume the single-use token atomically before enabling TOTP.
  const consumed = await prisma.totpEnrollment.updateMany({
    where: { id: enrollment.id, consumedAt: null, expiresAt: { gt: new Date() } },
    data: { consumedAt: new Date() },
  });
  if (consumed.count === 0) {
    throw ApiError.unauthorized("This setup link has already been used.");
  }
  await prisma.totpEnrollment.updateMany({
    where: { userId: user.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  await prisma.user.update({
    where: { id: user.id },
    data: {
      totpEnabled: true,
      totpEnrollmentPending: false,
      totpEnabledAt: new Date(),
      totpLastUsedStep: BigInt(result.step),
      failedTotpAttempts: 0,
      lockedUntil: null,
    },
  });
  await Promise.allSettled([
    logAudit(req, { action: "TOTP_ENROLLED", entityType: "User", entityId: user.id, actorId: user.id, actorEmail: user.email }),
    notifyUser(user.id, { type: "auth.totp_enrolled", title: "Authenticator activated", body: "TOTP sign-in is now active on your HR account." }),
  ]);

  const overrides = await prisma.userPermissionOverride.findMany({
    where: { userId: user.id },
    include: { permission: { select: { key: true } } },
  });
  return finishLogin(req, res, user, overrides, "totp");
}));

/** Session/logout aliases matching the documented HR auth API surface. */
router.get("/auth/hr/session", optionalAuthenticate, asyncHandler(async (req, res) => {
  if (!req.auth) return ok(res, { user: null });
  return ok(res, {
    user: {
      id: req.auth.subjectId,
      email: req.auth.email,
      name: req.auth.name,
      type: req.auth.type,
      roles: req.auth.roles,
      permissions: req.auth.permissions,
      departments: req.auth.departments,
    },
  });
}));

router.post("/auth/hr/logout", authenticate, asyncHandler(async (req, res) => {
  if (req.auth) {
    await prisma.authSession.updateMany({ where: { id: req.auth.sessionId }, data: { revokedAt: new Date() } });
    clearAuthCache();
    await logAudit(req, { action: "LOGOUT", entityType: "AuthSession", entityId: req.auth.sessionId, actorId: req.auth.subjectId, actorEmail: req.auth.email });
  }
  clearSessionCookie(res);
  return ok(res, { message: "Signed out." });
}));

/**
 * Password based sign-in. Reserved strictly for IT administrators as a
 * break-glass option. All HR roles use email + TOTP only.
 */
router.post("/auth/password/login", authRateLimiter, asyncHandler(async (req, res) => {
  const parsed = z
    .object({ email: emailSchema, password: z.string().min(1) })
    .safeParse(req.body);
  if (!parsed.success) throw ApiError.badRequest("Email and password are required.");
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({
    where: { email },
    include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } }, departments: true },
  });
  if (!user || !user.isActive) throw ApiError.unauthorized("Invalid email or password.");
  if (!user.roles.some((r) => r.role.key === "IT_ADMIN")) {
    throw ApiError.unauthorized("Password sign-in is not available for this account. Use your authenticator app instead.");
  }
  if (!user.passwordHash) throw ApiError.unauthorized("Password sign-in is not enabled for this account.");
  if (!verifyPassword(password, user.passwordHash)) {
    await logAudit(req, { action: "LOGIN_PASSWORD_FAILED", entityType: "User", entityId: user.id, actorEmail: email });
    throw ApiError.unauthorized("Invalid email or password.");
  }

  const overrides = await prisma.userPermissionOverride.findMany({ where: { userId: user.id }, include: { permission: { select: { key: true } } } });

  const session = await createSession("HR", user.id, req);
  const token = signAuthToken({ sub: user.id, type: "HR", sid: session.id });
  await Promise.allSettled([
    prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }),
    logAudit(req, {
      action: "LOGIN_PASSWORD",
      entityType: "User",
      entityId: user.id,
      actorId: user.id,
      actorEmail: user.email,
      metadata: { provider: "password" },
    }),
  ]);

  setSessionCookie(res, token);
  const roles = user.roles.map((r) => r.role.key);
  const permissions = effectivePermissions(roles, user.roles, overrides);
  return ok(res, {
    token,
    user: { id: user.id, email: user.email, name: user.name, type: "HR" as const, roles, permissions, departments: user.departments.map((d) => d.departmentId) },
  });
}));

/** Reports whether password sign-in is available for an email (IT administrators only). Used by the login screen. */
router.post("/auth/password/available", authRateLimiter, asyncHandler(async (req, res) => {
  const parsed = emailSchema.safeParse(req.body.email);
  if (!parsed.success) return ok(res, { available: false });
  const user = await prisma.user.findUnique({
    where: { email: parsed.data },
    select: { passwordHash: true, isActive: true, roles: { select: { role: { select: { key: true } } } } },
  });
  const isItAdmin = user?.roles.some((r) => r.role.key === "IT_ADMIN") ?? false;
  return ok(res, { available: Boolean(user?.passwordHash && user?.isActive && isItAdmin) });
}));

router.post("/auth/me", optionalAuthenticate, asyncHandler(async (req, res) => {
  const auth = req.auth;
  if (!auth) return ok(res, { user: null });
  return ok(res, {
    user: {
      id: auth.subjectId,
      email: auth.email,
      name: auth.name,
      type: auth.type,
      roles: auth.roles,
      permissions: auth.permissions,
      departments: auth.departments,
    },
  });
}));

router.post("/auth/logout", authenticate, asyncHandler(async (req, res) => {
  if (req.auth) {
    await prisma.authSession.updateMany({ where: { id: req.auth.sessionId }, data: { revokedAt: new Date() } });
    clearAuthCache();
    await logAudit(req, { action: "LOGOUT", entityType: "AuthSession", entityId: req.auth.sessionId, actorId: req.auth.subjectId, actorEmail: req.auth.email });
  }
  clearSessionCookie(res);
  return ok(res, { message: "Signed out." });
}));


// ---------- Employee update invitation ----------
const inviteSchema = z.object({ employeeId: z.string().min(1) });

router.post(
  "/employee-invitations",
  authenticate,
  requireAuth("HR"),
  requirePermission("employees.manage"),
  asyncHandler(async (req, res) => {
    const parsed = inviteSchema.safeParse(req.body);
    if (!parsed.success) throw ApiError.badRequest("employeeId is required.");
    const { employeeId } = parsed.data;

    const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
    if (!employee) throw ApiError.notFound("Employee not found.");

    const existing = await prisma.employeeUpdateInvitation.findFirst({
      where: { employeeId, usedAt: null },
      orderBy: { createdAt: "desc" },
    });
    if (existing) {
      throw ApiError.conflict("An active update invitation already exists for this employee.");
    }

    const token = randomToken();
    const expiresAt: Date | null = null;
    const invitation = await prisma.employeeUpdateInvitation.create({
      data: { employeeId, tokenHash: sha256(token), expiresAt, createdById: req.auth!.subjectId },
    });

    const link = `${env.employeeUpdateUrl}?token=${token}`;
    void sendTemplateEmail({
      to: employee.officialEmail,
      templateKey: "employee_update_invitation",
      data: { name: employee.fullName, employeeCode: employee.employeeCode, email: employee.officialEmail, link, expiresAt: null },
      metadata: { invitationId: invitation.id, employeeId },
    });

    await logAudit(req, { action: "EMPLOYEE_INVITE_SEND", entityType: "EmployeeUpdateInvitation", entityId: invitation.id, actorId: req.auth!.subjectId, actorEmail: req.auth!.email });

    return created(res, { invitationId: invitation.id, message: "Update invitation sent to " + employee.officialEmail });
  }),
);

router.get(
  "/auth/employee/invitation/:token",
  asyncHandler(async (req, res) => {
    const { token } = z.object({ token: z.string().min(1) }).parse(req.params);
    const invitation = await findEmployeeInvitationByToken(token);
    if (!invitation || !employeeLinkAvailable(invitation)) throw ApiError.notFound("Invalid or expired invitation link.");
    if (!invitation.openedAt) {
      await prisma.employeeUpdateInvitation.update({
        where: { id: invitation.id },
        data: { openedAt: new Date(), status: invitation.draftUpdatedAt ? "DRAFT" : "OPENED" },
      });
      invitation.openedAt = new Date();
    }
      const employee = await prisma.employee.findUnique({ where: { id: invitation.employeeId } });
      if (!employee) throw ApiError.notFound("Employee record not found.");
      const draft = (invitation.draft ?? null) as Record<string, unknown> | null;
      const submittedFields = ((invitation.submission as { fields?: Record<string, unknown> } | null)?.fields ?? null);
      const submission = invitation.submission as { fileId?: string } | null;
      const saved = draft ?? submittedFields;
      let cv: { fileId: string; fileName: string; size: number } | null = null;
      if (submission?.fileId) {
        const file = await prisma.storedFile.findUnique({ where: { id: submission.fileId } });
        if (file) cv = { fileId: file.id, fileName: file.originalName, size: file.size };
      }
      return ok(res, {
        employee: { id: employee.id, employeeCode: employee.employeeCode, fullName: employee.fullName, officialEmail: employee.officialEmail, mobile: employee.mobile, designationId: employee.designationId, departmentId: employee.departmentId, qualification: employee.qualification, graduationYear: employee.graduationYear, personalEmail: employee.personalEmail, totalExperience: employee.totalExperience, relevantExperience: employee.relevantExperience, previousOrganization: employee.previousOrganization, specialization: employee.specialization, employmentTypeId: employee.employmentTypeId, joiningDate: employee.joiningDate, workLocation: employee.workLocation, additionalInfo: employee.additionalInfo },
        draft: saved,
        source: draft ? "draft" : submittedFields ? "submission" : null,
        cv,
        status: invitation.status,
        rejection: invitation.submissionRejection ?? null,
        locked: employeeSubmissionLocked(invitation),
        fieldReview: (invitation.submission as { fieldReview?: Array<{ key?: string; label: string; note?: string }> } | null)?.fieldReview ?? null,
      });
  }),
);

// Draft autosave for the employee self-service form
const draftFields = z.object({
  fullName: z.string().optional(),
  officialEmail: z.string().optional(),
  personalEmail: z.string().optional().nullable(),
  mobile: z.string().regex(/^\d{10}$/,"Enter a valid 10-digit mobile number.").optional().nullable(),
  departmentId: z.string().optional().nullable(),
  designationId: z.string().optional().nullable(),
  qualification: z.string().optional().nullable(),
  graduationYear: z.coerce.number().optional().nullable(),
  totalExperience: z.coerce.number().int().min(0).max(60).optional().nullable(),
  relevantExperience: z.coerce.number().int().min(0).max(60).optional().nullable(),
  previousOrganization: z.string().optional().nullable(),
  specialization: z.string().optional().nullable(),
  employmentTypeId: z.string().optional().nullable(),
  joiningDate: z.string().optional().nullable(),
  workLocation: z.string().optional().nullable(),
  additionalInfo: z.string().optional().nullable(),
});

router.get(
  "/auth/employee/invitation/:token/draft",
  asyncHandler(async (req, res) => {
    const { token } = z.object({ token: z.string().min(1) }).parse(req.params);
    const invitation = await findEmployeeInvitationByToken(token);
    if (!invitation || !employeeLinkAvailable(invitation)) throw ApiError.notFound("Invalid or expired invitation link.");
    return ok(res, { draft: invitation.draft ?? null, draftUpdatedAt: invitation.draftUpdatedAt });
  }),
);

router.put(
  "/auth/employee/invitation/:token/draft",
  asyncHandler(async (req, res) => {
    const { token } = z.object({ token: z.string().min(1) }).parse(req.params);
    const invitation = await findEmployeeInvitationByToken(token);
    if (!invitation || !employeeLinkAvailable(invitation)) throw ApiError.notFound("Invalid or expired invitation link.");
    if (employeeSubmissionLocked(invitation)) throw ApiError.conflict("Your details have been verified by HR — they can no longer be changed.");
    const fields = draftFields.safeParse(req.body ?? {});
    if (!fields.success) throw ApiError.badRequest("Invalid draft data.", fields.error.flatten());
    await prisma.employeeUpdateInvitation.update({
      where: { id: invitation.id },
      data: { draft: fields.data, draftUpdatedAt: new Date(), status: "DRAFT" },
    });
    return ok(res, { message: "Draft saved.", savedAt: new Date().toISOString() });
  }),
);

  router.get(
    "/auth/employee/invitation/:token/cv",
    asyncHandler(async (req, res) => {
      const { token } = z.object({ token: z.string().min(1) }).parse(req.params);
      const invitation = await findEmployeeInvitationByToken(token);
      if (!invitation || !employeeLinkAvailable(invitation)) throw ApiError.notFound("Invalid or expired invitation link.");
      const submission = invitation.submission as { fileId?: string } | null;
      const fileId = submission?.fileId;
      if (!fileId) throw ApiError.notFound("No CV has been uploaded with this invitation yet.");
      const file = await prisma.storedFile.findUnique({ where: { id: fileId } });
      if (!file || file.ownerType !== "EMPLOYEE" || file.ownerId !== invitation.employeeId) throw ApiError.forbidden("This CV is not linked to the invitation.");
      const buffer = await readStoredFile(file);
      const inline = /^(application\/pdf|image\/(jpeg|png|webp))$/.test(file.mimeType);
      res.setHeader("Content-Type", file.mimeType);
      res.setHeader("Content-Disposition", contentDispositionFilename(file.originalName, inline ? "inline" : "attachment"));
      res.setHeader("Content-Length", String(buffer.length));
      res.setHeader("Cache-Control", "private, no-store");
      return res.send(buffer);
    }),
  );

  const employeeUpdateFields = z.object({
  fullName: z.string().min(2),
  officialEmail: z.string().email(),
  personalEmail: z.string().email(),
  mobile: z.string().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number (starting 6–9)."),
  designationId: z.string().min(1),
  departmentId: z.string().min(1),
  qualification: z.string().min(2),
  graduationYear: z.coerce.number().int().min(1950).max(new Date().getFullYear() + 6),
  totalExperience: z.coerce.number().int().min(0).max(60),
  relevantExperience: z.coerce.number().int().min(0).max(60),
  previousOrganization: z.string().min(1),
  specialization: z.string().min(1),
  employmentTypeId: z.string().min(1),
    joiningDate: z.coerce.date().refine((value) => value.getTime() <= Date.now(), "You have already joined, please update your past joining date not a future joining date."),
  workLocation: z.string().min(1),
  additionalInfo: z.string().min(1),
});

router.post(
  "/auth/employee/invitation/:token/submit",
  upload.single("cv"),
  asyncHandler(async (req, res) => {
    const { token } = z.object({ token: z.string().min(1) }).parse(req.params);
    const invitation = await findEmployeeInvitationByToken(token);
    if (!invitation || !employeeLinkAvailable(invitation)) throw ApiError.notFound("Invalid, used, or expired invitation link.");
    if (employeeSubmissionLocked(invitation)) throw ApiError.conflict("Your details have been verified by HR — they can no longer be changed.");

    const employee = await prisma.employee.findUnique({ where: { id: invitation.employeeId } });
    if (!employee) throw ApiError.notFound("Employee record not found.");
    const existingSubmission = invitation.submission as { fileId?: string } | null;
    const existingFileId = existingSubmission?.fileId;
    if (!req.file && !existingFileId) throw ApiError.badRequest("Please upload your latest CV.");

    const fields = employeeUpdateFields.parse(req.body);

    let fileId = existingFileId;
    if (req.file) {
      const file = await storeFile({
        buffer: req.file.buffer,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        ownerType: "EMPLOYEE",
        ownerId: employee.id,
        bucket: STORAGE_BUCKETS.EMPLOYEES,
        visibility: "PRIVATE",
      });
      fileId = file.id;
    }

    await prisma.employeeUpdateInvitation.update({
      where: { id: invitation.id },
      data: {
        usedAt: new Date(),
        status: "SUBMITTED",
        submissionStatus: "PENDING",
        draft: Prisma.DbNull,
        draftUpdatedAt: null,
        submission: { fields, ...(fileId ? { fileId } : {}), submittedAt: new Date().toISOString() },
      },
    });

    void sendTemplateEmail({
      to: employee.officialEmail,
      templateKey: "employee_update_confirmation",
      data: { name: employee.fullName, employeeCode: employee.employeeCode },
      metadata: { employeeId: employee.id, invitationId: invitation.id },
    });

    await logAudit(req, { action: "EMPLOYEE_UPDATE_SUBMIT", entityType: "EmployeeUpdateInvitation", entityId: invitation.id, actorId: employee.id, actorEmail: employee.officialEmail, metadata: { invitationId: invitation.id, employeeId: employee.id } });

    return ok(res, { message: "Your information has been submitted successfully. Our HR team will verify it before the employee record is updated.", employeeId: employee.id });
  }),
);

export default router;
