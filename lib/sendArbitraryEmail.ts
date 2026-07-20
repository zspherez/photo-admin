import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  ARBITRARY_EMAIL_UTM_KEYS,
  type ArbitraryEmailInput,
} from "@/lib/arbitraryEmail";
import { normalizeArbitraryEmailContent } from "@/lib/arbitraryEmailContent";
import { db } from "@/lib/db";
import { acquireOutreachRecipientPolicyLocks } from "@/lib/outreachPolicyLocks";
import {
  buildArbitraryResendDeliveryPolicy,
  compareResendRequestToPolicy,
  getResendConfigurationError,
  getResendDeliverySettingsSnapshot,
  getResendSubmissionCredential,
  hashResendRequestSnapshot,
  normalizeEmails,
  parseResendRequestSnapshot,
  prepareArbitraryResendRequest,
  sendPreparedEmailViaResend,
  type ResendDeliverySettingsSnapshot,
  type SendResult,
} from "@/lib/resend";
import { OUTREACH_PROVIDER_TRANSACTION_TIMEOUT_MS } from "@/lib/schedule";

export type SendArbitraryEmailResult =
  | { ok: true; id: string; testSend: boolean }
  | { ok: false; error: string };

type ArbitraryEmailDatabase = Pick<typeof db, "arbitraryEmail" | "$transaction">;

export interface SendArbitraryEmailDependencies {
  database: ArbitraryEmailDatabase;
  createId: () => string;
  now: () => Date;
  prepare: typeof prepareArbitraryResendRequest;
  getDeliverySettings: (
    tx: Prisma.TransactionClient,
  ) => Promise<ResendDeliverySettingsSnapshot>;
  acquireRecipientLocks: typeof acquireOutreachRecipientPolicyLocks;
  submit: (
    request: Parameters<typeof sendPreparedEmailViaResend>[0],
    expectedHash: string,
    attachmentBlobs: [],
    credential: ReturnType<typeof getResendSubmissionCredential>,
  ) => Promise<SendResult>;
}

const DEFAULT_DEPENDENCIES: SendArbitraryEmailDependencies = {
  database: db,
  createId: randomUUID,
  now: () => new Date(),
  prepare: prepareArbitraryResendRequest,
  getDeliverySettings: (tx) => getResendDeliverySettingsSnapshot(tx),
  acquireRecipientLocks: acquireOutreachRecipientPolicyLocks,
  submit: sendPreparedEmailViaResend,
};

function sendFailureStatus(result: SendResult): "failed" | "manual_review" {
  return result.failureDisposition === "uncertain" ||
    result.failureDisposition === "in_flight"
    ? "manual_review"
    : "failed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRetryableTransactionError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    ["P2002", "P2028", "P2034"].includes(error.code)
  );
}

async function persistTransactionFailure(
  database: ArbitraryEmailDatabase,
  id: string,
  providerSubmissionStarted: boolean,
  error: unknown,
): Promise<string> {
  const detail = errorMessage(error);
  const message = providerSubmissionStarted
    ? `Provider submission outcome is uncertain: ${detail}`
    : `Email was not submitted: ${detail}`;
  await database.arbitraryEmail.updateMany({
    where: { id, status: "sending" },
    data: {
      status: providerSubmissionStarted ? "manual_review" : "failed",
      error: message,
    },
  });
  return message;
}

