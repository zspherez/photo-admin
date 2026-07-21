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
  RESEND_IDEMPOTENCY_RETENTION_MS,
  sendPreparedEmailViaResend,
  type ResendDeliverySettingsSnapshot,
  type SendResult,
} from "@/lib/resend";
import {
  OUTREACH_CLAIM_TIMEOUT_MS,
  OUTREACH_PROVIDER_TRANSACTION_TIMEOUT_MS,
} from "@/lib/schedule";

export type SendArbitraryEmailResult =
  | { ok: true; id: string; testSend: boolean }
  | { ok: false; error: string };

export type QueueArbitraryEmailResult =
  | { ok: true; id: string; scheduledFor: Date }
  | { ok: false; error: string };

export type DispatchArbitraryEmailResult = {
  ok: boolean;
  id: string;
  skipped?: boolean;
  retryScheduled?: boolean;
  nextAttemptAt?: Date;
  error?: string;
};

type ArbitraryEmailDatabase = Pick<
  typeof db,
  "arbitraryEmail" | "$transaction"
>;

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

const ARBITRARY_EMAIL_MAX_SEND_ATTEMPTS = 4;
const ARBITRARY_EMAIL_RETRY_BASE_DELAY_MS = 60_000;
const ARBITRARY_EMAIL_RETRY_MAX_DELAY_MS = 15 * 60_000;

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

