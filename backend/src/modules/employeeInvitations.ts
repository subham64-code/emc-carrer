import express from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiError } from "../utils/ApiError";
import { ok, created } from "../utils/http";
import { authenticate, requireAuth, requireHr, requirePermission } from "../middleware/auth";
import { randomToken, sha256 } from "../utils/crypto";
import { logAudit } from "../services/audit.service";
import { cache } from "../services/cache.service";
import { sendTemplateEmail } from "../integrations/email/email.service";
import { env } from "../config/env";

const router = express.Router();

// Every route in this module is an authenticated HR endpoint. Public employee
// invitation endpoints live in auth.ts, so do not split this module.
router.use(authenticate, requireAuth("HR"), requireHr);

// Keep this list aligned with the employee self-service form so completion
// percentages in the HR console are meaningful.
const REQUIRED_SUBMISSION_FIELDS = [
  "fullName",
  "personalEmail",
  "mobile",
  "departmentId",
  "designationId",
  "qualification",
  "totalExperience",
  "specialization",
  "employmentTypeId",
  "workLocation",
] as const;

const DAY_MS = 86_400_000;

const SCALAR_FIELDS = [
  "fullName","officialEmail","personalEmail","mobile","departmentId","designationId","qualification","graduationYear",
  "previousOrganization","specialization","employmentTypeId","workLocation","additionalInfo","totalExperience","relevantExperience","joiningDate",
] as const;

const FIELD_LABELS: Record<string, string> = {
  fullName: "Full Name",
  officialEmail: "Official Email",
  personalEmail: "Personal Email",
  mobile: "Contact Number",
  departmentId: "Department",
  designationId: "Designation",
  employmentTypeId: "Employment Type",
  joiningDate: "Joining Date",
  workLocation: "Work Location",
  qualification: "Qualification",
  graduationYear: "Passing Year",
  specialization: "Specialization",
  totalExperience: "Total Experience (years)",
  relevantExperience: "Relevant Experience (years)",
  previousOrganization: "Previous Organization",
  additionalInfo: "Additional Information",
};

function scalarEmployeeData(fields: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const key of SCALAR_FIELDS) {
    const value = fields?.[key];
    if (value === undefined || value === null || value === "") continue;
    if (["graduationYear","totalExperience","relevantExperience"].includes(key)) {
      const num = Number(value);
      if (!Number.isNaN(num)) data[key] = num;
      continue;
    }
    if (key === "joiningDate") {
      const date = new Date(String(value));
      if (!Number.isNaN(date.getTime())) data[key] = date;
      continue;
    }
    data[key] = String(value);
  }
  return data;
}

function snapshotEmployee(employee: any): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const key of SCALAR_FIELDS) {
    const value = employee[key];
    if (value instanceof Date) snapshot[key] = value.toISOString();
    else snapshot[key] = value ?? null;
  }
  snapshot.cvFileId = employee.cvFileId ?? null;
  return snapshot;
}

function restoreChangedFields(snapshot: Record<string, unknown>, changedKeys: string[]): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const key of changedKeys) {
    const value = snapshot[key];
    if (value === undefined) continue;
    if (["graduationYear","totalExperience","relevantExperience"].includes(key)) {
      data[key] = value === null ? null : Number(value);
      continue;
    }
    if (key === "joiningDate") {
      data[key] = value === null ? null : new Date(String(value));
      continue;
    }
    data[key] = value === null ? null : String(value);
  }
  return data;
}

type SubmissionFields = Record<string, unknown>;

function fieldsOf(inv: any): SubmissionFields | null {
  const submission = inv?.submission as { fields?: SubmissionFields } | null;
  if (submission?.fields) return submission.fields;
  return (inv?.draft as SubmissionFields | null) ?? null;
}

function completionOf(fields: SubmissionFields | null): number {
  if (!fields) return 0;
  const filled = REQUIRED_SUBMISSION_FIELDS.filter((key) => {
    const value = fields[key];
    if (value === undefined || value === null) return false;
    if (typeof value === "number") return !Number.isNaN(value);
    return String(value).trim().length > 0;
  }).length;
  return Math.round((filled / REQUIRED_SUBMISSION_FIELDS.length) * 100);
}

