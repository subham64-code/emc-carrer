import express from "express";
import fs from "fs";
import path from "path";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiError } from "../utils/ApiError";
import { ok, created, paginated } from "../utils/http";
import { getPagination } from "../utils/pagination";
import { authenticate, requireAuth, requireHr, requirePermission } from "../middleware/auth";
import { authRateLimiter } from "../middleware/rateLimit";
import { logAudit } from "../services/audit.service";
import { cache } from "../services/cache.service";
import { notifyHrTeam, notifyCandidate } from "../services/notification.service";
import { sendTemplateEmail } from "../integrations/email/email.service";
import { readStoredFile, storeFile, STORAGE_BUCKETS } from "../storage/index";
import { env } from "../config/env";
import { OFFER_STATUS, APPLICATION_STATUS } from "../config/constants";
import PDFDocument from "pdfkit";
import { signPurposeToken, verifyPurposeToken } from "../utils/jwt";

const router = express.Router();

const respondSchema = z.object({
  token: z.string().min(1),
  decision: z.enum(["ACCEPTED", "DECLINED"]),
  remarks: z.string().optional().nullable(),
});

router.post(
  "/respond",
  authRateLimiter,
  asyncHandler(async (req, res) => {
    const parsed = respondSchema.safeParse(req.body);
    if (!parsed.success) throw ApiError.badRequest("Invalid input.", parsed.error.flatten());
    const { token, decision, remarks } = parsed.data;
    const decoded = verifyPurposeToken(token, "OFFER_RESPONSE") as unknown as { offerId: string; candidateId: string };
    const offer = await prisma.offerLetter.findUnique({ where: { id: decoded.offerId }, include: { application: { include: { candidate: true, jobOpening: true } } } });
    if (!offer) throw ApiError.notFound("Offer not found.");
    if (offer.application.candidateId !== decoded.candidateId) throw ApiError.forbidden("This offer response link is not valid for your account.");
    if (offer.status === OFFER_STATUS.EXPIRED || offer.status === OFFER_STATUS.WITHDRAWN) throw ApiError.badRequest("This offer is no longer active.");
    const now = new Date();
    if (offer.expiryDate && offer.expiryDate.getTime() < now.getTime()) {
      await prisma.offerLetter.update({ where: { id: offer.id }, data: { status: OFFER_STATUS.EXPIRED } });
      throw ApiError.badRequest("This offer has expired.");
    }
    const target = decision === "ACCEPTED" ? OFFER_STATUS.ACCEPTED : OFFER_STATUS.DECLINED;
    await prisma.offerLetter.update({ where: { id: offer.id }, data: { status: target, respondedAt: now, responseRemarks: remarks } });
    if (decision === "ACCEPTED") {
      await prisma.application.update({ where: { id: offer.applicationId }, data: { status: APPLICATION_STATUS.OFFER_ACCEPTED } });
      await prisma.applicationStatusHistory.create({ data: { applicationId: offer.applicationId, fromStatus: offer.application.status, toStatus: APPLICATION_STATUS.OFFER_ACCEPTED, changedById: null, remarks: "Candidate accepted offer" } });
      // Initialize required documents in a single round trip instead of one
      // upsert per category (the compound unique makes skipDuplicates safe).
      const categories = await prisma.documentCategory.findMany({ where: { isActive: true }, select: { id: true } });
      if (categories.length) {
        await prisma.candidateDocument.createMany({
          data: categories.map((cat) => ({
            candidateId: offer.application.candidateId,
            applicationId: offer.applicationId,
            categoryId: cat.id,
            status: "NOT_UPLOADED",
          })),
          skipDuplicates: true,
        });
      }
      const createdDocs = categories.length;
      await notifyHrTeam({ type: "offer.accepted", title: "Offer accepted", body: `${offer.application.candidate.fullName} accepted the offer for ${offer.designation}.`, entityType: "OfferLetter", entityId: offer.id });

      const uploadToken = signPurposeToken({ applicationId: offer.applicationId, candidateId: offer.application.candidateId }, "DOC_UPLOAD", "7d");
      const uploadLink = `${env.docUploadUrl}?token=${uploadToken}`;
      void sendTemplateEmail({
        to: offer.application.candidate.email,
        templateKey: "document_upload_request",
        data: {
          name: offer.application.candidate.fullName,
          jobTitle: offer.application.jobOpening.title,
          applicationCode: offer.application.applicationCode,
          documentCount: createdDocs,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          link: uploadLink,
        },
        metadata: { applicationId: offer.applicationId, offerId: offer.id },
      });
      await cache.offersChanged();
    } else {
      await prisma.application.update({ where: { id: offer.applicationId }, data: { status: APPLICATION_STATUS.REJECTED, hrRemarks: remarks } });
      await prisma.applicationStatusHistory.create({ data: { applicationId: offer.applicationId, fromStatus: offer.application.status, toStatus: APPLICATION_STATUS.REJECTED, changedById: null, remarks: "Candidate declined offer" } });
      await cache.offersChanged();
    }
    await logAudit(req, { action: "OFFER_RESPOND", entityType: "OfferLetter", entityId: offer.id, actorId: null, actorEmail: offer.application.candidate.email, metadata: { decision, actorType: "CANDIDATE", candidateId: decoded.candidateId, applicationId: offer.applicationId } });
    const responsePayload: Record<string, unknown> = { message: `Offer ${decision.toLowerCase()}.`, decision };
    if (decision === "ACCEPTED") {
      responsePayload.uploadToken = signPurposeToken({ applicationId: offer.applicationId, candidateId: offer.application.candidateId }, "DOC_UPLOAD", "7d");
      responsePayload.uploadLink = `${env.docUploadUrl}?token=${responsePayload.uploadToken}`;
    }
    return ok(res, responsePayload);
  }),
);


