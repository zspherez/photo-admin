import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  RESEND_WEBHOOK_LOCK_CLASS,
  resendWebhookSerializationKeys,
} from "./route";

test("webhook events serialize by every stable correlation identity", () => {
  const event = {
    type: "email.delivered",
    created_at: "2026-07-29T18:00:00.000Z",
    data: {
      email_id: "message-1",
      tags: [
        { name: "outreach_id", value: "outreach-1" },
        { name: "outreach_attempt_id", value: "attempt-1" },
      ],
    },
  };
  assert.deepEqual(
    resendWebhookSerializationKeys("event-1", event),
    [
      "attempt:attempt-1",
      "message:message-1",
      "outreach:outreach-1",
    ],
  );
  assert.equal(Number.isInteger(RESEND_WEBHOOK_LOCK_CLASS), true);
});

test("webhook transaction lock is first and retries conflicts with backoff", () => {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  const transaction = source.slice(
    source.indexOf("return await db.$transaction"),
    source.indexOf("const attemptId = findAttemptId", source.indexOf("return await db.$transaction")),
  );
  assert.match(transaction, /acquireResendWebhookSerializationLocks/);
  assert.match(source, /RESEND_WEBHOOK_TRANSACTION_ATTEMPTS = 8/);
  assert.match(source, /error\.code === "P2034"/);
  assert.match(source, /await waitForWebhookRetry\(retry\)/);
  assert.match(
    source,
    /isolationLevel: Prisma\.TransactionIsolationLevel\.ReadCommitted/,
  );
  assert.match(source, /timeout: 15_000/);
});

test("webhook event rows persist sanitized click metadata in every correlation path", () => {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  assert.match(source, /resendClickMetadata\(\s*parsed\.type,\s*parsed\.data\.click/);
  assert.ok((source.match(/\.\.\.clickMetadata/g)?.length ?? 0) >= 3);
  assert.doesNotMatch(source, /ipAddress|userAgent/);
});

test("webhooks correlate every message in an immutable outreach batch", () => {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  assert.match(source, /providerMessageIds: \{ has: messageId \}/);
  assert.match(source, /findMessageIndex\(parsed\)/);
  assert.match(source, /bindProviderMessageIdAtIndex/);
  assert.match(source, /providerAcceptanceComplete/);
  assert.match(source, /providerMessageIds,/);
  assert.match(source, /outreachWebhookRecipientImpact/);
  assert.match(
    source,
    /auxiliary outreach recipient webhook recorded without aggregate mutation/,
  );
});

test("same-index webhook ID conflicts preserve immutable identity and stop retries", () => {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  assert.match(source, /bindProviderMessageIdAtIndex/);
  assert.match(
    source,
    /if \(binding\.conflict\)[\s\S]*status: "manual_review"[\s\S]*failureDisposition: "policy"[\s\S]*nextAttemptAt: null/,
  );
  assert.match(
    source,
    /outreach\?\.idempotencyKey === attempt\.idempotencyKey[\s\S]*status: "manual_review"/,
  );
  assert.match(
    source,
    /if \(correlation\.status === "matched"\) \{[\s\S]*providerMessageIds,[\s\S]*providerRequestResults:/,
  );
  assert.match(source, /conflictedAttempt = attempt/);
  assert.match(source, /eventAttempt = matchedAttempt \?\? conflictedAttempt/);
  assert.match(source, /outreachId: eventAttempt\?\.outreachId/);
  assert.match(source, /attemptId: eventAttempt\?\.id/);
});

test("individual-mode BCC opens, clicks, and failures record without aggregate mutation", () => {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  const auxiliaryGuard = source.indexOf(
    "auxiliary outreach recipient webhook recorded without aggregate mutation",
  );
  assert.ok(auxiliaryGuard >= 0);
  const suppression = source.lastIndexOf("applySuppression(", auxiliaryGuard);
  assert.ok(suppression >= 0 && suppression < auxiliaryGuard);
  assert.ok(auxiliaryGuard < source.indexOf('case "email.opened"', auxiliaryGuard));
  assert.ok(auxiliaryGuard < source.indexOf('case "email.clicked"', auxiliaryGuard));
  assert.ok(auxiliaryGuard < source.indexOf('case "email.failed"', auxiliaryGuard));
});

test("BCC-only bounce and complaint events suppress before skipping aggregates", () => {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  const auxiliaryGuard = source.indexOf(
    "auxiliary outreach recipient webhook recorded without aggregate mutation",
  );
  const suppression = source.lastIndexOf("applySuppression(", auxiliaryGuard);
  assert.ok(suppression >= 0 && suppression < auxiliaryGuard);
  assert.match(source, /failurePolicy\.applySuppression/);
  assert.match(source, /parsed\.type !== "email\.bounced"/);
  assert.match(source, /parsed\.type !== "email\.complained"/);
});

test("provider identity quarantine remains sticky after later valid batch webhooks", () => {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  assert.match(source, /isProviderMessageIdConflictError\(attempt\.error\)/);
  assert.match(
    source,
    /provider identity conflict remains quarantined pending explicit resolution/,
  );
  const stickyGuard = source.indexOf(
    "provider identity conflict remains quarantined pending explicit resolution",
  );
  assert.ok(stickyGuard < source.indexOf("providerAcceptanceComplete", stickyGuard));
});

test("partial accepted delivery failures preserve unresolved batch retry state", () => {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  assert.match(source, /markResendRequestDeliveryFailure/);
  assert.match(source, /resendRequestResultsAreResolved/);
  assert.match(
    source,
    /status: deliveryFailure\.resolved[\s\S]*"delivery_failed"[\s\S]*attempt\.status/,
  );
  assert.match(
    source,
    /nextAttemptAt: deliveryFailure\.resolved[\s\S]*null[\s\S]*attempt\.nextAttemptAt/,
  );
  assert.match(
    source,
    /bouncedAt: earlier\(\s*attempt\.bouncedAt,\s*providerCreatedAt/,
  );
  assert.match(
    source,
    /complainedAt: earlier\(\s*attempt\.complainedAt,\s*providerCreatedAt/,
  );
  assert.match(
    source,
    /hadDeliveryFailure && attempt\.bouncedAt[\s\S]*outreach\.bouncedAt/,
  );
  assert.match(
    source,
    /hadDeliveryFailure && attempt\.complainedAt[\s\S]*outreach\.complainedAt/,
  );
});

test("webhook completion merges delivery observed before final batch acceptance", () => {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  assert.ok(
    (source.match(/attempt\.deliveredAt/g)?.length ?? 0) >= 4,
  );
  assert.match(
    source,
    /deliveredAt: earlier\(\s*outreach\.deliveredAt,\s*attempt\.deliveredAt/,
  );
  assert.match(
    source,
    /deliveredAt: earlier\(\s*earlier\(\s*outreach\.deliveredAt,\s*attempt\.deliveredAt \?\? providerCreatedAt/,
  );
});
