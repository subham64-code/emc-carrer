import { prisma } from "../lib/prisma";
import { sendTemplateEmail } from "../integrations/email/email.service";
import { signPurposeToken } from "../utils/jwt";
import { env } from "../config/env";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Every hour: offers that have been sent but neither accepted nor declined for
 * 7 days get one automatic reminder email. If there is still no response 7 days
 * after that reminder, the offer expires and the application moves to the Hold
 * pipeline (visible as "Hold" in the Offer Management page).
 */
export function startOfferReminderScheduler() {
  const run = async () => {
    const now = new Date();
    const cutoff = new Date(now.getTime() - SEVEN_DAYS_MS);

    // Step 1 — first automatic reminder, 7 days after the offer was sent.
    const dueForReminder = await prisma.offerLetter.findMany({
      where: { status: { in: ["SENT", "VIEWED"] }, sentAt: { lte: cutoff }, reminderCount: 0 },
      include: { application: { include: { candidate: true, jobOpening: true } } },
      take: 100,
    });
    for (const offer of dueForReminder) {
      const candidate = offer.application.candidate;
      const respondToken = signPurposeToken({ offerId: offer.id, candidateId: candidate.id }, "OFFER_RESPONSE", "7d");
      const link = `${env.offerRespondUrl}?token=${respondToken}`;
      const result = await sendTemplateEmail({
        to: candidate.email,
        templateKey: "offer_reminder",
        data: {
          name: candidate.fullName,
          jobTitle: offer.application.jobOpening.title,
          designation: offer.designation,
          department: undefined,
          expiryDate: offer.expiryDate,
          link,
        },
        metadata: { offerId: offer.id, applicationId: offer.applicationId, reminder: true, automatic: true },
      });
      if (result.status === "SENT" || result.status === "SIMULATED") {
        await prisma.offerLetter.update({ where: { id: offer.id }, data: { reminderCount: 1, lastReminderSentAt: now } });
        await prisma.notification.create({
          data: {
            recipientCandidateId: candidate.id,
            type: "offer.reminder",
            title: "Reminder to respond to your offer",
            body: `Please respond to the offer for ${offer.designation} within 7 days.`,
            entityType: "OfferLetter",
            entityId: offer.id,
          },
        }).catch(() => undefined);
      }
    }

    // Step 2 — no response 7 days after the automatic reminder: hold the application.
    const dueForHold = await prisma.offerLetter.findMany({
      where: { status: { in: ["SENT", "VIEWED"] }, reminderCount: { gte: 1 }, lastReminderSentAt: { lte: cutoff } },
      include: { application: true },
      take: 100,
    });
    for (const offer of dueForHold) {
      await prisma.offerLetter.update({ where: { id: offer.id }, data: { status: "EXPIRED" } });
      const app = offer.application;
      if (app.status === "OFFER_SENT" || app.status === "SELECTED") {
        await prisma.application.update({ where: { id: app.id }, data: { status: "ON_HOLD", hrRemarks: "Offer not accepted within the 7-day response window (after reminder). Moved to hold pipeline." } });
        await prisma.applicationStatusHistory.create({
          data: { applicationId: app.id, fromStatus: app.status, toStatus: "ON_HOLD", changedById: null, remarks: "Offer not accepted within the 7-day response window (after reminder). Moved to hold pipeline." },
        });
      }
    }
  };

  // Run once at startup and then hourly.
  run().catch((error) => console.error("[offer-reminder] initial run failed:", String((error?.message ?? error)).split("\n")[0]));
  const timer = setInterval(() => {
    run().catch((error) => console.error("[offer-reminder] run failed:", String((error?.message ?? error)).split("\n")[0]));
  }, 60 * 60 * 1000);
  timer.unref();
}