router.use(authenticate, requireAuth("HR"), requireHr);

const offerSchema = z.object({
  applicationId: z.string().min(1),
  designation: z.string().min(2),
  departmentId: z.string().min(1).optional().nullable(),
  ctc: z.coerce.number().nonnegative().optional().nullable(),
  salaryStructure: z.string().optional().nullable(),
  joiningDate: z.coerce.date().optional().nullable(),
  workLocation: z.string().optional().nullable(),
  employmentTypeId: z.string().min(1).optional().nullable(),
  expiryDate: z.coerce.date().optional().nullable(),
  additionalConditions: z.string().optional().nullable(),
  status: z.nativeEnum(OFFER_STATUS).optional(),
});

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function ordinalDate(value?: string | Date | null) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });
  const day = date.getDate();
  const suffix = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
  return `${day}${suffix} ${date.toLocaleDateString("en-GB", { month: "long" })} ${date.getFullYear()}`;
}

function appointmentReference(offer: any, issueDate: Date) {
  const suffix = String(offer?.id ?? "HR").replace(/[^a-zA-Z0-9]/g, "").slice(-6).toUpperCase();
  return `EMC/HR/${issueDate.getFullYear()}/${pad2(issueDate.getMonth() + 1)}${pad2(issueDate.getDate())}-${suffix}`;
}

function fullName(candidate: any) {
  return String(candidate?.fullName ?? "Candidate").trim() || "Candidate";
}