function derivedStatus(inv: any): string {
  if (inv.submissionStatus === "VALIDATED") return "VALIDATED";
  if (inv.submissionStatus === "REJECTED") return "REJECTED";
  if (inv.usedAt) return "SUBMITTED";
  if (inv.expiresAt && new Date(inv.expiresAt).getTime() < Date.now()) return "EXPIRED";
  if (inv.draftUpdatedAt) return "DRAFT";
  if (inv.openedAt) return "OPENED";
  return "SENT";
}

function present(inv: any) {
  const fields = fieldsOf(inv);
  const completion = completionOf(fields);
  const status = derivedStatus(inv);
  return {
    id: inv.id,
    employeeId: inv.employeeId,
    email: inv.employee?.officialEmail ?? "",
    fullName: inv.employee?.fullName ?? "",
    employeeCode: inv.employee?.employeeCode ?? "",
    status,
    submissionStatus: inv.submissionStatus ?? (inv.usedAt ? "PENDING" : null),
    submissionRejection: inv.submissionRejection ?? null,
    completion,
    initialSentAt: inv.createdAt,
    openedAt: inv.openedAt,
    draftUpdatedAt: inv.draftUpdatedAt,
    completedAt: inv.usedAt,
    expiresAt: inv.expiresAt,
    reminderCount: inv.reminderCount ?? 0,
    lastReminderSentAt: inv.lastReminderSentAt,
    tokenRenewedAt: inv.tokenRenewedAt,
    tokenRenewalCount: inv.tokenRenewalCount ?? 0,
    emailVerified: Boolean(inv.openedAt),
    hasDraft: Boolean(inv.draft),
    reminders: (inv.reminders ?? []).map((r: any) => ({
      id: r.id,
      purpose: r.purpose,
      profileCompletion: r.profileCompletion,
      renewedToken: r.renewedToken,
      sentAt: r.sentAt,
    })),
  };
}

const sendByEmailBody = z.object({ email: z.string().email(), fullName: z.string().trim().max(120).optional().nullable() });

router.post(
  "/employee-invitations/send",
  requirePermission("employees.manage"),
  asyncHandler(async (req, res) => {
    const body = sendByEmailBody.parse(req.body);
    const email = body.email.trim().toLowerCase();
    let employee = await prisma.employee.findUnique({ where: { officialEmail: email } });
    if (!employee) {
      const now = new Date();
      const prefix = `EMC${now.getFullYear()}${String(now.getMonth()+1).padStart(2,"0")}`;
      const existingCodes = await prisma.employee.findMany({ where: { employeeCode: { startsWith: prefix } }, select: { employeeCode: true } });
      const used = new Set<number>();
      for (const row of existingCodes) { const m=/([AJ])(\d+)$/.exec(row.employeeCode.slice(prefix.length)); if (m) used.add(Number.parseInt(m[2],10)); }
      let seq=1; while(used.has(seq)) seq+=1;
      employee = await prisma.employee.create({
        data: {
          employeeCode: `${prefix}J${seq}`,
          fullName: body.fullName?.trim() || email.split("@")[0],
          officialEmail: email,
          status: "EXISTING",
        },
      });
    } else if (body.fullName?.trim() && employee.fullName !== body.fullName.trim()) {
      employee = await prisma.employee.update({ where: { id: employee.id }, data: { fullName: body.fullName.trim() } });
    }
    const existing = await prisma.employeeUpdateInvitation.findFirst({ where: { employeeId: employee.id, usedAt: null }, orderBy: { createdAt: "desc" } });
    if (existing) throw ApiError.conflict("An active invitation already exists for this employee.");
    const token = randomToken();
    const expiresAt: Date | null = null;
    const invitation = await prisma.employeeUpdateInvitation.create({
      data: { employeeId: employee.id, tokenHash: sha256(token), expiresAt, createdById: req.auth!.subjectId },
    });
    const link = `${env.employeeUpdateUrl}?token=${token}`;
    void sendTemplateEmail({
      to: email,
      templateKey: "employee_update_invitation",
      data: { name: employee.fullName, employeeCode: employee.employeeCode, email, link, expiresAt: null },
      metadata: { invitationId: invitation.id, employeeId: employee.id },
    });
    await logAudit(req, { action: "EMPLOYEE_INVITE_SEND", entityType: "EmployeeUpdateInvitation", entityId: invitation.id, actorId: req.auth!.subjectId, actorEmail: req.auth!.email });
    return created(res, { message: `Invitation sent to ${email}.`, link, expiresAt, invitationId: invitation.id });
  }),
);

