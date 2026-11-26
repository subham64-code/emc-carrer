import express from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiError } from "../utils/ApiError";
import { ok, created, paginated } from "../utils/http";
import { getPagination } from "../utils/pagination";
import { authenticate, requireAuth, requireHr, requirePermission } from "../middleware/auth";
import { signPurposeToken, verifyPurposeToken } from "../utils/jwt";
import { logAudit } from "../services/audit.service";
import { cache } from "../services/cache.service";
import { notifyHrTeam, notifyCandidate } from "../services/notification.service";
import { sendTemplateEmail } from "../integrations/email/email.service";
import { upload } from "../middleware/upload";
import { storeFile, STORAGE_BUCKETS } from "../storage/index";
import { env } from "../config/env";
import { DOCUMENT_STATUS } from "../config/constants";

const router = express.Router();

// ---------- Public candidate document portal (DOC_UPLOAD token) ----------
router.get(
  "/portal/:token",
  asyncHandler(async (req, res) => {
    const { token } = z.object({ token: z.string().min(1) }).parse(req.params);
    const decoded = verifyPurposeToken(token, "DOC_UPLOAD") as unknown as { applicationId: string; candidateId: string };
    const application = await prisma.application.findUnique({
      where: { id: decoded.applicationId },
      include: { candidate: true, jobOpening: { select: { title: true, department: { select: { name: true } } } } },
    });
    if (!application || application.candidateId !== decoded.candidateId) {
      throw ApiError.notFound("Application not found for this link.");
    }
    const documents = await prisma.candidateDocument.findMany({
      where: { applicationId: decoded.applicationId },
      include: { category: true, file: true },
      orderBy: { category: { sortOrder: "asc" } },
    });
    return ok(res, {
      application: {
        id: application.id,
        applicationCode: application.applicationCode,
        jobTitle: application.jobOpening.title,
        department: application.jobOpening.department?.name ?? null,
        candidateName: application.candidate.fullName,
        candidateEmail: application.candidate.email,
      },
      documents,
    });
  }),
);

router.post(
  "/upload/:token",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const { token } = z.object({ token: z.string().min(1) }).parse(req.params);
    if (!req.file) throw ApiError.badRequest("File is required.");
    const body = z.object({ categoryId: z.string().min(1) }).safeParse(req.body);
    if (!body.success) throw ApiError.badRequest("categoryId is required.", body.error.flatten());
    const { categoryId } = body.data;

    const decoded = verifyPurposeToken(token, "DOC_UPLOAD") as unknown as { applicationId: string; candidateId: string };
    const document = await prisma.candidateDocument.findFirst({ where: { applicationId: decoded.applicationId, categoryId, candidateId: decoded.candidateId } });
    if (!document) throw ApiError.notFound("Document requirement not found for this application.");

    const file = await storeFile({ buffer: req.file.buffer, originalName: req.file.originalname, mimeType: req.file.mimetype, ownerType: "CANDIDATE", ownerId: decoded.candidateId, bucket: STORAGE_BUCKETS.ONBOARDING, visibility: "PRIVATE" });
    const updated = await prisma.candidateDocument.update({
      where: { id: document.id },
      data: { fileId: file.id, status: DOCUMENT_STATUS.UPLOADED, uploadedAt: new Date() },
      include: { category: true },
    });
    await prisma.documentVerificationHistory.create({ data: { documentId: document.id, fromStatus: document.status, toStatus: DOCUMENT_STATUS.UPLOADED, changedById: null, remarks: "Candidate uploaded document" } });
    await logAudit(req, { action: "DOCUMENT_UPLOAD", entityType: "CandidateDocument", entityId: document.id, actorId: null, actorEmail: (await prisma.candidate.findUnique({ where: { id: decoded.candidateId } }))?.email, metadata: { category: updated.category.name, actorType: "CANDIDATE", candidateId: decoded.candidateId, applicationId: decoded.applicationId } });
    await notifyHrTeam({ type: "document.uploaded", title: "Document uploaded", body: `A document (${updated.category.name}) was uploaded for application ${decoded.applicationId}.`, entityType: "CandidateDocument", entityId: document.id });
    return ok(res, { message: "Document uploaded.", document: updated });
  }),
);