/** Honorific from the candidate's gender recorded at application time (Mr./Ms.). */
function honorific(candidate: any): string {
  const extra = parseJson(candidate?.additionalInfo);
  const raw = String(extra?.gender ?? candidate?.gender ?? "").trim().toLowerCase();
  if (raw.startsWith("m")) return "Mr.";
  if (raw.startsWith("f") || raw.startsWith("w")) return "Mrs.";
  return "";
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function candidateAddress(candidate: any): string[] {
  const extra = parseJson(candidate?.additionalInfo);
  const lines: string[] = [];
  const address = String(extra?.currentAddress ?? extra?.address ?? candidate?.currentLocation ?? "").trim();
  if (address) lines.push(address);
  const locality = [extra?.city, extra?.state, extra?.pinCode ?? extra?.pincode, extra?.country]
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .join(", ");
  if (locality) lines.push(locality);
  return lines.length ? lines : ["Address available with HR"];
}

function extractSalaryStructureGrade(candidate: any): string | null {
  const extra = parseJson(candidate?.salaryStructure ?? candidate?.additionalInfo);
  const raw = String(candidate?.salaryStructure ?? extra?.grade ?? candidate?.additionalInfo ?? "");
  const match = raw.match(/grade\s*[:=-]?\s*([A-Z0-9-]+)/i);
  return match?.[1]?.toUpperCase() ?? null;
}

function buildOfferPdf(offer: any, application: any, candidate: any, job: any): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const issueDate = offer?.createdAt && !Number.isNaN(new Date(offer.createdAt).getTime()) ? new Date(offer.createdAt) : new Date();
    const ordinalIssue = ordinalDate(issueDate);
    const reference = appointmentReference(offer, issueDate);
    const name = fullName(candidate);
    const hon = honorific(candidate);
    const addressLines = candidateAddress(candidate);
    const designation = String(offer?.designation ?? job?.title ?? "Designation to be assigned").trim();
    const grade = extractSalaryStructureGrade(offer) ?? "_____";

    const companyLegal = "EcoMetrix Consultants Private Limited";
    const companyAddress = "Unit No.: DCB-119, Idco Info Park, DLF Cyber City, Chandaka Industrial Estate, Patia, Bhubaneswar, Odisha – 751024";
    const companyPhone = "Telephone - +91 674 2973849";
    const companyEmail = "E-mail – ecometrix@outlook.com";
    const companyCin = "CIN - U74200OR2015PTC018759";
    const appointmentOffice = "DCB-120, DLF Cybercity, Idco Infopark, Patia, Bhubaneswar.";

    const logoCandidates = [
      path.resolve(process.cwd(), "frontend", "public", "assets", "ecometrix-logo.png"),
      path.resolve(process.cwd(), "..", "frontend", "public", "assets", "ecometrix-logo.png"),
      path.resolve(process.cwd(), "assets", "ecometrix-logo.png"),
    ];
    const logoPath = logoCandidates.find((candidatePath) => fs.existsSync(candidatePath));

    const doc = new PDFDocument({
      size: "A4",
      margin: 45,
      bufferPages: true,
      info: {
        Title: "Appointment Letter",
        Author: companyLegal,
        Subject: "Appointment letter",
        Creator: "Ecometrix Consultants Private Limited",
      },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const green = "#659616";
    const greenDark = "#4C730D";
    const ink = "#111A30";
    const muted = "#4d5a72";
    const left = 45;
    const right = doc.page.width - 45;
    const bodyWidth = right - left;
    doc.page.margins.bottom = 0;

    const drawFooter = () => {
      const y = doc.page.height - 54;
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(greenDark).text(companyLegal, left, y, { lineBreak: false });
      const nameWidth = doc.widthOfString(companyLegal);
      doc.moveTo(left + nameWidth + 8, y + 5).lineTo(right, y + 5).lineWidth(0.7).strokeColor(green).stroke();
      doc.font("Helvetica").fontSize(6.4).fillColor(ink)
        .text(companyAddress, left, y + 11, { width: bodyWidth, lineBreak: true })
        .text(companyPhone, left, y + 22, { width: bodyWidth })
        .text(companyEmail, left, y + 31, { width: bodyWidth })
        .text(companyCin, left, y + 40, { width: bodyWidth });
    };


    // Letterhead
    if (logoPath) {
      try {
        doc.image(logoPath, left, 34, { width: 82 });
      } catch {
        doc.circle(left + 22, 62, 22).fill(green);
      }
    }

    // Reference and date
    let y = 112;
    doc.font("Helvetica-Bold").fontSize(9).fillColor(greenDark).text("Ref:", left, y, { width: 30 });
    doc.font("Helvetica-Bold").fontSize(9).fillColor(ink).text(reference, left + 34, y, { width: 260 });
    y += 15;
    doc.font("Helvetica-Bold").fontSize(9).fillColor(greenDark).text("Date:", left, y, { width: 34 });
    doc.font("Helvetica").fontSize(9).fillColor(ink).text(ordinalIssue, left + 39, y, { width: 260 });

    // Candidate block
    y = 162;
    doc.font("Helvetica").fontSize(10.2).fillColor(ink).text("To,", left, y);
    y += 14;
    doc.font("Helvetica-Bold").fontSize(10.5).text([hon, name].filter(Boolean).join(" "), left, y);
    for (const line of addressLines) {
      y += 14;
      doc.font("Helvetica").fontSize(9.5).text(line, left, y, { width: bodyWidth });
    }

    // Document title
    y += 32;
    doc.font("Helvetica-Bold").fontSize(15.5).fillColor(ink).text("Appointment Letter", left, y, { width: bodyWidth, align: "center", underline: true });

    // Salutation
    y += 30;
    doc.font("Helvetica").fontSize(10.2).text(`Dear ${[hon, name].filter(Boolean).join(" ")},`, left, y);

    // Candidate and application identifiers
    y += 14;
    doc.font("Helvetica").fontSize(8.6).fillColor(muted).text(`Candidate ID: ${candidate?.candidateCode ?? "—"}   |   Application ID: ${application?.applicationCode ?? "—"}`, left, y, { width: bodyWidth });

    // Introduction
    y += 24;
    doc.text("This has reference to your application and subsequent discussions; we have pleasure in offering you employment in our Organization as:", left, y, { width: bodyWidth, align: "justify" });

    // Employment details
    y = doc.y + 14;
    doc.font("Helvetica-Bold").fontSize(10.2).fillColor(greenDark).text("Designation:", left, y);
    doc.font("Helvetica").fontSize(10.2).fillColor(ink).text(designation, left + 86, y);
    y += 17;
    doc.font("Helvetica-Bold").fontSize(10.2).fillColor(greenDark).text("Grade:", left, y);
    doc.font("Helvetica").fontSize(10.2).fillColor(ink).text(grade, left + 86, y);
    y += 17;
    doc.font("Helvetica-Bold").fontSize(10.2).fillColor(greenDark).text("Eligibility:", left, y);
    doc.font("Helvetica").fontSize(10.2).fillColor(ink).text("Benefits as per Employee Handbook (EHB) specific to the grade.", left + 86, y, { width: bodyWidth - 86 });

    // Terms
    y = doc.y + 24;
    doc.font("Helvetica").fontSize(10).fillColor(ink)
      .text("You are required to agree to the Terms and Conditions as described in Annexure – I.", left, y, { width: bodyWidth })
      .text("You will be paid total compensations as detailed in Annexure – II.", left, doc.y + 10, { width: bodyWidth });

    // Verification clause
    y = doc.y + 16;
    doc.text("Your offer has been made based on the information furnished by you. However, if there is a discrepancy in the copies of documents or certificates given by you as a proof of above, we retain the right to review our offer of employment / appointment.", left, y, { width: bodyWidth, align: "justify" });

    // Joining instructions
    y = doc.y + 22;
    doc.text("Please sign and return duplicate copy of this letter in token of your acceptance.", left, y, { width: bodyWidth });
    doc.text(`You are requested to report at our office at ${appointmentOffice}`, left, doc.y + 13, { width: bodyWidth });

    // Congratulatory message
    y = doc.y + 22;
    doc.text("We congratulate you on being selected for employment with the company and wish you a long and successful career with this Organization. We are confident that your contribution will take us further in our journey towards becoming Industry leaders. We assure you of our support for your professional development and growth.", left, y, { width: bodyWidth, align: "justify" });
    y = doc.y + 14;
    doc.text("Looking forward to our long-term professional relationship.", left, y, { width: bodyWidth });

    // Signature block — digital stamp sits on the left, above the signature line.
    y = doc.y + 28;

    doc.font("Helvetica-Bold").fontSize(10).fillColor(greenDark).text("Faithfully yours,", left, y);
    doc.text(`For ${companyLegal}`, left, y + 17);
    doc.roundedRect(left, y + 38, 160, 44, 6).lineWidth(1.4).strokeColor(green).stroke();
    doc.font("Helvetica-Bold").fontSize(6.6).fillColor(greenDark).text("DIGITALLY SIGNED", left + 8, y + 45, { width: 144, align: "center" });
    doc.font("Helvetica-BoldOblique").fontSize(13.5).fillColor("#14532d").text("EMC Authorised", left + 8, y + 56, { width: 144, align: "center" });
    doc.font("Helvetica").fontSize(6).fillColor(greenDark).text(`Date: ${ordinalIssue}`, left + 8, y + 71, { width: 144, align: "center" });
    doc.moveTo(left, y + 102).lineTo(left + 150, y + 102).lineWidth(0.6).strokeColor(ink).stroke();
    doc.font("Helvetica").fontSize(9).fillColor(ink).text("Authorized Signatory", left, y + 106);
    doc.text("Authorized Signatory Name", left, y + 120);
    doc.text("Authorized Signatory Designation", left, y + 134);
    doc.font("Helvetica-Bold").fontSize(9).fillColor(ink).text("Encl.: As above", left, y + 158);

    const pageCount = (doc as any).bufferedPageCount ?? 1;
    for (let i = 0; i < pageCount; i += 1) {
      doc.switchToPage(i);
      drawFooter();
    }

    doc.end();
  });
}