const listQuery = z.object({
  search: z.string().optional(),
  status: z.string().optional(),
  completion: z.enum(["not_started", "in_progress", "complete"]).optional(),
  date: z.enum(["7", "30", "90"]).optional(),
});

router.get(
  "/employee-invitations",
  requirePermission("employees.view"),
  asyncHandler(async (req, res) => {
    const query = listQuery.parse(req.query);
    const where: any = {};
    if (query.search?.trim()) {
      const term = query.search.trim();
      where.OR = [
        { employee: { fullName: { contains: term, mode: "insensitive" } } },
        { employee: { officialEmail: { contains: term, mode: "insensitive" } } },
        { employee: { employeeCode: { contains: term, mode: "insensitive" } } },
      ];
    }
    if (query.date) {
      where.createdAt = { gte: new Date(Date.now() - Number(query.date) * DAY_MS) };
    }
    const rows = await prisma.employeeUpdateInvitation.findMany({
      where,
      include: { employee: true, reminders: { orderBy: { sentAt: "desc" } } },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    let items = rows.map(present);
    if (query.status) items = items.filter((item) => item.status === query.status);
    if (query.completion === "not_started") items = items.filter((item) => item.completion === 0);
    if (query.completion === "in_progress") items = items.filter((item) => item.completion > 0 && item.completion < 100);
    if (query.completion === "complete") items = items.filter((item) => item.completion === 100);
    return ok(res, { invitations: items });
  }),
);

router.get(
  "/employee-invitations/:id",
  requirePermission("employees.view"),
  asyncHandler(async (req, res) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const inv = await prisma.employeeUpdateInvitation.findUnique({
      where: { id },
      include: { employee: true, reminders: { orderBy: { sentAt: "desc" } } },
    });
    if (!inv) throw ApiError.notFound("Invitation not found.");
    const submission = inv.submission as { fields?: SubmissionFields; fileId?: string; submittedAt?: string } | null;
    return ok(res, { invitation: present(inv), submission: submission ?? null, draft: inv.draft ?? null, current: snapshotEmployee(inv.employee) });
  }),
);

async function issueInvitationLink(req: any, res: any, renew: boolean, sendEmail: boolean) {
  const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
  const inv = await prisma.employeeUpdateInvitation.findUnique({ where: { id }, include: { employee: true } });
  if (!inv) throw ApiError.notFound("Invitation not found.");
  const token = randomToken();
  const expiresAt: Date | null = null;
  await prisma.employeeUpdateInvitation.update({
    where: { id },
    data: {
      tokenHash: sha256(token),
      expiresAt,
      status: "SENT",
      usedAt: renew ? null : inv.usedAt,
      submissionStatus: renew ? null : inv.submissionStatus,
      submissionRejection: renew ? null : inv.submissionRejection,
      tokenRenewedAt: renew ? new Date() : inv.tokenRenewedAt,
      tokenRenewalCount: renew ? (inv.tokenRenewalCount ?? 0) + 1 : inv.tokenRenewalCount,
    },
  });
  const link = `${env.employeeUpdateUrl}?token=${token}`;
  if (sendEmail) {
    void sendTemplateEmail({
      to: inv.employee.officialEmail,
      templateKey: "employee_update_invitation",
      data: { name: inv.employee.fullName, employeeCode: inv.employee.employeeCode, email: inv.employee.officialEmail, link, expiresAt: null },
      metadata: { invitationId: id, employeeId: inv.employeeId },
    });
  }
  await logAudit(req, { action: renew ? "EMPLOYEE_INVITE_RENEW" : sendEmail ? "EMPLOYEE_INVITE_RESEND" : "EMPLOYEE_INVITE_LINK", entityType: "EmployeeUpdateInvitation", entityId: id, actorId: req.auth!.subjectId, actorEmail: req.auth!.email });
  return ok(res, { message: sendEmail ? (renew ? "Invitation renewed and resent." : "Invitation resent.") : "Fresh invitation link generated.", link, expiresAt });
}

router.post(
  "/employee-invitations/:id/link",
  requirePermission("employees.manage"),
  asyncHandler(async (req, res) => issueInvitationLink(req, res, false, false)),
);

router.post(
  "/employee-invitations/:id/resend",
  requirePermission("employees.manage"),
  asyncHandler(async (req, res) => issueInvitationLink(req, res, false, true)),
);

router.post(
  "/employee-invitations/:id/renew",
  requirePermission("employees.manage"),
  asyncHandler(async (req, res) => issueInvitationLink(req, res, true, true)),
);

const remindBody = z.object({ purpose: z.enum(["submit", "reminder"]).default("reminder") });

router.post(
  "/employee-invitations/:id/remind",
  requirePermission("employees.manage"),
  asyncHandler(async (req, res) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const body = remindBody.parse(req.body ?? {});
    const inv = await prisma.employeeUpdateInvitation.findUnique({ where: { id }, include: { employee: true } });
    if (!inv) throw ApiError.notFound("Invitation not found.");
    const fields = fieldsOf(inv);
    const completion = completionOf(fields);
    const token = randomToken();
    const now = new Date();
    await prisma.employeeUpdateInvitation.update({
      where: { id },
      data: { tokenHash: sha256(token), expiresAt: null, status: "SENT", reminderCount: (inv.reminderCount ?? 0) + 1, lastReminderSentAt: now },
    });
    await prisma.employeeInviteReminder.create({
      data: { invitationId: id, purpose: body.purpose, profileCompletion: completion, renewedToken: true, sentAt: now },
    });
    const link = `${env.employeeUpdateUrl}?token=${token}`;
    void sendTemplateEmail({
      to: inv.employee.officialEmail,
      templateKey: "employee_update_reminder",
      data: { name: inv.employee.fullName, employeeCode: inv.employee.employeeCode, email: inv.employee.officialEmail, link, completion, purpose: body.purpose },
      metadata: { invitationId: id, employeeId: inv.employeeId, reminderPurpose: body.purpose, renewedToken: true },
    });
    await logAudit(req, { action: "EMPLOYEE_INVITE_REMIND", entityType: "EmployeeUpdateInvitation", entityId: id, actorId: req.auth!.subjectId, actorEmail: req.auth!.email, metadata: { purpose: body.purpose, completion } });
    return ok(res, { message: "Reminder sent with a fresh invitation link.", profileCompletion: completion, link });
  }),
);