function arbitraryEmailRetryAt(completedAttempts: number, now: Date): Date {
  const exponent = Math.max(0, completedAttempts - 1);
  const delay = Math.min(
    ARBITRARY_EMAIL_RETRY_BASE_DELAY_MS * 2 ** exponent,
    ARBITRARY_EMAIL_RETRY_MAX_DELAY_MS,
  );
  return new Date(now.getTime() + delay);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameQueuedSnapshot(
  stored: {
    recipientEmails: string[];
    subject: string;
    html: string;
    text: string | null;
    utmSource: string | null;
    utmMedium: string | null;
    utmCampaign: string | null;
    utmContent: string | null;
    utmTerm: string | null;
    scheduledFor: Date | null;
  },
  input: ArbitraryEmailInput,
  content: { html: string; text: string },
  scheduledFor: Date,
): boolean {
  return (
    sameStrings(stored.recipientEmails, input.recipientEmails) &&
    stored.subject === input.subject &&
    stored.html === content.html &&
    stored.text === content.text &&
    stored.utmSource === (input.utm.utm_source || null) &&
    stored.utmMedium === (input.utm.utm_medium || null) &&
    stored.utmCampaign === (input.utm.utm_campaign || null) &&
    stored.utmContent === (input.utm.utm_content || null) &&
    stored.utmTerm === (input.utm.utm_term || null) &&
    stored.scheduledFor?.getTime() === scheduledFor.getTime()
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

export async function queueArbitraryEmailWithDependencies(
  input: ArbitraryEmailInput,
  scheduledFor: Date,
  compositionId: string,
  dependencies: Pick<
    SendArbitraryEmailDependencies,
    "database" | "now"
  >,
): Promise<QueueArbitraryEmailResult> {
  const content = normalizeArbitraryEmailContent(
    input.html,
    ARBITRARY_EMAIL_UTM_KEYS.map((key) => [key, input.utm[key]]),
  );
  if (!content.ok) return content;
  if (
    !Number.isFinite(scheduledFor.getTime()) ||
    scheduledFor <= dependencies.now()
  ) {
    return { ok: false, error: "The next dispatch time is no longer upcoming" };
  }

  const idempotencyKey = `arbitrary-email/${compositionId}`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await dependencies.database.$transaction(
        async (tx): Promise<QueueArbitraryEmailResult> => {
          const existing = await tx.arbitraryEmail.findFirst({
            where: {
              OR: [{ id: compositionId }, { idempotencyKey }],
            },
          });
          if (existing) {
            if (
              ["scheduled", "queued", "retry_scheduled"].includes(
                existing.status,
              ) &&
              sameQueuedSnapshot(
                existing,
                input,
                content.content,
                scheduledFor,
              )
            ) {
              return {
                ok: true,
                id: existing.id,
                scheduledFor: existing.scheduledFor ?? scheduledFor,
              };
            }
            return {
              ok: false,
              error:
                "This composition was already queued with different content or state",
            };
          }

          const row = await tx.arbitraryEmail.create({
            data: {
              id: compositionId,
              recipientEmails: input.recipientEmails,
              subject: input.subject,
              html: content.content.html,
              text: content.content.text,
              utmSource: input.utm.utm_source || null,
              utmMedium: input.utm.utm_medium || null,
              utmCampaign: input.utm.utm_campaign || null,
              utmContent: input.utm.utm_content || null,
              utmTerm: input.utm.utm_term || null,
              status: "scheduled",
              idempotencyKey,
              providerRequest: Prisma.DbNull,
              requestHash: null,
              testSend: null,
              scheduledFor,
              nextAttemptAt: scheduledFor,
            },
          });
          return { ok: true, id: row.id, scheduledFor };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      );
    } catch (error) {
      if (attempt < 3 && isRetryableTransactionError(error)) continue;
      return { ok: false, error: errorMessage(error) };
    }
  }
  return { ok: false, error: "Unable to queue arbitrary email" };
}

export async function queueArbitraryEmail(
  input: ArbitraryEmailInput,
  scheduledFor: Date,
  compositionId: string,
): Promise<QueueArbitraryEmailResult> {
  return queueArbitraryEmailWithDependencies(
    input,
    scheduledFor,
    compositionId,
    DEFAULT_DEPENDENCIES,
  );
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
          !stored.requestHash ||
          typeof stored.testSend !== "boolean" ||
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

async function claimScheduledArbitraryEmail(
  id: string,
  dependencies: SendArbitraryEmailDependencies,
): Promise<
  | { kind: "claimed"; claimToken: string }
  | { kind: "complete"; result: DispatchArbitraryEmailResult }
> {
  const now = dependencies.now();
  const staleBefore = new Date(now.getTime() - OUTREACH_CLAIM_TIMEOUT_MS);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await dependencies.database.$transaction(
        async (tx) => {
          await tx.$queryRaw<Array<{ id: string }>>(
            Prisma.sql`
              SELECT "id"
              FROM "ArbitraryEmail"
              WHERE "id" = ${id}
              FOR UPDATE
            `,
          );
          const row = await tx.arbitraryEmail.findUnique({ where: { id } });
          if (!row) {
            return {
              kind: "complete" as const,
              result: { ok: false, id, error: "Arbitrary email not found" },
            };
          }
          const due =
            !!row.nextAttemptAt &&
            row.nextAttemptAt <= now &&
            (row.status === "scheduled" ||
              row.status === "retry_scheduled" ||
              (row.status === "queued" &&
                (!row.claimedAt || row.claimedAt <= staleBefore)));
          if (!due) {
            return {
              kind: "complete" as const,
              result: { ok: true, id, skipped: true },
            };
          }
          if (row.providerMessageId) {
            if (typeof row.testSend !== "boolean") {
              const error =
                "Provider acceptance exists without a verified real/test request snapshot";
              await tx.arbitraryEmail.update({
                where: { id },
                data: {
                  status: "manual_review",
                  error,
                  nextAttemptAt: null,
                  claimedAt: null,
                  claimToken: null,
                },
              });
              return {
                kind: "complete" as const,
                result: { ok: false, id, error },
              };
            }
            await tx.arbitraryEmail.update({
              where: { id },
              data: {
                status: row.testSend ? "test" : "sent",
                sentAt: row.sentAt ?? now,
                error: null,
                nextAttemptAt: null,
                claimedAt: null,
                claimToken: null,
              },
            });
            return {
              kind: "complete" as const,
              result: { ok: true, id },
            };
          }
          if (row.status === "sent" || row.status === "test") {
            return {
              kind: "complete" as const,
              result: { ok: true, id, skipped: true },
            };
          }
          const immutableRequestAgeAnchor =
            row.lastAttemptAt ?? row.claimedAt;
          if (
            row.providerRequest &&
            immutableRequestAgeAnchor &&
            now.getTime() - immutableRequestAgeAnchor.getTime() >=
              RESEND_IDEMPOTENCY_RETENTION_MS
          ) {
            const error =
              "Queued provider request is older than the provider idempotency retention window; review manually before retrying";
            await tx.arbitraryEmail.update({
              where: { id },
              data: {
                status: "manual_review",
                error,
                nextAttemptAt: null,
                claimedAt: null,
                claimToken: null,
              },
            });
            return {
              kind: "complete" as const,
              result: { ok: false, id, error },
            };
          }
          const claimToken = dependencies.createId();
          await tx.arbitraryEmail.update({
            where: { id },
            data: {
              status: "queued",
              claimToken,
              claimedAt: now,
              error: null,
            },
          });
          return { kind: "claimed" as const, claimToken };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      );
    } catch (error) {
      if (attempt < 3 && isRetryableTransactionError(error)) continue;
      return {
        kind: "complete",
        result: { ok: false, id, error: errorMessage(error) },
      };
    }
  }
  return {
    kind: "complete",
    result: { ok: false, id, error: "Unable to claim arbitrary email" },
  };
}

async function ensureScheduledArbitraryRequest(
  id: string,
  claimToken: string,
  dependencies: SendArbitraryEmailDependencies,
): Promise<
  | { ok: true }
  | { ok: false; result: DispatchArbitraryEmailResult }
> {
  const row = await dependencies.database.arbitraryEmail.findUnique({
    where: { id },
  });
  if (!row || row.status !== "queued" || row.claimToken !== claimToken) {
    return {
      ok: false,
      result: {
        ok: false,
        id,
        error: "Arbitrary email claim changed before request preparation",
      },
    };
  }
  if (row.providerRequest !== null) return { ok: true };
  if (!row.text) {
    const error = "Queued arbitrary email has no immutable plain-text snapshot";
    await dependencies.database.arbitraryEmail.updateMany({
      where: { id, status: "queued", claimToken },
      data: {
        status: "manual_review",
        error,
        nextAttemptAt: null,
        claimedAt: null,
        claimToken: null,
      },
    });
    return { ok: false, result: { ok: false, id, error } };
  }

  const prepared = await dependencies.prepare({
    to: row.recipientEmails,
    subject: row.subject,
    html: row.html,
    text: row.text,
    arbitraryEmailId: row.id,
    idempotencyKey: row.idempotencyKey,
  });
  if (!prepared.ok) {
    const retryScheduled = prepared.preparationDisposition === "retryable";
    const nextAttemptAt = retryScheduled
      ? arbitraryEmailRetryAt(Math.max(1, row.attemptCount), dependencies.now())
      : null;
    await dependencies.database.arbitraryEmail.updateMany({
      where: { id, status: "queued", claimToken },
      data: {
        status: retryScheduled ? "retry_scheduled" : "failed",
        error: prepared.error,
        nextAttemptAt,
        claimedAt: null,
        claimToken: null,
      },
    });
    return {
      ok: false,
      result: {
        ok: false,
        id,
        error: prepared.error,
        retryScheduled: retryScheduled || undefined,
        nextAttemptAt: nextAttemptAt ?? undefined,
      },
    };
  }
  if (
    prepared.request.html !== row.html ||
    prepared.request.text !== row.text
  ) {
    const error = "Prepared Resend request changed the queued content snapshot";
    await dependencies.database.arbitraryEmail.updateMany({
      where: { id, status: "queued", claimToken },
      data: {
        status: "manual_review",
        error,
        nextAttemptAt: null,
        claimedAt: null,
        claimToken: null,
      },
    });
    return { ok: false, result: { ok: false, id, error } };
  }

  const persisted = await dependencies.database.arbitraryEmail.updateMany({
    where: {
      id,
      status: "queued",
      claimToken,
      providerRequest: { equals: Prisma.DbNull },
    },
    data: {
      providerRequest: prepared.request as unknown as Prisma.InputJsonValue,
      requestHash: prepared.requestHash,
      testSend: prepared.testSend,
    },
  });
  if (persisted.count !== 1) {
    return {
      ok: false,
      result: {
        ok: false,
        id,
        error: "Arbitrary email claim changed while persisting its request",
      },
    };
  }
  return { ok: true };
}

async function submitScheduledArbitraryEmail(
  id: string,
  claimToken: string,
  dependencies: SendArbitraryEmailDependencies,
): Promise<DispatchArbitraryEmailResult> {
  for (let transactionAttempt = 0; transactionAttempt < 4; transactionAttempt += 1) {
    let providerSubmissionStarted = false;
    try {
      return await dependencies.database.$transaction(
        async (tx): Promise<DispatchArbitraryEmailResult> => {
          await tx.$queryRaw<Array<{ id: string }>>(
            Prisma.sql`
              SELECT "id"
              FROM "ArbitraryEmail"
              WHERE "id" = ${id}
              FOR UPDATE
            `,
          );
          const stored = await tx.arbitraryEmail.findUnique({ where: { id } });
          if (
            !stored ||
            stored.status !== "queued" ||
            stored.claimToken !== claimToken
          ) {
            return {
              ok: false,
              id,
              error: "Arbitrary email claim changed before provider submission",
            };
          }

          const request = parseResendRequestSnapshot(stored.providerRequest);
          if (
            !request ||
            !stored.requestHash ||
            typeof stored.testSend !== "boolean" ||
            hashResendRequestSnapshot(request) !== stored.requestHash ||
            request.idempotencyKey !== stored.idempotencyKey ||
            request.html !== stored.html ||
            request.text !== stored.text
          ) {
            const error =
              "Stored queued Resend request failed its identity or integrity check";
            await tx.arbitraryEmail.update({
              where: { id },
              data: {
                status: "manual_review",
                error,
                nextAttemptAt: null,
                claimedAt: null,
                claimToken: null,
              },
            });
            return { ok: false, id, error };
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
              data: {
                status: "failed",
                error,
                nextAttemptAt: null,
                claimedAt: null,
                claimToken: null,
              },
            });
            return { ok: false, id, error };
          }

          const submissionCredential = getResendSubmissionCredential(
            deliverySettings.apiKey,
          );
          if (!submissionCredential) {
            const error =
              "Current send configuration blocks this immutable request: Resend submission credential is unavailable";
            await tx.arbitraryEmail.update({
              where: { id },
              data: {
                status: "failed",
                error,
                nextAttemptAt: null,
                claimedAt: null,
                claimToken: null,
              },
            });
            return { ok: false, id, error };
          }

          const completedAttempts = stored.attemptCount + 1;
          await tx.arbitraryEmail.update({
            where: { id },
            data: {
              attemptCount: completedAttempts,
              lastAttemptAt: dependencies.now(),
            },
          });
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
                nextAttemptAt: null,
                claimedAt: null,
                claimToken: null,
              },
            });
            return { ok: true, id };
          }

          const error = submission.error ?? "Unable to send email";
          const canRetry =
            ["configuration", "in_flight", "retryable"].includes(
              submission.failureDisposition ?? "",
            ) &&
            completedAttempts < ARBITRARY_EMAIL_MAX_SEND_ATTEMPTS;
          const nextAttemptAt = canRetry
            ? arbitraryEmailRetryAt(completedAttempts, completedAt)
            : null;
          await tx.arbitraryEmail.update({
            where: { id },
            data: {
              status: canRetry
                ? "retry_scheduled"
                : sendFailureStatus(submission),
              error,
              nextAttemptAt,
              claimedAt: null,
              claimToken: null,
            },
          });
          return {
            ok: false,
            id,
            error,
            retryScheduled: canRetry || undefined,
            nextAttemptAt: nextAttemptAt ?? undefined,
          };
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
      const detail = errorMessage(error);
      if (providerSubmissionStarted) {
        const message = `Provider submission outcome is uncertain: ${detail}`;
        await dependencies.database.arbitraryEmail.updateMany({
          where: { id, status: "queued", claimToken },
          data: {
            status: "manual_review",
            error: message,
            nextAttemptAt: null,
            claimedAt: null,
            claimToken: null,
            attemptCount: { increment: 1 },
            lastAttemptAt: dependencies.now(),
          },
        });
        return { ok: false, id, error: message };
      }
      return {
        ok: false,
        id,
        error: `Arbitrary email dispatch transaction failed: ${detail}`,
        retryScheduled: true,
        nextAttemptAt: new Date(
          dependencies.now().getTime() + OUTREACH_CLAIM_TIMEOUT_MS,
        ),
      };
    }
  }
  return { ok: false, id, error: "Unable to dispatch arbitrary email" };
}