router.get(
  "/",
  requirePermission("offers.view"),
  asyncHandler(async (req, res) => {
    const { page, pageSize, skip, take, search } = getPagination(req);
    const where: any = {};
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.jobOpeningId) where.application = { jobOpeningId: String(req.query.jobOpeningId) };
    if (search) where.OR = [{ designation: { contains: search, mode: "insensitive" } }];
    const [items, total] = await Promise.all([
      prisma.offerLetter.findMany({
        where, skip, take, orderBy: { createdAt: "desc" },
        include: { application: { include: { candidate: true, jobOpening: true } }, department: true, employmentType: true, pdfFile: true },
      }),
      prisma.offerLetter.count({ where }),
    ]);
    return ok(res, paginated(items, total, page, pageSize));
  }),
);

router.get(
  "/:id",
  requirePermission("offers.view"),
  asyncHandler(async (req, res) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const item = await prisma.offerLetter.findUnique({
      where: { id },
      include: { application: { include: { candidate: true, jobOpening: { include: { department: true } } } }, department: true, employmentType: true, pdfFile: true },
    });
    if (!item) throw ApiError.notFound("Offer letter not found.");
    return ok(res, { item });
  }),
);

router.post(
  "/",
  requirePermission("offers.manage"),
  asyncHandler(async (req, res) => {
    const parsed = offerSchema.safeParse(req.body);
    if (!parsed.success) throw ApiError.badRequest("Invalid input.", parsed.error.flatten());
    const { applicationId } = parsed.data;
    const app = await prisma.application.findUnique({ where: { id: applicationId }, include: { candidate: true, jobOpening: true } });
    if (!app) throw ApiError.notFound("Application not found.");
    if (!app.adminApprovedAt) throw ApiError.badRequest("This candidate has not been approved by the admin yet. The offer letter can only be prepared after admin approval.");
    const existing = await prisma.offerLetter.findUnique({ where: { applicationId } });
    if (existing) throw ApiError.conflict("An offer letter already exists for this application.");
    const data: Record<string, unknown> = { ...parsed.data, status: parsed.data.status ?? OFFER_STATUS.DRAFT, createdById: req.auth!.subjectId };
    if (data.departmentId) {
      const dept = await prisma.department.findUnique({ where: { id: String(data.departmentId) } });
      if (!dept) throw ApiError.badRequest("Invalid department.");
    }
    if (data.employmentTypeId) {
      const et = await prisma.employmentType.findUnique({ where: { id: String(data.employmentTypeId) } });
      if (!et) throw ApiError.badRequest("Invalid employment type.");
    }
    const offer = await prisma.offerLetter.create({ data: data as any, include: { department: true, employmentType: true } });
    await cache.offersChanged();
    await logAudit(req, { action: "OFFER_CREATE", entityType: "OfferLetter", entityId: offer.id, actorId: req.auth!.subjectId, actorEmail: req.auth!.email, metadata: { applicationId } });
    return created(res, { item: offer });
  }),
);