router.delete(
  "/employee-invitations/:id",
  requirePermission("employees.manage"),
  asyncHandler(async (req, res) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const inv = await prisma.employeeUpdateInvitation.findUnique({ where: { id }, include: { employee: true } });
    if (!inv) throw ApiError.notFound("Invitation not found.");
    await prisma.employeeUpdateInvitation.delete({ where: { id } });
    await logAudit(req, {
      action: "EMPLOYEE_INVITE_DELETE",
      entityType: "EmployeeUpdateInvitation",
      entityId: id,
      actorId: req.auth!.subjectId,
      actorEmail: req.auth!.email,
      metadata: { employeeId: inv.employeeId, officialEmail: inv.employee?.officialEmail },
    });
    return ok(res, { message: "Invitation removed." });
  }),
);

router.get(
  "/employee-submissions",
  requirePermission("employees.view"),
  asyncHandler(async (req, res) => {
    const query = z.object({ search: z.string().optional(), status: z.string().optional() }).parse(req.query);
    const where: any = {};
    if (query.status) where.submissionStatus = query.status;
    const rows = await prisma.employeeUpdateInvitation.findMany({
      where,
      include: { employee: true },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    const withSubmission = rows.filter((inv) => inv.usedAt != null || inv.submission != null);
    let items = withSubmission.map((inv: any) => ({
      id: inv.id,
      employeeId: inv.employeeId,
      email: inv.employee?.officialEmail ?? "",
      employeeName: inv.employee?.fullName ?? "",
      employeeCode: inv.employee?.employeeCode ?? "",
      status: inv.submissionStatus ?? "PENDING",
      reason: inv.submissionRejection ?? null,
      submittedAt: (inv.submission as any)?.submittedAt ?? inv.usedAt,
      completion: completionOf(fieldsOf(inv)),
      fields: (inv.submission as any)?.fields ?? null,
      hasCv: Boolean((inv.submission as any)?.fileId),
    }));
    if (query.search?.trim()) {
      const term = query.search.trim().toLowerCase();
      items = items.filter((item) => [item.employeeName, item.email, item.employeeCode].some((value) => String(value ?? "").toLowerCase().includes(term)));
    }
    if (query.status) items = items.filter((item) => item.status === query.status);
    return ok(res, { submissions: items });
  }),
);

const reviewBody = z.object({ reason: z.string().optional().nullable() });

router.post(
  "/employee-submissions/:id/validate",
  requirePermission("employees.manage"),
  asyncHandler(async (req, res) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const inv = await prisma.employeeUpdateInvitation.findUnique({ where: { id }, include: { employee: true } });
    if (!inv) throw ApiError.notFound("Submission not found.");
    if (!inv.usedAt && !inv.submission) throw ApiError.badRequest("This invitation has no submission to validate.");
    const submission = inv.submission as { fields?: SubmissionFields; fileId?: string; submittedAt?: string } | null;
    const fields = submission?.fields ?? {};
    const data = scalarEmployeeData(fields);
    const changedKeys = Object.keys(data);
    const previousEmployee = snapshotEmployee(inv.employee);
    if (data.departmentId) {
      const dept = await prisma.department.findUnique({ where: { id: String(data.departmentId) } });
      if (!dept) throw ApiError.badRequest("Department in the submission no longer exists.");
    }
    if (data.designationId) {
      const des = await prisma.designation.findUnique({ where: { id: String(data.designationId) } });
      if (!des) throw ApiError.badRequest("Designation in the submission no longer exists.");
    }
    if (data.employmentTypeId) {
      const et = await prisma.employmentType.findUnique({ where: { id: String(data.employmentTypeId) } });
      if (!et) throw ApiError.badRequest("Employment type in the submission no longer exists.");
    }
    if (data.officialEmail && data.officialEmail !== inv.employee.officialEmail) {
      const exists = await prisma.employee.findUnique({ where: { officialEmail: String(data.officialEmail) } });
      if (exists) throw ApiError.conflict("Official email is already in use by another employee.");
    }
    const employee = await prisma.employee.update({ where: { id: inv.employeeId }, data: data as any });
    let createdCvVersionId: string | null = null;
    let previousCurrentCvVersionId: string | null = null;
    if (submission?.fileId) {
      const current = await prisma.cvVersion.findFirst({ where: { employeeId: employee.id, isCurrent: true } });
      previousCurrentCvVersionId = current?.id ?? null;
      const count = await prisma.cvVersion.count({ where: { employeeId: employee.id } });
      const created = await prisma.cvVersion.create({
        data: { employeeId: employee.id, fileId: submission.fileId, version: (count || 0) + 1, isCurrent: true, source: "UPLOAD", uploadedById: req.auth!.subjectId },
      });
      createdCvVersionId = created.id;
      if (current) await prisma.cvVersion.update({ where: { id: current.id }, data: { isCurrent: false } });
      await prisma.employee.update({ where: { id: employee.id }, data: { cvFileId: submission.fileId } });
    }
    const updatedSubmission = {
      ...(submission ?? { fields, submittedAt: new Date().toISOString() }),
      ...(submission ?? {}),
      previousEmployee,
      changedKeys,
      previousCurrentCvVersionId,
      createdCvVersionId,
      validatedAt: new Date().toISOString(),
    };
    await prisma.employeeUpdateInvitation.update({
      where: { id },
      data: { submissionStatus: "VALIDATED", reviewedAt: new Date(), reviewedById: req.auth!.subjectId, status: "VALIDATED", submission: updatedSubmission as any },
    });
    await cache.peopleChanged();
    await logAudit(req, { action: "EMPLOYEE_SUBMISSION_VALIDATE", entityType: "EmployeeUpdateInvitation", entityId: id, actorId: req.auth!.subjectId, actorEmail: req.auth!.email, metadata: { employeeId: employee.id } });
    return ok(res, { message: "Submission validated and employee record updated.", employeeId: employee.id });
  }),
);

router.post(
  "/employee-submissions/:id/unvalidate",
  requirePermission("employees.manage"),
  asyncHandler(async (req, res) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const inv = await prisma.employeeUpdateInvitation.findUnique({ where: { id }, include: { employee: true } });
    if (!inv) throw ApiError.notFound("Submission not found.");
    if (!inv.usedAt && !inv.submission) throw ApiError.badRequest("This invitation has no submission to unvalidate.");
    const isValidated = inv.submissionStatus === "VALIDATED" || inv.status === "VALIDATED";
    if (!isValidated) throw ApiError.badRequest("This submission is not currently validated.");
    const submission = inv.submission as {
      fields?: SubmissionFields;
      fileId?: string;
      submittedAt?: string;
      previousEmployee?: Record<string, unknown> | null;
      changedKeys?: string[];
      previousCurrentCvVersionId?: string | null;
      createdCvVersionId?: string | null;
    } | null;
    const snapshot = submission?.previousEmployee ?? null;
    const changedKeys = Array.isArray(submission?.changedKeys) ? submission!.changedKeys! : [];
    if (snapshot) {
      const restore = restoreChangedFields(snapshot, changedKeys);
      if (Object.keys(restore).length > 0) {
        await prisma.employee.update({ where: { id: inv.employeeId }, data: restore as any });
      }
      if ("cvFileId" in snapshot) {
        await prisma.employee.update({ where: { id: inv.employeeId }, data: { cvFileId: (snapshot.cvFileId as string | null) ?? null } });
      }
    }
    const createdCvVersionId = submission?.createdCvVersionId ?? null;
    if (createdCvVersionId) {
      await prisma.cvVersion.delete({ where: { id: createdCvVersionId } }).catch(() => {});
    }
    const previousCurrentCvVersionId = submission?.previousCurrentCvVersionId ?? null;
    if (previousCurrentCvVersionId) {
      await prisma.cvVersion.update({ where: { id: previousCurrentCvVersionId }, data: { isCurrent: true } }).catch(() => {});
    }
    const retainedSubmission = {
      ...(submission ?? {}),
      unvalidatedAt: new Date().toISOString(),
      unvalidatedById: req.auth!.subjectId,
    };
    await prisma.employeeUpdateInvitation.update({
      where: { id },
      data: { submissionStatus: "PENDING", reviewedAt: null, reviewedById: null, status: "SUBMITTED", submission: retainedSubmission as any },
    });
    await cache.peopleChanged();
    await logAudit(req, { action: "EMPLOYEE_SUBMISSION_UNVALIDATE", entityType: "EmployeeUpdateInvitation", entityId: id, actorId: req.auth!.subjectId, actorEmail: req.auth!.email, metadata: { employeeId: inv.employeeId, revertedFields: changedKeys } });
    return ok(res, { message: "Validation removed. The submission is back in the validation queue and the previous employee record has been restored.", employeeId: inv.employeeId });
  }),
);

