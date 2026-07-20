import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { Webhook, WebhookVerificationError } from "svix";
import { db } from "@/lib/db";
import {
  canBindResendWebhookProviderMessage,
  correlateResendWebhookAttempt,
  getResendWebhookFailurePolicy,
  normalizeEmails,
  shouldMirrorResendAttempt,
} from "@/lib/resend";
import { acquireOutreachRecipientPolicyLocks } from "@/lib/outreachPolicyLocks";
import { arbitraryEmailEventUpdate } from "@/lib/arbitraryEmail";

interface ResendEvent {
  type: string;
  created_at: string;
  data: {
    created_at?: string;
    email_id?: string;
    to?: string[];
    tags?: Record<string, string> | { name: string; value: string }[];
    headers?: { name: string; value: string }[];
    click?: { link?: string; timestamp?: string };
    bounce?: { message?: string; subType?: string; type?: string };
    suppressed?: { message?: string; type?: string };
  };
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
): Promise<void> {
  if (
    parsed.type !== "email.bounced" &&
    parsed.type !== "email.complained" &&
    parsed.type !== "email.suppressed"
  ) {
    return;
  }

  const reason = suppressionReason(parsed);
  const normalizedEmails = normalizeEmails(parsed.data.to ?? []);
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
  for (let retry = 0; retry < 4; retry += 1) {
    try {
      return await db.$transaction(
        async (tx) => {
          const attemptId = findAttemptId(parsed);
          const outreachId = findOutreachId(parsed);
          const arbitraryEmailId = findArbitraryEmailId(parsed);
          const messageId = parsed.data.email_id ?? null;
          const providerCreatedAt = eventDate(parsed);

          const [taggedArbitraryEmail, messageArbitraryEmail] =
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
            ]);
          if (arbitraryEmailId || messageArbitraryEmail) {
            const arbitraryEmail =
              taggedArbitraryEmail ?? messageArbitraryEmail;
            const conflict =
              !arbitraryEmail
                ? "arbitrary email not found"
                : taggedArbitraryEmail &&
                    messageArbitraryEmail &&
                    taggedArbitraryEmail.id !== messageArbitraryEmail.id
                  ? "arbitrary email tag conflicts with provider message"
                  : messageId &&
                      arbitraryEmail.providerMessageId &&
                      arbitraryEmail.providerMessageId !== messageId
                    ? "provider message conflicts with arbitrary email"
                    : null;
            if (!arbitraryEmail || conflict) {
              await tx.resendWebhookEvent.create({
                data: {
                  eventId,
                  type: parsed.type,
                  providerMessageId: messageId,
                  recipientEmails: normalizeEmails(parsed.data.to ?? []),
                  providerCreatedAt,
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

            if (messageId && !arbitraryEmail.providerMessageId) {
              await tx.arbitraryEmail.update({
                where: { id: arbitraryEmail.id },
                data: { providerMessageId: messageId },
              });
            }
            await tx.resendWebhookEvent.create({
              data: {
                eventId,
                type: parsed.type,
                providerMessageId: messageId,
                recipientEmails: normalizeEmails(parsed.data.to ?? []),
                providerCreatedAt,
                arbitraryEmailId: arbitraryEmail.id,
                correlationStatus: "matched",
              },
            });
            if (!arbitraryEmail.testSend) {
              await applySuppression(tx, eventId, parsed, providerCreatedAt);
            }
            const update = arbitraryEmailEventUpdate(
              arbitraryEmail,
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
            return {};
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
                ? tx.outreachSendAttempt.findUnique({
                    where: { providerMessageId: messageId },
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
          let quarantinedAttemptEvent =
            correlation.status !== "matched" && taggedLegacyAttempt !== null;

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

          if (
            correlation.status === "matched" &&
            correlation.bindProviderMessageId &&
            messageId
          ) {
            await tx.outreachSendAttempt.updateMany({
              where: {
                id: correlation.attempt.id,
                providerMessageId: null,
              },
              data: { providerMessageId: messageId },
            });
            const rebound = await tx.outreachSendAttempt.findUnique({
              where: { id: correlation.attempt.id },
            });
            if (!rebound || rebound.providerMessageId !== messageId) {
              correlation = {
                status: "conflict",
                reason: "provider message could not be bound to the immutable attempt",
              };
            } else {
              correlation = {
                status: "matched",
                attempt: rebound,
                bindProviderMessageId: false,
              };
            }
          }

          const matchedAttempt =
            correlation.status === "matched" ? correlation.attempt : null;
          await tx.resendWebhookEvent.create({
            data: {
              eventId,
              type: parsed.type,
              providerMessageId: messageId,
              recipientEmails: normalizeEmails(parsed.data.to ?? []),
              providerCreatedAt,
              outreachId: matchedAttempt?.outreachId ?? null,
              attemptId: matchedAttempt?.id ?? null,
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
            await applySuppression(tx, eventId, parsed, providerCreatedAt);
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
          const outreach = await tx.outreach.findUnique({
            where: { id: attempt.outreachId },
          });
          const mirror =
            !!outreach && shouldMirrorResendAttempt(outreach, attempt);
          const mirrorDeliveryProblem =
            mirror && failurePolicy.mirrorOutreachFailure;
          const hadDeliveryFailure = attempt.status === "delivery_failed";

          if (attempt.providerMessageId) {
            const acceptedAt = earlier(attempt.acceptedAt, providerCreatedAt);
            await tx.outreachSendAttempt.update({
              where: { id: attempt.id },
              data: {
                status: hadDeliveryFailure ? attempt.status : "accepted",
                acceptedAt,
                error: hadDeliveryFailure ? attempt.error : null,
                failureDisposition: hadDeliveryFailure
                  ? attempt.failureDisposition
                  : null,
                nextAttemptAt: null,
              },
            });
            if (mirror && outreach) {
              await tx.outreach.update({
                where: { id: outreach.id },
                data: {
                  status: hadDeliveryFailure
                    ? outreach.status
                    : attempt.testSend
                      ? "test"
                      : "sent",
                  error: hadDeliveryFailure ? outreach.error : null,
                  providerMessageId: attempt.providerMessageId,
                  sentAt: earlier(outreach.sentAt, acceptedAt),
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
                providerMessageId: attempt.providerMessageId,
                sentAt:
                  outreach.sentAt ??
                  attempt.acceptedAt ??
                  providerCreatedAt,
                scheduledFor: null,
                nextAttemptAt: null,
                claimedAt: null,
                claimToken: null,
              },
            });
          }

          switch (parsed.type) {
            case "email.sent": {
              const acceptedAt = earlier(attempt.acceptedAt, providerCreatedAt);
              await tx.outreachSendAttempt.update({
                where: { id: attempt.id },
                data: {
                  status: hadDeliveryFailure ? attempt.status : "accepted",
                  error: hadDeliveryFailure ? attempt.error : null,
                  acceptedAt,
                  failureDisposition: hadDeliveryFailure
                    ? attempt.failureDisposition
                    : null,
                  nextAttemptAt: null,
                },
              });
              if (mirror && outreach) {
                await tx.outreach.update({
                  where: { id: outreach.id },
                  data: {
                    status: hadDeliveryFailure
                      ? outreach.status
                      : attempt.testSend
                        ? "test"
                        : "sent",
                    error: hadDeliveryFailure ? outreach.error : null,
                    providerMessageId: attempt.providerMessageId,
                    sentAt: earlier(outreach.sentAt, acceptedAt),
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
              await tx.outreachSendAttempt.update({
                where: { id: attempt.id },
                data: {
                  status: hadDeliveryFailure ? attempt.status : "accepted",
                  acceptedAt: attempt.acceptedAt ?? providerCreatedAt,
                  deliveredAt: earlier(attempt.deliveredAt, providerCreatedAt),
                  error: hadDeliveryFailure ? attempt.error : null,
                  failureDisposition: hadDeliveryFailure
                    ? attempt.failureDisposition
                    : null,
                  nextAttemptAt: null,
                },
              });
              if (mirror && outreach) {
                await tx.outreach.update({
                  where: { id: outreach.id },
                  data: {
                    status: hadDeliveryFailure
                      ? outreach.status
                      : attempt.testSend
                        ? "test"
                        : "sent",
                    providerMessageId: attempt.providerMessageId,
                    sentAt: outreach.sentAt ?? providerCreatedAt,
                    deliveredAt: earlier(outreach.deliveredAt, providerCreatedAt),
                    error: hadDeliveryFailure ? outreach.error : null,
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
              await tx.outreachSendAttempt.update({
                where: { id: attempt.id },
                data: {
                  status: "delivery_failed",
                  bouncedAt: earlier(attempt.bouncedAt, providerCreatedAt),
                  error,
                },
              });
              if (mirrorDeliveryProblem && outreach) {
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
            case "email.complained":
              await tx.outreachSendAttempt.update({
                where: { id: attempt.id },
                data: {
                  status: "delivery_failed",
                  complainedAt: earlier(
                    attempt.complainedAt,
                    providerCreatedAt,
                  ),
                  error: "complaint",
                },
              });
              if (mirrorDeliveryProblem && outreach) {
                await tx.outreach.update({
                  where: { id: outreach.id },
                  data: {
                    complainedAt: earlier(
                      outreach.complainedAt,
                      providerCreatedAt,
                    ),
                    status: "failed",
                    error: "complaint",
                  },
                });
              }
              break;
            case "email.suppressed": {
              const error = suppressionReason(parsed);
              await tx.outreachSendAttempt.update({
                where: { id: attempt.id },
                data: { status: "delivery_failed", error },
              });
              if (mirrorDeliveryProblem && outreach) {
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
            case "email.failed":
              if (hadDeliveryFailure) break;
              await tx.outreachSendAttempt.update({
                where: { id: attempt.id },
                data: { status: "delivery_failed", error: "email.failed" },
              });
              if (mirrorDeliveryProblem && outreach) {
                await tx.outreach.update({
                  where: { id: outreach.id },
                  data: { status: "failed", error: "email.failed" },
                });
              }
              break;
            default:
              return { note: `unhandled type: ${parsed.type}` };
          }

          return mirror
            ? {}
            : { note: "historical attempt updated; current outreach unchanged" };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === "P2034" && retry < 3) continue;
        if (error.code === "P2002") {
          const duplicate = await db.resendWebhookEvent.findUnique({
            where: { eventId },
            select: { eventId: true },
          });
          if (duplicate) return { note: "duplicate event" };
          if (retry < 3) continue;
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