router.patch(
  "/:id",
  requirePermission("offers.manage"),
  asyncHandler(async (req, res) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const parsed = offerSchema.safeParse(req.body);
    if (!parsed.success) throw ApiError.badRequest("Invalid input.", parsed.error.flatten());
    const offer = await prisma.offerLetter.findUnique({ where: { id } });
    if (!offer) throw ApiError.notFound("Offer letter not found.");
    const updated = await prisma.offerLetter.update({ where: { id }, data: { ...parsed.data } as any, include: { department: true, employmentType: true } });
    await cache.offersChanged();
    await logAudit(req, { action: "OFFER_UPDATE", entityType: "OfferLetter", entityId: id, actorId: req.auth!.subjectId, actorEmail: req.auth!.email });
    return ok(res, { item: updated });
  }),
);

router.post(
  "/:id/generate-pdf",
  requirePermission("offers.manage"),
  asyncHandler(async (req, res) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const offer = await prisma.offerLetter.findUnique({
      where: { id },
      include: { application: { include: { candidate: true, jobOpening: true } }, department: true, employmentType: true },
    });
    if (!offer) throw ApiError.notFound("Offer letter not found.");
    const pdf = await buildOfferPdf(offer, offer.application, offer.application.candidate, offer.application.jobOpening);
    const file = await storeFile({ buffer: pdf, originalName: `offer_${offer.application.applicationCode}.pdf`, mimeType: "application/pdf", ownerType: "CANDIDATE", ownerId: offer.application.candidateId, uploadedById: req.auth!.subjectId, bucket: STORAGE_BUCKETS.OFFERS, visibility: "PRIVATE" });
    const updated = await prisma.offerLetter.update({ where: { id }, data: { pdfFileId: file.id } });
    await logAudit(req, { action: "OFFER_PDF_GENERATE", entityType: "OfferLetter", entityId: id, actorId: req.auth!.subjectId, actorEmail: req.auth!.email });
    return ok(res, { item: updated, fileId: file.id });
  }),
);

