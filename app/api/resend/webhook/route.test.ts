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
