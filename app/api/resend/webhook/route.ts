import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { Webhook, WebhookVerificationError } from "svix";
import { db } from "@/lib/db";
import {
  RESEND_WEBHOOK_LOCK_CLASS,
  PROVIDER_MESSAGE_ID_CONFLICT_PREFIX,
  bindProviderMessageIdAtIndex,
  canBindResendWebhookProviderMessage,
  correlateResendWebhookAttempt,
  duplicateProviderMessageIdConflict,
  getResendWebhookFailurePolicy,
  isProviderMessageIdConflictError,
  markResendRequestDeliveryFailure,
  hasAcceptedProviderMessageId,
  nonemptyProviderMessageIds,
  outreachWebhookRecipientImpact,
  parseResendRequestBatchSnapshot,
  parseResendRequestResultSnapshot,
  resendRequestResultsAreResolved,
  providerMessageIdsAreComplete,
  shouldMirrorResendAttempt,
  validateProviderMessageIndex,
} from "@/lib/resend";
import {
  ensureOutreachSentMailCopiesQueued,
  ensureSentMailCopyQueued,
} from "@/lib/sentMailCopy";
import { acquireOutreachRecipientPolicyLocks } from "@/lib/outreachPolicyLocks";
import {
  arbitraryEmailEventUpdate,
  arbitraryEmailWebhookImpactedRecipients,
  arbitraryEmailWebhookRecipientImpact,
  arbitraryEmailWebhookConflict,
} from "@/lib/arbitraryEmail";
import { resendClickMetadata } from "@/lib/resendClick";

interface ResendEvent {
  type: string;
  created_at: string;
  data: {
    created_at?: string;
    email_id?: string;
    to?: string[];
    cc?: string[];
    bcc?: string[];
    tags?: Record<string, string> | { name: string; value: string }[];
    headers?: { name: string; value: string }[];
    click?: { link?: string; timestamp?: string };
    bounce?: { message?: string; subType?: string; type?: string };
    suppressed?: { message?: string; type?: string };
  };
}

export { RESEND_WEBHOOK_LOCK_CLASS } from "@/lib/resend";
const RESEND_WEBHOOK_TRANSACTION_ATTEMPTS = 8;

export function resendWebhookSerializationKeys(
  eventId: string,
  parsed: ResendEvent,
): string[] {
  const values = [
    parsed.data.email_id
      ? `message:${parsed.data.email_id}`
      : null,
    findAttemptId(parsed)
      ? `attempt:${findAttemptId(parsed)}`
      : null,
    findArbitraryEmailId(parsed)
      ? `arbitrary:${findArbitraryEmailId(parsed)}`
      : null,
    findOutreachId(parsed)
      ? `outreach:${findOutreachId(parsed)}`
      : null,
  ].filter((value): value is string => value !== null);
  return values.length > 0
    ? Array.from(new Set(values)).sort()
    : [`event:${eventId}`];
}

async function acquireResendWebhookSerializationLocks(
  tx: Prisma.TransactionClient,
  eventId: string,
  parsed: ResendEvent,
): Promise<void> {
  for (const key of resendWebhookSerializationKeys(eventId, parsed)) {
    await tx.$queryRaw<Array<{ locked: number }>>(Prisma.sql`
      SELECT 1 AS "locked"
      FROM (
        SELECT pg_advisory_xact_lock(
          CAST(${RESEND_WEBHOOK_LOCK_CLASS} AS INTEGER),
          CAST(hashtext(${key}) AS INTEGER)
        )
      ) AS "resendWebhookSerializationLock"
    `);
  }
}

function waitForWebhookRetry(attempt: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 25 * 2 ** attempt);
  });
}

function findTag(evt: ResendEvent, name: string): string | null {
  const tags = evt.data.tags;
  if (!tags) return null;
  if (Array.isArray(tags)) {
    return tags.find((candidate) => candidate.name === name)?.value ?? null;
  }
  return tags[name] ?? null;
}