router.post(
  "/:id/send",
  requirePermission("offers.manage"),
  asyncHandler(async (req, res) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const offer = await prisma.offerLetter.findUnique({
      where: { id },
      include: { application: { include: { candidate: true, jobOpening: true } }, department: true, employmentType: true, pdfFile: true },
    });
    if (!offer) throw ApiError.notFound("Offer letter not found.");
    if (!offer.pdfFileId) throw ApiError.badRequest("Generate the offer letter PDF before sending.");
    const pdfBuffer = await readStoredFile(offer.pdfFile!);
    const respondToken = signPurposeToken({ offerId: offer.id, candidateId: offer.application.candidateId }, "OFFER_RESPONSE", "7d");
    const respondLink = `${env.offerRespondUrl}?token=${respondToken}`;
    void sendTemplateEmail({
      to: offer.application.candidate.email,
      templateKey: "offer_letter",
      data: { name: offer.application.candidate.fullName, jobTitle: offer.application.jobOpening.title, designation: offer.designation, department: offer.department?.name, ctc: offer.ctc, joiningDate: offer.joiningDate, workLocation: offer.workLocation, expiryDate: offer.expiryDate, link: respondLink },
      attachments: [{ filename: "offer_letter.pdf", content: pdfBuffer, contentType: "application/pdf" }],
      metadata: { offerId: offer.id, applicationId: offer.applicationId },
    });
    await prisma.offerLetter.update({ where: { id }, data: { status: OFFER_STATUS.SENT, sentAt: new Date() } });
    if (offer.application.status === APPLICATION_STATUS.SELECTED) {
      await prisma.application.update({ where: { id: offer.applicationId }, data: { status: APPLICATION_STATUS.OFFER_SENT } });
      await prisma.applicationStatusHistory.create({ data: { applicationId: offer.applicationId, fromStatus: APPLICATION_STATUS.SELECTED, toStatus: APPLICATION_STATUS.OFFER_SENT, changedById: req.auth!.subjectId, remarks: "Offer letter sent to the candidate." } });
    }
    await notifyHrTeam({ type: "offer.sent", title: "Offer sent", body: `Offer sent to ${offer.application.candidate.fullName} for ${offer.designation}.`, entityType: "OfferLetter", entityId: id, excludeUserId: req.auth!.subjectId });
    await cache.offersChanged();
    await logAudit(req, { action: "OFFER_SEND", entityType: "OfferLetter", entityId: id, actorId: req.auth!.subjectId, actorEmail: req.auth!.email });
    return ok(res, { message: "Offer sent." });
  }),
);