// ---------- HR management (requires HR session) ----------
router.use(authenticate, requireAuth("HR"), requireHr);

router.get(
  "/categories",
  requirePermission("documents.view"),
  asyncHandler(async (_req, res) => {
    const categories = await prisma.documentCategory.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } });
    return ok(res, { categories });
  }),
);

const categorySchema = z.object({ name: z.string().min(2).max(120), isRequired: z.boolean().optional(), isActive: z.boolean().optional(), sortOrder: z.coerce.number().int().optional() });

router.post(
  "/categories",
  requirePermission("documents.manage"),
  asyncHandler(async (req, res) => {
    const parsed = categorySchema.safeParse(req.body);
    if (!parsed.success) throw ApiError.badRequest("Invalid input.", parsed.error.flatten());
    const { name, isRequired = false, isActive = true, sortOrder = 0 } = parsed.data;
    const exists = await prisma.documentCategory.findUnique({ where: { name } });
    if (exists) throw ApiError.conflict("Document category already exists.");
    const item = await prisma.documentCategory.create({ data: { name, isRequired, isActive, sortOrder } });
    await logAudit(req, { action: "DOC_CATEGORY_CREATE", entityType: "DocumentCategory", entityId: item.id, actorId: req.auth!.subjectId, actorEmail: req.auth!.email });
    return created(res, { item });
  }),
);

router.patch(
  "/categories/:id",
  requirePermission("documents.manage"),
  asyncHandler(async (req, res) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const parsed = categorySchema.safeParse(req.body);
    if (!parsed.success) throw ApiError.badRequest("Invalid input.", parsed.error.flatten());
    const item = await prisma.documentCategory.findUnique({ where: { id } });
    if (!item) throw ApiError.notFound("Category not found.");
    const updated = await prisma.documentCategory.update({ where: { id }, data: { name: parsed.data.name, isRequired: parsed.data.isRequired, isActive: parsed.data.isActive, sortOrder: parsed.data.sortOrder } });
    await logAudit(req, { action: "DOC_CATEGORY_UPDATE", entityType: "DocumentCategory", entityId: id, actorId: req.auth!.subjectId, actorEmail: req.auth!.email });
    return ok(res, { item: updated });
  }),
);

router.get(
  "/",
  requirePermission("documents.view"),
  asyncHandler(async (req, res) => {
    const { page, pageSize, skip, take, search } = getPagination(req);
    const where: any = {};
    if (req.query.applicationId) where.applicationId = String(req.query.applicationId);
    if (req.query.candidateId) where.candidateId = String(req.query.candidateId);
    if (req.query.categoryId) where.categoryId = String(req.query.categoryId);
    if (req.query.status) where.status = String(req.query.status);
    if (search) where.OR = [{ category: { name: { contains: search, mode: "insensitive" } } }];
    const [items, total] = await Promise.all([
      prisma.candidateDocument.findMany({
        where, skip, take, orderBy: { updatedAt: "desc" },
        include: { category: true, file: true, application: { include: { candidate: true } } },
      }),
      prisma.candidateDocument.count({ where }),
    ]);
    return ok(res, paginated(items, total, page, pageSize));
  }),
);

router.get("/pending", requirePermission("documents.view"), asyncHandler(async (_req, res) => {
  const items = await prisma.candidateDocument.findMany({
    where: { status: { not: "ACCEPTED" } },
    orderBy: { updatedAt: "asc" },
    include: { category: true, application: { include: { candidate: true, jobOpening: true } } },
    take: 100,
  });
  return ok(res, { items });
}));

router.get(
  "/:id",
  requirePermission("documents.view"),
  asyncHandler(async (req, res) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const item = await prisma.candidateDocument.findUnique({ where: { id }, include: { category: true, file: true, application: { include: { candidate: true } }, history: { include: { changedBy: { select: { id: true, name: true, email: true } } }, orderBy: { createdAt: "desc" } } } });
    if (!item) throw ApiError.notFound("Document not found.");
    return ok(res, { item });
  }),
);