export async function sendArbitraryEmailWithDependencies(
  input: ArbitraryEmailInput,
  dependencies: SendArbitraryEmailDependencies,
): Promise<SendArbitraryEmailResult> {
  const content = normalizeArbitraryEmailContent(
    input.html,
    ARBITRARY_EMAIL_UTM_KEYS.map((key) => [key, input.utm[key]]),
  );
  if (!content.ok) return content;

  const id = dependencies.createId();
  const idempotencyKey = `arbitrary-email/${id}`;
  const prepared = await dependencies.prepare({
    to: input.recipientEmails,
    subject: input.subject,
    html: content.content.html,
    text: content.content.text,
    arbitraryEmailId: id,
    idempotencyKey,
  });
  if (!prepared.ok) return { ok: false, error: prepared.error };
  if (
    prepared.request.html !== content.content.html ||
    prepared.request.text !== content.content.text
  ) {
    return {
      ok: false,
      error: "Prepared Resend request changed the canonical email content",
    };
  }

  await dependencies.database.arbitraryEmail.create({
    data: {
      id,
      recipientEmails: prepared.intendedRecipients,
      subject: input.subject,
      html: prepared.request.html,
      text: prepared.request.text,
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

  for (let transactionAttempt = 0; transactionAttempt < 4; transactionAttempt += 1) {
    let providerSubmissionStarted = false;
    try {
      return await dependencies.database.$transaction(
      async (tx): Promise<SendArbitraryEmailResult> => {
        await tx.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`
            SELECT "id"
            FROM "ArbitraryEmail"
            WHERE "id" = ${id}
            FOR UPDATE
          `,
        );
        const stored = await tx.arbitraryEmail.findUnique({ where: { id } });
        if (!stored || stored.status !== "sending") {
          return {
            ok: false,
            error: "Arbitrary email changed before provider submission",
          };
        }

        const request = parseResendRequestSnapshot(stored.providerRequest);
        if (
          !request ||
          hashResendRequestSnapshot(request) !== stored.requestHash ||
          request.idempotencyKey !== stored.idempotencyKey
        ) {
          const error =
            "Stored Resend request failed its identity or integrity check";
          await tx.arbitraryEmail.update({
            where: { id },
            data: { status: "failed", error },
          });
          return { ok: false, error };
        }

        const deliverySettings = await dependencies.getDeliverySettings(tx);
        const policyEmails = normalizeEmails([
          ...stored.recipientEmails,
          ...deliverySettings.bccEmails,
          ...(deliverySettings.testOverride
            ? [deliverySettings.testOverride]
            : []),
          ...(deliverySettings.from ? [deliverySettings.from] : []),
          ...request.to,
          ...request.cc,
          ...request.bcc,
          ...request.replyTo,
        ]);
        await dependencies.acquireRecipientLocks(tx, policyEmails);
        const suppressions =
          policyEmails.length === 0
            ? []
            : await tx.emailSuppression.findMany({
                where: { normalizedEmail: { in: policyEmails } },
                select: { normalizedEmail: true },
              });
        const currentPolicy = buildArbitraryResendDeliveryPolicy({
          from: deliverySettings.from,
          intendedRecipients: stored.recipientEmails,
          subject: stored.subject,
          testOverride: deliverySettings.testOverride,
          bccEmails: deliverySettings.bccEmails,
          suppressedEmails: suppressions.map(
            (suppression) => suppression.normalizedEmail,
          ),
        });
        const configurationError = getResendConfigurationError(
          deliverySettings.apiKey,
          deliverySettings.from,
        );
        const policyError = !currentPolicy.ok
          ? currentPolicy.error
          : compareResendRequestToPolicy(
              request,
              stored.testSend,
              currentPolicy.policy,
            );
        if (configurationError || policyError) {
          const error = configurationError
            ? `Current send configuration blocks this immutable request: ${configurationError}`
            : `Current send policy conflicts with the immutable request: ${policyError}`;
          await tx.arbitraryEmail.update({
            where: { id },
            data: { status: "failed", error },
          });
          return { ok: false, error };
        }

        const submissionCredential = getResendSubmissionCredential(
          deliverySettings.apiKey,
        );
        if (!submissionCredential) {
          const error =
            "Current send configuration blocks this immutable request: Resend submission credential is unavailable";
          await tx.arbitraryEmail.update({
            where: { id },
            data: { status: "failed", error },
          });
          return { ok: false, error };
        }

        providerSubmissionStarted = true;
        const submission = await dependencies.submit(
          request,
          stored.requestHash,
          [],
          submissionCredential,
        );
        const completedAt = dependencies.now();
        if (submission.providerMessageId) {
          await tx.arbitraryEmail.update({
            where: { id },
            data: {
              status: stored.testSend ? "test" : "sent",
              providerMessageId: submission.providerMessageId,
              sentAt: completedAt,
              error: null,
            },
          });
          return { ok: true, id, testSend: stored.testSend };
        }

        const error = submission.error ?? "Unable to send email";
        await tx.arbitraryEmail.update({
          where: { id },
          data: {
            status: sendFailureStatus(submission),
            error,
          },
        });
        return { ok: false, error };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 10_000,
        timeout: OUTREACH_PROVIDER_TRANSACTION_TIMEOUT_MS,
      },
      );
    } catch (error) {
      if (
        !providerSubmissionStarted &&
        transactionAttempt < 3 &&
        isRetryableTransactionError(error)
      ) {
        continue;
      }
      return {
        ok: false,
        error: await persistTransactionFailure(
          dependencies.database,
          id,
          providerSubmissionStarted,
          error,
        ),
      };
    }
  }
  return { ok: false, error: "Unable to submit arbitrary email" };
}

export async function sendArbitraryEmail(
  input: ArbitraryEmailInput,
): Promise<SendArbitraryEmailResult> {
  return sendArbitraryEmailWithDependencies(input, DEFAULT_DEPENDENCIES);
}