function findHeader(evt: ResendEvent, name: string): string | null {
  return (
    evt.data.headers?.find(
      (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
    )?.value ?? null
  );
}

function findOutreachId(evt: ResendEvent): string | null {
  return findTag(evt, "outreach_id") ?? findHeader(evt, "x-outreach-id");
}

function findAttemptId(evt: ResendEvent): string | null {
  return (
    findTag(evt, "outreach_attempt_id") ??
    findHeader(evt, "x-outreach-attempt-id")
  );
}

function findMessageIndex(evt: ResendEvent): number | null {
  const value =
    findTag(evt, "outreach_message_index") ??
    findHeader(evt, "x-outreach-message-index");
  if (!value || !/^\d+$/.test(value)) return null;
  const index = Number(value);
  return Number.isSafeInteger(index) ? index : null;
}

function findArbitraryEmailId(evt: ResendEvent): string | null {
  return (
    findTag(evt, "arbitrary_email_id") ??
    findHeader(evt, "x-arbitrary-email-id")
  );
}

function validDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function eventDate(evt: ResendEvent): Date {
  const date = validDate(evt.data.click?.timestamp) ?? validDate(evt.created_at);
  if (!date) throw new Error("Webhook event has no valid provider timestamp");
  return date;
}

function earlier(current: Date | null, candidate: Date): Date {
  return !current || candidate < current ? candidate : current;
}

function later(current: Date | null, candidate: Date): Date {
  return !current || candidate > current ? candidate : current;
}

function suppressionReason(evt: ResendEvent): string {
  if (evt.type === "email.bounced") {
    return `bounce:${evt.data.bounce?.subType ?? evt.data.bounce?.type ?? "permanent"}`;
  }
  if (evt.type === "email.complained") return "complaint";
  return `suppressed:${evt.data.suppressed?.type ?? "provider"}`;
}

function isDeliveryProblemEvent(type: string): boolean {
  return [
    "email.bounced",
    "email.complained",
    "email.suppressed",
    "email.delivery_delayed",
    "email.failed",
  ].includes(type);
}

async function applySuppression(
  tx: Prisma.TransactionClient,
  eventId: string,
  parsed: ResendEvent,
  providerCreatedAt: Date,
  normalizedEmails: string[],
): Promise<void> {
  if (
    parsed.type !== "email.bounced" &&
    parsed.type !== "email.complained" &&
    parsed.type !== "email.suppressed"
  ) {
    return;
  }
  const reason = suppressionReason(parsed);
  await acquireOutreachRecipientPolicyLocks(tx, normalizedEmails);
  for (const normalizedEmail of normalizedEmails) {
    const existing = await tx.emailSuppression.findUnique({
      where: { normalizedEmail },
    });
    const isLatest = !existing || providerCreatedAt >= existing.suppressedAt;
    await tx.emailSuppression.upsert({
      where: { normalizedEmail },
      create: {
        normalizedEmail,
        reason,
        sourceEventId: eventId,
        suppressedAt: providerCreatedAt,
      },
      update: {
        reason: isLatest ? reason : existing.reason,
        sourceEventId: isLatest ? eventId : existing.sourceEventId,
        suppressedAt: isLatest ? providerCreatedAt : existing.suppressedAt,
      },
    });
  }
}

async function processEvent(
  eventId: string,
  parsed: ResendEvent,
): Promise<{ note?: string }> {
  for (
    let retry = 0;
    retry < RESEND_WEBHOOK_TRANSACTION_ATTEMPTS;
    retry += 1
  ) {
    try {
      return await db.$transaction(
        async (tx) => {
          await acquireResendWebhookSerializationLocks(
            tx,
            eventId,
            parsed,
          );
          const attemptId = findAttemptId(parsed);
          const outreachId = findOutreachId(parsed);
          const arbitraryEmailId = findArbitraryEmailId(parsed);
          const messageId = parsed.data.email_id ?? null;
          const providerCreatedAt = eventDate(parsed);
          const clickMetadata = resendClickMetadata(
            parsed.type,
            parsed.data.click,
          );
          const impactedRecipients =
            arbitraryEmailWebhookImpactedRecipients(parsed.data);

          const [
            taggedArbitraryEmail,
            messageArbitraryEmail,
            messageOutreachAttempt,
          ] =
            await Promise.all([
              arbitraryEmailId
                ? tx.arbitraryEmail.findUnique({
                    where: { id: arbitraryEmailId },
                  })
                : Promise.resolve(null),
              messageId
                ? tx.arbitraryEmail.findUnique({
                    where: { providerMessageId: messageId },
                  })
                : Promise.resolve(null),
              messageId
                ? tx.outreachSendAttempt.findFirst({
                    where: {
                      OR: [
                        { providerMessageId: messageId },
                        { providerMessageIds: { has: messageId } },
                      ],
                    },
                    select: { id: true },
                  })
                : Promise.resolve(null),
            ]);
          if (arbitraryEmailId || messageArbitraryEmail) {
            let arbitraryEmail =
              taggedArbitraryEmail ?? messageArbitraryEmail;
            let conflict = arbitraryEmailWebhookConflict(
              {
                arbitraryEmailId,
                outreachId,
                attemptId,
                providerMessageId: messageId,
              },
              taggedArbitraryEmail,
              messageArbitraryEmail,
              messageOutreachAttempt,
            );
            const arbitraryTestSend = arbitraryEmail?.testSend;
            if (
              !conflict &&
              arbitraryEmail &&
              (typeof arbitraryTestSend !== "boolean" ||
                !arbitraryEmail.providerRequest ||
                !arbitraryEmail.requestHash)
            ) {
              conflict =
                "arbitrary email has no immutable provider request snapshot";
            }
            if (
              !conflict &&
              arbitraryEmail &&
              messageId &&
              !arbitraryEmail.providerMessageId
            ) {
              await tx.arbitraryEmail.updateMany({
                where: {
                  id: arbitraryEmail.id,
                  providerMessageId: null,
                },
                data: { providerMessageId: messageId },
              });
              const rebound = await tx.arbitraryEmail.findUnique({
                where: { id: arbitraryEmail.id },
              });
              if (!rebound || rebound.providerMessageId !== messageId) {
                conflict =
                  "provider message could not be bound to arbitrary email";
              } else {
                arbitraryEmail = rebound;
              }
            }
            if (!arbitraryEmail || conflict) {
              await tx.resendWebhookEvent.create({
                data: {
                  eventId,
                  type: parsed.type,
                  providerMessageId: messageId,
                  recipientEmails: impactedRecipients,
                  providerCreatedAt,
                  ...clickMetadata,
                  correlationStatus: "conflict",
                  correlationError: conflict ?? "arbitrary email not found",
                },
              });
              return {
                note: `conflict webhook quarantined: ${
                  conflict ?? "arbitrary email not found"
                }`,
              };
            }

            await tx.resendWebhookEvent.create({
              data: {
                eventId,
                type: parsed.type,
                providerMessageId: messageId,
                recipientEmails: impactedRecipients,
                providerCreatedAt,
                ...clickMetadata,
                arbitraryEmailId: arbitraryEmail.id,
                correlationStatus: "matched",
              },
            });
            if (arbitraryTestSend === false) {
              await applySuppression(
                tx,
                eventId,
                parsed,
                providerCreatedAt,
                impactedRecipients,
              );
            }
            if (arbitraryEmail.providerMessageId) {
              await ensureSentMailCopyQueued(tx, {
                kind: "arbitrary",
                id: arbitraryEmail.id,
                providerMessageId: arbitraryEmail.providerMessageId,
                requested: arbitraryEmail.sentMailboxCopyRequested,
                targetScope: arbitraryEmail.sentMailboxTargetScope,
                configurationError:
                  arbitraryEmail.sentMailboxCopyConfigurationError,
                testSend: arbitraryTestSend as boolean,
              });
            }
            const intendedRecipientImpact =
              arbitraryEmailWebhookRecipientImpact(
                arbitraryEmail.recipientEmails,
                parsed.data,
              );
            if (intendedRecipientImpact.affectsAggregate) {
              const update = arbitraryEmailEventUpdate(
                { ...arbitraryEmail, testSend: arbitraryTestSend as boolean },
                parsed.type,
                providerCreatedAt,
                isDeliveryProblemEvent(parsed.type)
                  ? parsed.type === "email.bounced" ||
                    parsed.type === "email.complained" ||
                    parsed.type === "email.suppressed"
                    ? suppressionReason(parsed)
                    : parsed.type
                  : undefined,
              ) as Prisma.ArbitraryEmailUpdateInput;
              if (Object.keys(update).length > 0) {
                await tx.arbitraryEmail.update({
                  where: { id: arbitraryEmail.id },
                  data: update,
                });
              }
            }
            return intendedRecipientImpact.affectsAggregate
              ? {}
              : {
                  note:
                    "auxiliary recipient webhook recorded without aggregate mutation",
                };
          }

          const [
            taggedAttempt,
            messageAttempt,
            outreachAttempts,
            taggedLegacyAttempt,
          ] =
            await Promise.all([
              attemptId
                ? tx.outreachSendAttempt.findUnique({
                    where: { id: attemptId },
                  })
                : Promise.resolve(null),
              messageId
                ? tx.outreachSendAttempt.findFirst({
                    where: {
                      OR: [
                        { providerMessageId: messageId },
                        { providerMessageIds: { has: messageId } },
                      ],
                    },
                  })
                : Promise.resolve(null),
              !attemptId && outreachId
                ? tx.outreachSendAttempt.findMany({
                    where: { outreachId },
                    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                    take: 2,
                  })
                : Promise.resolve([]),
              outreachId
                ? tx.outreachSendAttempt.findFirst({
                    where: {
                      outreachId,
                      testSend: null,
                      status: { in: ["legacy_unknown", "manual_review"] },
                    },
                    select: { id: true },
                  })
                : Promise.resolve(null),
            ]);
          const outreachAttempt =
            outreachAttempts.length === 1 ? outreachAttempts[0] : null;

          let correlation = correlateResendWebhookAttempt(
            {
              attemptId,
              outreachId,
              providerMessageId: messageId,
            },
            taggedAttempt,
            messageAttempt,
            outreachAttempt,
          );
          let conflictedAttempt: typeof taggedAttempt = null;
          let quarantinedAttemptEvent =
            correlation.status !== "matched" && taggedLegacyAttempt !== null;
          const quarantineProviderIdentityConflict = async (
            attemptId: string,
            error: string,
          ) => {
            const attempt = await tx.outreachSendAttempt.update({
              where: { id: attemptId },
              data: {
                status: "manual_review",
                error,
                failureDisposition: "policy",
                nextAttemptAt: null,
              },
            });
            conflictedAttempt = attempt;
            const outreach = await tx.outreach.findUnique({
              where: { id: attempt.outreachId },
              select: { id: true, idempotencyKey: true },
            });
            if (outreach?.idempotencyKey === attempt.idempotencyKey) {
              await tx.outreach.update({
                where: { id: outreach.id },
                data: {
                  status: "manual_review",
                  error,
                  nextAttemptAt: null,
                  claimedAt: null,
                  claimToken: null,
                },
              });
            }
            correlation = { status: "conflict", reason: error };
          };

          if (
            correlation.status === "conflict" &&
            taggedAttempt &&
            messageAttempt &&
            taggedAttempt.id !== messageAttempt.id &&
            messageId
          ) {
            await quarantineProviderIdentityConflict(
              taggedAttempt.id,
              `${PROVIDER_MESSAGE_ID_CONFLICT_PREFIX}tagged attempt: ` +
                `${messageId} already belongs to another attempt`,
            );
          }

          if (
            correlation.status === "matched" &&
            correlation.bindProviderMessageId &&
            !canBindResendWebhookProviderMessage(correlation.attempt)
          ) {
            quarantinedAttemptEvent = true;
            correlation = {
              status: "conflict",
              reason:
                "provider message cannot be bound to a quarantined legacy attempt",
            };
          }

          if (correlation.status === "matched" && messageId) {
            const expectedRequests = parseResendRequestBatchSnapshot(
              correlation.attempt.providerRequest,
            )?.requests.length;
            if (expectedRequests && expectedRequests > 1) {
              const conflict = validateProviderMessageIndex(
                correlation.attempt.providerMessageIds ?? [],
                expectedRequests,
                findMessageIndex(parsed),
                messageId,
              );
              if (conflict) {
                await quarantineProviderIdentityConflict(
                  correlation.attempt.id,
                  conflict,
                );
              }
            }
          }

          if (
            correlation.status === "matched" &&
            correlation.bindProviderMessageId &&
            messageId
          ) {
            const expectedRequests = parseResendRequestBatchSnapshot(
              correlation.attempt.providerRequest,
            )?.requests.length;
            const messageIndex = findMessageIndex(parsed);
            if (
              expectedRequests &&
              expectedRequests > 1 &&
              messageIndex === null
            ) {
              correlation = {
                status: "conflict",
                reason:
                  "batched provider message is missing its immutable message index",
              };
            } else {
              let providerMessageIds = [
                ...(correlation.attempt.providerMessageIds ?? []),
              ];
              if (
                expectedRequests &&
                messageIndex !== null &&
                messageIndex < expectedRequests
              ) {
                const binding = bindProviderMessageIdAtIndex(
                  providerMessageIds,
                  expectedRequests,
                  messageIndex,
                  messageId,
                );
                providerMessageIds = binding.providerMessageIds;
                if (binding.conflict) {
                  await quarantineProviderIdentityConflict(
                    correlation.attempt.id,
                    binding.conflict,
                  );
                }
              } else if (!providerMessageIds.includes(messageId)) {
                providerMessageIds.push(messageId);
              }
              if (correlation.status === "matched") {
                await tx.outreachSendAttempt.update({
                  where: { id: correlation.attempt.id },
                  data: {
                    providerMessageIds,
                    providerRequestResults:
                      expectedRequests && messageIndex !== null
                        ? (parseResendRequestResultSnapshot(
                            correlation.attempt.providerRequestResults,
                            expectedRequests,
                            providerMessageIds,
                          ).map((result, index) =>
                            index === messageIndex
                              ? {
                                  providerMessageId: messageId,
                                  error: null,
                                  failureDisposition: null,
                                }
                              : result,
                          ) as Prisma.InputJsonValue)
                        : undefined,
                    ...(expectedRequests === 1
                      ? { providerMessageId: messageId }
                      : {}),
                  },
                });
                const rebound = await tx.outreachSendAttempt.findUnique({
                  where: { id: correlation.attempt.id },
                });
                if (
                  !rebound ||
                  (!rebound.providerMessageIds.includes(messageId) &&
                    rebound.providerMessageId !== messageId)
                ) {
                  correlation = {
                    status: "conflict",
                    reason:
                      "provider message could not be bound to the immutable attempt",
                  };
                } else {
                  correlation = {
                    status: "matched",
                    attempt: rebound,
                    bindProviderMessageId: false,
                  };
                }
              }
            }
          }

          const matchedAttempt =
            correlation.status === "matched" ? correlation.attempt : null;
          const eventAttempt = matchedAttempt ?? conflictedAttempt;
          const matchedRequestBatch = matchedAttempt
            ? parseResendRequestBatchSnapshot(matchedAttempt.providerRequest)
            : null;
          const matchedMessageIndex =
            findMessageIndex(parsed) ??
            (messageId
              ? (matchedAttempt?.providerMessageIds ?? []).indexOf(messageId)
              : -1);
          const matchedRequest =
            matchedRequestBatch?.requests[
              matchedMessageIndex >= 0
                ? matchedMessageIndex
                : matchedRequestBatch.requests.length === 1
                  ? 0
                  : -1
            ] ?? null;
          const outreachRecipientImpact = matchedRequest
            ? outreachWebhookRecipientImpact(matchedRequest, parsed.data)
            : null;
          await tx.resendWebhookEvent.create({
            data: {
              eventId,
              type: parsed.type,
              providerMessageId: messageId,
              recipientEmails: impactedRecipients,
              providerCreatedAt,
              ...clickMetadata,
              outreachId: eventAttempt?.outreachId ?? null,
              attemptId: eventAttempt?.id ?? null,
              correlationStatus: correlation.status,
              correlationError:
                correlation.status === "matched" ? null : correlation.reason,
            },
          });

          const failurePolicy =
            getResendWebhookFailurePolicy(
              quarantinedAttemptEvent
                ? { status: "legacy_unknown" }
                : matchedAttempt,
            );
          if (failurePolicy.applySuppression) {
            await applySuppression(
              tx,
              eventId,
              parsed,
              providerCreatedAt,
              impactedRecipients,
            );
          }
          if (
            correlation.status === "matched" &&
            outreachRecipientImpact &&
            !outreachRecipientImpact.affectsAggregate
          ) {
            return {
              note:
                "auxiliary outreach recipient webhook recorded without aggregate mutation",
            };
          }

          if (correlation.status !== "matched") {
            return {
              note: `${correlation.status} webhook quarantined: ${correlation.reason}`,
            };
          }
          if (!failurePolicy.processAttemptEvents) {
            return {
              note:
                "webhook recorded without mutating a quarantined provider attempt",
            };
          }

          const attempt = await tx.outreachSendAttempt.findUnique({
            where: { id: correlation.attempt.id },
          });
          if (!attempt) return { note: "matched attempt disappeared" };
          const duplicateProviderIdentity =
            duplicateProviderMessageIdConflict(attempt.providerMessageIds);
          if (duplicateProviderIdentity) {
            await quarantineProviderIdentityConflict(
              attempt.id,
              duplicateProviderIdentity,
            );
            await tx.resendWebhookEvent.update({
              where: { eventId },
              data: {
                correlationStatus: "conflict",
                correlationError: duplicateProviderIdentity,
              },
            });
            return {
              note:
                "duplicate provider identity remains quarantined pending explicit resolution",
            };
          }
          if (
            attempt.status === "manual_review" &&
            attempt.failureDisposition === "policy" &&
            isProviderMessageIdConflictError(attempt.error)
          ) {
            return {
              note:
                "provider identity conflict remains quarantined pending explicit resolution",
            };
          }
          const outreach = await tx.outreach.findUnique({
            where: { id: attempt.outreachId },
          });
          const mirror =
            !!outreach && shouldMirrorResendAttempt(outreach, attempt);
          const expectedProviderMessages =
            parseResendRequestBatchSnapshot(attempt.providerRequest)?.requests
              .length ?? 1;
          const providerMessageIds = Array.from(
            new Set([
              ...nonemptyProviderMessageIds(attempt.providerMessageIds),
              ...(attempt.providerMessageId
                ? [attempt.providerMessageId]
                : []),
            ]),
          );
          const providerAcceptanceComplete =
            providerMessageIdsAreComplete(
              providerMessageIds,
              expectedProviderMessages,
            );
          const primaryProviderMessageId =
            attempt.providerMessageId ?? providerMessageIds[0] ?? null;
          const indexedProviderMessageIds =
            attempt.providerMessageIds.length > 0
              ? attempt.providerMessageIds
              : primaryProviderMessageId
                ? [primaryProviderMessageId]
                : [];
          const mirrorDeliveryProblem =
            mirror && failurePolicy.mirrorOutreachFailure;
          const requestResultIndex =
            matchedMessageIndex >= 0
              ? matchedMessageIndex
              : expectedProviderMessages === 1
                ? 0
                : -1;
          const currentRequestResults = parseResendRequestResultSnapshot(
            attempt.providerRequestResults,
            expectedProviderMessages,
            attempt.providerMessageIds,
          );
          const persistedDeliveryFailure = currentRequestResults.find(
            (result) => result?.deliveryFailure,
          )?.deliveryFailure;
          const hadDeliveryFailure =
            attempt.status === "delivery_failed" ||
            persistedDeliveryFailure !== undefined;
          const completedAttemptStatus = hadDeliveryFailure
            ? "delivery_failed"
            : "accepted";
          const completedOutreachStatus = attempt.testSend
            ? "test"
            : hadDeliveryFailure
              ? "failed"
              : "sent";
          const completedError =
            persistedDeliveryFailure ??
            (attempt.status === "delivery_failed" ? attempt.error : null);
          const deliveryFailureState = (error: string) => {
            const providerId =
              messageId ??
              currentRequestResults[requestResultIndex]?.providerMessageId ??
              null;
            if (requestResultIndex < 0 || !providerId) {
              return {
                results: currentRequestResults,
                resolved: false,
              };
            }
            const results = markResendRequestDeliveryFailure(
              currentRequestResults,
              requestResultIndex,
              providerId,
              error,
            );
            return {
              results,
              resolved: resendRequestResultsAreResolved(results),
            };
          };

          if (hasAcceptedProviderMessageId(indexedProviderMessageIds)) {
            await ensureOutreachSentMailCopiesQueued(tx, {
              id: attempt.id,
              providerMessageIds: indexedProviderMessageIds,
              requested: attempt.sentMailboxCopyRequested,
              targetScope: attempt.sentMailboxTargetScope,
              configurationError: attempt.sentMailboxCopyConfigurationError,
              testSend: attempt.testSend,
            });
          }
          if (providerAcceptanceComplete && primaryProviderMessageId) {
            const acceptedAt = earlier(
              earlier(
                attempt.acceptedAt,
                attempt.deliveredAt ?? providerCreatedAt,
              ),
              providerCreatedAt,
            );
            await tx.outreachSendAttempt.update({
              where: { id: attempt.id },
              data: {
                status: hadDeliveryFailure
                  ? completedAttemptStatus
                  : "accepted",
                acceptedAt,
                error: completedError,
                failureDisposition: null,
                nextAttemptAt: null,
                providerMessageId: primaryProviderMessageId,
                providerMessageIds,
              },
            });
            if (providerAcceptanceComplete && mirror && outreach) {
              await tx.outreach.update({
                where: { id: outreach.id },
                data: {
                  status: completedOutreachStatus,
                  error: completedError,
                  providerMessageId: primaryProviderMessageId,
                  providerMessageIds,
                  sentAt: earlier(
                    earlier(outreach.sentAt, acceptedAt),
                    attempt.deliveredAt ?? acceptedAt,
                  ),
                  ...(attempt.deliveredAt
                    ? {
                        deliveredAt: earlier(
                          outreach.deliveredAt,
                          attempt.deliveredAt,
                        ),
                      }
                    : {}),
                  ...(hadDeliveryFailure && attempt.bouncedAt
                    ? {
                        bouncedAt: earlier(
                          outreach.bouncedAt,
                          attempt.bouncedAt,
                        ),
                      }
                    : {}),
                  ...(hadDeliveryFailure && attempt.complainedAt
                    ? {
                        complainedAt: earlier(
                          outreach.complainedAt,
                          attempt.complainedAt,
                        ),
                      }
                    : {}),
                  scheduledFor: null,
                  nextAttemptAt: null,
                  claimedAt: null,
                  claimToken: null,
                },
              });
            }
          }

          if (
            mirror &&
            outreach &&
            failurePolicy.preserveTestOutreachState &&
            isDeliveryProblemEvent(parsed.type)
          ) {
            await tx.outreach.update({
              where: { id: outreach.id },
              data: {
                status: "test",
                error: null,
                providerMessageId: primaryProviderMessageId,
                providerMessageIds,
                sentAt: earlier(
                  earlier(
                    outreach.sentAt,
                    attempt.acceptedAt ?? providerCreatedAt,
                  ),
                  attempt.deliveredAt ?? providerCreatedAt,
                ),
                ...(attempt.deliveredAt
                  ? {
                      deliveredAt: earlier(
                        outreach.deliveredAt,
                        attempt.deliveredAt,
                      ),
                    }
                  : {}),
                scheduledFor: null,
                nextAttemptAt: null,
                claimedAt: null,
                claimToken: null,
              },
            });
          }

          switch (parsed.type) {
            case "email.sent": {
              const acceptedAt = earlier(
                earlier(
                  attempt.acceptedAt,
                  attempt.deliveredAt ?? providerCreatedAt,
                ),
                providerCreatedAt,
              );
              await tx.outreachSendAttempt.update({
                where: { id: attempt.id },
                data: {
                  status: hadDeliveryFailure
                    ? providerAcceptanceComplete
                      ? completedAttemptStatus
                      : attempt.status
                    : providerAcceptanceComplete
                      ? "accepted"
                      : attempt.status,
                  error:
                    hadDeliveryFailure
                      ? completedError
                      : !providerAcceptanceComplete
                        ? attempt.error
                      : null,
                  acceptedAt,
                  failureDisposition: providerAcceptanceComplete
                    ? null
                    : attempt.failureDisposition,
                  nextAttemptAt: providerAcceptanceComplete
                    ? null
                    : attempt.nextAttemptAt,
                },
              });
              if (providerAcceptanceComplete && mirror && outreach) {
                await tx.outreach.update({
                  where: { id: outreach.id },
                  data: {
                    status: completedOutreachStatus,
                    error: completedError,
                    providerMessageId: primaryProviderMessageId,
                    providerMessageIds,
                    sentAt: earlier(
                      earlier(outreach.sentAt, acceptedAt),
                      attempt.deliveredAt ?? acceptedAt,
                    ),
                    ...(attempt.deliveredAt
                      ? {
                          deliveredAt: earlier(
                            outreach.deliveredAt,
                            attempt.deliveredAt,
                          ),
                        }
                      : {}),
                    scheduledFor: null,
                    nextAttemptAt: null,
                    claimedAt: null,
                    claimToken: null,
                  },
                });
              }
              break;
            }
            case "email.delivered": {
              const deliveredAt = earlier(
                attempt.deliveredAt,
                providerCreatedAt,
              );
              const acceptedAt = earlier(attempt.acceptedAt, deliveredAt);
              await tx.outreachSendAttempt.update({
                where: { id: attempt.id },
                data: {
                  status: hadDeliveryFailure
                    ? providerAcceptanceComplete
                      ? completedAttemptStatus
                      : attempt.status
                    : providerAcceptanceComplete
                      ? "accepted"
                      : attempt.status,
                  acceptedAt,
                  deliveredAt,
                  error:
                    hadDeliveryFailure
                      ? completedError
                      : !providerAcceptanceComplete
                        ? attempt.error
                      : null,
                  failureDisposition: providerAcceptanceComplete
                    ? null
                    : attempt.failureDisposition,
                  nextAttemptAt: providerAcceptanceComplete
                    ? null
                    : attempt.nextAttemptAt,
                },
              });
              if (providerAcceptanceComplete && mirror && outreach) {
                await tx.outreach.update({
                  where: { id: outreach.id },
                  data: {
                    status: completedOutreachStatus,
                    providerMessageId: primaryProviderMessageId,
                    providerMessageIds,
                    sentAt: earlier(
                      earlier(outreach.sentAt, acceptedAt),
                      deliveredAt,
                    ),
                    deliveredAt: earlier(
                      outreach.deliveredAt,
                      deliveredAt,
                    ),
                    error: completedError,
                    scheduledFor: null,
                    nextAttemptAt: null,
                    claimedAt: null,
                    claimToken: null,
                  },
                });
              }
              break;
            }
            case "email.opened":
              await tx.outreachSendAttempt.update({
                where: { id: attempt.id },
                data: {
                  firstOpenedAt: earlier(attempt.firstOpenedAt, providerCreatedAt),
                  lastOpenedAt: later(attempt.lastOpenedAt, providerCreatedAt),
                  openCount: { increment: 1 },
                },
              });
              if (mirror && outreach) {
                await tx.outreach.update({
                  where: { id: outreach.id },
                  data: {
                    firstOpenedAt: earlier(
                      outreach.firstOpenedAt,
                      providerCreatedAt,
                    ),
                    lastOpenedAt: later(
                      outreach.lastOpenedAt,
                      providerCreatedAt,
                    ),
                    openCount: { increment: 1 },
                  },
                });
              }
              break;
            case "email.clicked":
              await tx.outreachSendAttempt.update({
                where: { id: attempt.id },
                data: {
                  firstClickedAt: earlier(
                    attempt.firstClickedAt,
                    providerCreatedAt,
                  ),
                  lastClickedAt: later(
                    attempt.lastClickedAt,
                    providerCreatedAt,
                  ),
                  clickCount: { increment: 1 },
                },
              });
              if (mirror && outreach) {
                await tx.outreach.update({
                  where: { id: outreach.id },
                  data: {
                    firstClickedAt: earlier(
                      outreach.firstClickedAt,
                      providerCreatedAt,
                    ),
                    lastClickedAt: later(
                      outreach.lastClickedAt,
                      providerCreatedAt,
                    ),
                    clickCount: { increment: 1 },
                  },
                });
              }
              break;
            case "email.bounced": {
              const error = suppressionReason(parsed);
              const deliveryFailure = deliveryFailureState(error);
              await tx.outreachSendAttempt.update({
                where: { id: attempt.id },
                data: {
                  providerRequestResults:
                    deliveryFailure.results as Prisma.InputJsonValue,
                  status: deliveryFailure.resolved
                    ? "delivery_failed"
                    : attempt.status,
                  bouncedAt: earlier(
                    attempt.bouncedAt,
                    providerCreatedAt,
                  ),
                  error: deliveryFailure.resolved ? error : attempt.error,
                  failureDisposition: deliveryFailure.resolved
                    ? null
                    : attempt.failureDisposition,
                  nextAttemptAt: deliveryFailure.resolved
                    ? null
                    : attempt.nextAttemptAt,
                },
              });
              if (
                deliveryFailure.resolved &&
                mirrorDeliveryProblem &&
                outreach
              ) {
                await tx.outreach.update({
                  where: { id: outreach.id },
                  data: {
                    bouncedAt: earlier(outreach.bouncedAt, providerCreatedAt),
                    status: "failed",
                    error,
                  },
                });
              }
              break;
            }
            case "email.complained": {
              const error = "complaint";
              const deliveryFailure = deliveryFailureState(error);
              await tx.outreachSendAttempt.update({
                where: { id: attempt.id },
                data: {
                  providerRequestResults:
                    deliveryFailure.results as Prisma.InputJsonValue,
                  status: deliveryFailure.resolved
                    ? "delivery_failed"
                    : attempt.status,
                  complainedAt: earlier(
                    attempt.complainedAt,
                    providerCreatedAt,
                  ),
                  error: deliveryFailure.resolved ? error : attempt.error,
                  failureDisposition: deliveryFailure.resolved
                    ? null
                    : attempt.failureDisposition,
                  nextAttemptAt: deliveryFailure.resolved
                    ? null
                    : attempt.nextAttemptAt,
                },
              });
              if (
                deliveryFailure.resolved &&
                mirrorDeliveryProblem &&
                outreach
              ) {
                await tx.outreach.update({
                  where: { id: outreach.id },
                  data: {
                    complainedAt: earlier(
                      outreach.complainedAt,
                      providerCreatedAt,
                    ),
                    status: "failed",
                    error,
                  },
                });
              }
              break;
            }
            case "email.suppressed": {
              const error = suppressionReason(parsed);
              const deliveryFailure = deliveryFailureState(error);
              await tx.outreachSendAttempt.update({
                where: { id: attempt.id },
                data: {
                  providerRequestResults:
                    deliveryFailure.results as Prisma.InputJsonValue,
                  status: deliveryFailure.resolved
                    ? "delivery_failed"
                    : attempt.status,
                  error: deliveryFailure.resolved ? error : attempt.error,
                  failureDisposition: deliveryFailure.resolved
                    ? null
                    : attempt.failureDisposition,
                  nextAttemptAt: deliveryFailure.resolved
                    ? null
                    : attempt.nextAttemptAt,
                },
              });
              if (
                deliveryFailure.resolved &&
                mirrorDeliveryProblem &&
                outreach
              ) {
                await tx.outreach.update({
                  where: { id: outreach.id },
                  data: { status: "failed", error },
                });
              }
              break;
            }
            case "email.delivery_delayed":
              if (hadDeliveryFailure) break;
              await tx.outreachSendAttempt.update({
                where: { id: attempt.id },
                data: { error: "email.delivery_delayed" },
              });
              if (mirrorDeliveryProblem && outreach) {
                await tx.outreach.update({
                  where: { id: outreach.id },
                  data: { error: "email.delivery_delayed" },
                });
              }
              break;
            case "email.failed": {
              if (hadDeliveryFailure) break;
              const error = "email.failed";
              const deliveryFailure = deliveryFailureState(error);
              await tx.outreachSendAttempt.update({
                where: { id: attempt.id },
                data: {
                  providerRequestResults:
                    deliveryFailure.results as Prisma.InputJsonValue,
                  status: deliveryFailure.resolved
                    ? "delivery_failed"
                    : attempt.status,
                  error: deliveryFailure.resolved ? error : attempt.error,
                  failureDisposition: deliveryFailure.resolved
                    ? null
                    : attempt.failureDisposition,
                  nextAttemptAt: deliveryFailure.resolved
                    ? null
                    : attempt.nextAttemptAt,
                },
              });
              if (
                deliveryFailure.resolved &&
                mirrorDeliveryProblem &&
                outreach
              ) {
                await tx.outreach.update({
                  where: { id: outreach.id },
                  data: { status: "failed", error },
                });
              }
              break;
            }
            default:
              return { note: `unhandled type: ${parsed.type}` };
          }

          return mirror
            ? {}
            : { note: "historical attempt updated; current outreach unchanged" };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          maxWait: 5_000,
          timeout: 15_000,
        },
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (
          error.code === "P2034" &&
          retry < RESEND_WEBHOOK_TRANSACTION_ATTEMPTS - 1
        ) {
          await waitForWebhookRetry(retry);
          continue;
        }
        if (error.code === "P2002") {
          const duplicate = await db.resendWebhookEvent.findUnique({
            where: { eventId },
            select: { eventId: true },
          });
          if (duplicate) return { note: "duplicate event" };
          if (retry < RESEND_WEBHOOK_TRANSACTION_ATTEMPTS - 1) {
            await waitForWebhookRetry(retry);
            continue;
          }
        }
      }
      throw error;
    }
  }
  throw new Error("Unable to process webhook transaction");
}

export async function POST(request: NextRequest) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[resend webhook] RESEND_WEBHOOK_SECRET is not configured");
    return NextResponse.json({ error: "webhook unavailable" }, { status: 503 });
  }

  const eventId = request.headers.get("svix-id");
  if (!eventId) {
    return NextResponse.json({ error: "missing event id" }, { status: 400 });
  }

  try {
    const raw = await request.text();
    const webhook = new Webhook(secret);
    const parsed = webhook.verify(raw, {
      "svix-id": eventId,
      "svix-timestamp": request.headers.get("svix-timestamp") ?? "",
      "svix-signature": request.headers.get("svix-signature") ?? "",
    }) as ResendEvent;
    const result = await processEvent(eventId, parsed);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      console.error("[resend webhook] signature verification failed");
      return NextResponse.json({ error: "invalid signature" }, { status: 401 });
    }
    console.error(
      "[resend webhook] handler failed",
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json({ error: "handler error" }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    message: "Resend webhook — POST events here",
  });
}