router.post(
  "/:id/remind",
  requirePermission("offers.manage"),
  asyncHandler(async (req, res) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const offer = await prisma.offerLetter.findUnique({
      where: { id },
      include: { application: { include: { candidate: true, jobOpening: true } }, department: true, employmentType: true },
    });
    if (!offer) throw ApiError.notFound("Offer letter not found.");
    if (![OFFER_STATUS.SENT, OFFER_STATUS.VIEWED].includes(offer.status as any)) {
      throw ApiError.badRequest("Only pending offers can be reminded.");
    }
    const respondToken = signPurposeToken({ offerId: offer.id, candidateId: offer.application.candidateId }, "OFFER_RESPONSE", "7d");
    const respondLink = `${env.offerRespondUrl}?token=${respondToken}`;
    void sendTemplateEmail({
      to: offer.application.candidate.email,
      templateKey: "offer_reminder",
      data: {
        name: offer.application.candidate.fullName,
        jobTitle: offer.application.jobOpening.title,
        designation: offer.designation,
        department: offer.department?.name,
        expiryDate: offer.expiryDate,
        link: respondLink,
      },
      metadata: { offerId: offer.id, applicationId: offer.applicationId, reminder: true },
    });
    await notifyCandidate(offer.application.candidateId, { type: "offer.reminder", title: "Reminder to respond to your offer", body: `Please respond to the offer for ${offer.designation}.`, entityType: "OfferLetter", entityId: offer.id });
    await notifyHrTeam({ type: "offer.reminder_sent", title: "Offer reminder sent", body: `Reminder sent to ${offer.application.candidate.fullName} for ${offer.designation}.`, entityType: "OfferLetter", entityId: id, excludeUserId: req.auth!.subjectId });
    await logAudit(req, { action: "OFFER_REMIND", entityType: "OfferLetter", entityId: id, actorId: req.auth!.subjectId, actorEmail: req.auth!.email, metadata: { candidateId: offer.application.candidateId, applicationId: offer.applicationId } });
    return ok(res, { message: "Reminder email sent to the candidate." });
  }),
);

export default router;