const verifySchema = z.object({ status: z.enum(["ACCEPTED","REJECTED","REUPLOAD_REQUIRED"]), remarks: z.string().optional().nullable() });

router.post(
  "/:id/verify",
  requirePermission("documents.manage"),
  asyncHandler(async (req, res) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) throw ApiError.badRequest("Invalid input.", parsed.error.flatten());
    const { status, remarks } = parsed.data;
    const document = await prisma.candidateDocument.findUnique({ where: { id }, include: { category: true, application: { include: { candidate: true } } } });
    if (!document) throw ApiError.notFound("Document not found.");
    const prev = document.status;
    const updated = await prisma.candidateDocument.update({ where: { id }, data: { status, remarks, verifiedAt: new Date(), verifiedById: req.auth!.subjectId } });
    await prisma.documentVerificationHistory.create({ data: { documentId: id, fromStatus: prev, toStatus: status, changedById: req.auth!.subjectId, remarks } });
    await cache.offersChanged();
    await logAudit(req, { action: "DOCUMENT_VERIFY", entityType: "CandidateDocument", entityId: id, actorId: req.auth!.subjectId, actorEmail: req.auth!.email, metadata: { from: prev, to: status, remarks } });

    const candidateEmail = document.application.candidate.email;
    const candidateName = document.application.candidate.fullName;
    const docName = document.category.name;
    const link = `${env.docUploadUrl}?token=${signPurposeToken({ applicationId: document.applicationId, candidateId: document.candidateId }, "DOC_UPLOAD", "7d")}`;
    if (status === DOCUMENT_STATUS.ACCEPTED) {
      void sendTemplateEmail({ to: candidateEmail, templateKey: "document_accepted", data: { name: candidateName, documentName: docName, link } });
      await notifyCandidate(document.application.candidateId, { type: "document.accepted", title: "Document accepted", body: `${docName} has been accepted.`, entityType: "CandidateDocument", entityId: id });
    } else if (status === DOCUMENT_STATUS.REJECTED) {
      void sendTemplateEmail({ to: candidateEmail, templateKey: "document_rejected", data: { name: candidateName, documentName: docName, remarks, link } });
      await notifyCandidate(document.application.candidateId, { type: "document.rejected", title: "Document rejected", body: `${docName} was rejected. ${remarks ?? ""}`, entityType: "CandidateDocument", entityId: id });
    } else {
      void sendTemplateEmail({ to: candidateEmail, templateKey: "document_reupload_request", data: { name: candidateName, documentName: docName, remarks, link } });
      await notifyCandidate(document.application.candidateId, { type: "document.reupload", title: "Re-upload required", body: `${docName} needs to be re-uploaded. ${remarks ?? ""}`, entityType: "CandidateDocument", entityId: id });
    }
    await notifyHrTeam({ type: "document.verified", title: "Document verified", body: `${docName} marked ${status} for ${candidateName}.`, entityType: "CandidateDocument", entityId: id, excludeUserId: req.auth!.subjectId });
    return ok(res, { item: updated });
  }),
);

router.post(
  "/:id/remind",
  requirePermission("documents.manage"),
  asyncHandler(async (req, res) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const document = await prisma.candidateDocument.findUnique({ where: { id }, include: { category: true, application: { include: { candidate: true } } } });
    if (!document) throw ApiError.notFound("Document not found.");
    const link = `${env.docUploadUrl}?token=${signPurposeToken({ applicationId: document.applicationId, candidateId: document.candidateId }, "DOC_UPLOAD", "7d")}`;
    void sendTemplateEmail({ to: document.application.candidate.email, templateKey: "pending_document_reminder", data: { name: document.application.candidate.fullName, pendingDocuments: document.category.name, applicationCode: document.application.applicationCode, link } });
    await logAudit(req, { action: "DOCUMENT_REMIND", entityType: "CandidateDocument", entityId: id, actorId: req.auth!.subjectId, actorEmail: req.auth!.email });
    return ok(res, { message: "Reminder sent." });
  }),
);

export default router;