export async function dispatchScheduledArbitraryEmailWithDependencies(
  id: string,
  dependencies: SendArbitraryEmailDependencies,
): Promise<DispatchArbitraryEmailResult> {
  const claim = await claimScheduledArbitraryEmail(id, dependencies);
  if (claim.kind === "complete") return claim.result;
  const prepared = await ensureScheduledArbitraryRequest(
    id,
    claim.claimToken,
    dependencies,
  );
  if (!prepared.ok) return prepared.result;
  return submitScheduledArbitraryEmail(id, claim.claimToken, dependencies);
}

export async function dispatchScheduledArbitraryEmail(
  id: string,
): Promise<DispatchArbitraryEmailResult> {
  return dispatchScheduledArbitraryEmailWithDependencies(
    id,
    DEFAULT_DEPENDENCIES,
  );
}

export async function cancelScheduledArbitraryEmailWithDatabase(
  id: string,
  database: Pick<typeof db, "arbitraryEmail">,
): Promise<boolean> {
  const cancelled = await database.arbitraryEmail.updateMany({
    where: {
      id,
      status: { in: ["scheduled", "retry_scheduled"] },
      providerMessageId: null,
    },
    data: {
      status: "cancelled",
      error: null,
      scheduledFor: null,
      nextAttemptAt: null,
      claimedAt: null,
      claimToken: null,
    },
  });
  return cancelled.count === 1;
}

export async function cancelScheduledArbitraryEmail(
  id: string,
): Promise<boolean> {
  return cancelScheduledArbitraryEmailWithDatabase(id, db);
}