router.post(
  "/employee-submissions/:id/reject",
  requirePermission("employees.manage"),
  asyncHandler(async (req, res) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const body = reviewBody.parse(req.body ?? {});
    const inv = await prisma.employeeUpdateInvitation.findUnique({ where: { id }, include: { employee: true } });
    if (!inv) throw ApiError.notFound("Submission not found.");
    if (!inv.usedAt && !inv.submission) throw ApiError.badRequest("This invitation has no submission to reject.");
    await prisma.employeeUpdateInvitation.update({
      where: { id },
      data: {
        submissionStatus: "REJECTED",
        submissionRejection: body.reason ?? null,
        reviewedAt: new Date(),
        reviewedById: req.auth!.subjectId,
        status: "REJECTED",
        usedAt: null,
      },
    });
    await logAudit(req, { action: "EMPLOYEE_SUBMISSION_REJECT", entityType: "EmployeeUpdateInvitation", entityId: id, actorId: req.auth!.subjectId, actorEmail: req.auth!.email, metadata: { reason: body.reason } });
    return ok(res, { message: "Submission rejected. The employee can resubmit with the same invitation link." });
  }),
);

const requestChangesBody = z.object({
  notes: z.array(z.object({ key: z.string().min(1).max(60), note: z.string().trim().max(500).optional().nullable() })).min(1).max(50),
  message: z.string().trim().max(1000).optional().nullable(),
});

