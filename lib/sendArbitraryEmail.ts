import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { ArbitraryEmailInput } from "@/lib/arbitraryEmail";
import { db } from "@/lib/db";
import {
  getResendSubmissionCredential,
  prepareArbitraryResendRequest,
  sendPreparedEmailViaResend,
} from "@/lib/resend";

export type SendArbitraryEmailResult =
  | { ok: true; id: string; testSend: boolean }
  | { ok: false; error: string };

export async function sendArbitraryEmail(
  input: ArbitraryEmailInput,
): Promise<SendArbitraryEmailResult> {
  const id = randomUUID();
  const idempotencyKey = `arbitrary-email/${id}`;
  const prepared = await prepareArbitraryResendRequest({
    to: input.recipientEmails,
    subject: input.subject,
    html: input.html,
    arbitraryEmailId: id,
    idempotencyKey,
  });
  if (!prepared.ok) return { ok: false, error: prepared.error };

  await db.arbitraryEmail.create({
    data: {
      id,
      recipientEmails: prepared.testSend
        ? input.recipientEmails
        : prepared.request.to,
      subject: input.subject,
      html: input.html,
      utmSource: input.utm.utm_source || null,
      utmMedium: input.utm.utm_medium || null,
      utmCampaign: input.utm.utm_campaign || null,
      utmContent: input.utm.utm_content || null,
      utmTerm: input.utm.utm_term || null,
      status: "sending",
      idempotencyKey,
      providerRequest: prepared.request as unknown as Prisma.InputJsonValue,
      requestHash: prepared.requestHash,
      testSend: prepared.testSend,
    },
  });

  const result = await sendPreparedEmailViaResend(
    prepared.request,
    prepared.requestHash,
    [],
    getResendSubmissionCredential(),
  );
  if (result.providerMessageId) {
    await db.arbitraryEmail.updateMany({
      where: { id, status: "sending" },
      data: {
        status: prepared.testSend ? "test" : "sent",
        providerMessageId: result.providerMessageId,
        sentAt: new Date(),
        error: null,
      },
    });
    return { ok: true, id, testSend: prepared.testSend };
  }

  await db.arbitraryEmail.updateMany({
    where: { id, status: "sending" },
    data: {
      status:
        result.failureDisposition === "uncertain" ||
        result.failureDisposition === "in_flight"
          ? "manual_review"
          : "failed",
      error: result.error ?? "Unable to send email",
    },
  });
  return { ok: false, error: result.error ?? "Unable to send email" };
}