router.post(
  "/employee-submissions/:id/request-changes",
  requirePermission("employees.manage"),
  asyncHandler(async (req, res) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const body = requestChangesBody.parse(req.body);
    const inv = await prisma.employeeUpdateInvitation.findUnique({ where: { id }, include: { employee: true } });
    if (!inv) throw ApiError.notFound("Submission not found.");
    if (!inv.usedAt && !inv.submission) throw ApiError.badRequest("This invitation has no submission to review.");
    const items = body.notes.map((note) => ({ key: note.key, label: FIELD_LABELS[note.key] ?? note.key, note: (note.note ?? "").trim() }));
    const intro = body.message?.trim() ? `${body.message.trim()}\n` : "";
    const rejectionText = intro + items.map((item) => (item.note ? `${item.label}: ${item.note}` : item.label)).join("\n");
    const token = randomToken();
    const previousSubmission = (inv.submission ?? {}) as Record<string, unknown>;
    const updatedSubmission = { ...previousSubmission, fieldReview: items, changesRequestedAt: new Date().toISOString(), changesRequestedById: req.auth!.subjectId };
    await prisma.employeeUpdateInvitation.update({
      where: { id },
      data: {
        submissionStatus: "REJECTED",
        submissionRejection: rejectionText,
        reviewedAt: new Date(),
        reviewedById: req.auth!.subjectId,
        status: "REJECTED",
        usedAt: null,
        tokenHash: sha256(token),
        expiresAt: null,
        submission: updatedSubmission as any,
      },
    });
    const link = `${env.employeeUpdateUrl}?token=${token}`;
    void sendTemplateEmail({
      to: inv.employee.officialEmail,
      templateKey: "employee_update_changes_requested",
      data: {
        name: inv.employee.fullName,
        employeeCode: inv.employee.employeeCode,
        email: inv.employee.officialEmail,
        link,
        notes: items,
        message: body.message?.trim() ?? "",
      },
      metadata: { invitationId: id, employeeId: inv.employeeId, reminderPurpose: "changes_requested", renewedToken: true },
    });
    await logAudit(req, { action: "EMPLOYEE_SUBMISSION_REQUEST_CHANGES", entityType: "EmployeeUpdateInvitation", entityId: id, actorId: req.auth!.subjectId, actorEmail: req.auth!.email, metadata: { employeeId: inv.employeeId, notes: items } });
    return ok(res, { message: "Correction request sent to the employee with a fresh link.", link });
  }),
);

export default router;
