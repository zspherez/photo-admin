import assert from "node:assert/strict";
import test from "node:test";
import { db } from "./db";
import { resetBouncedOutreachForResend } from "./sendOutreach";

test("reviewed bounce reset rotates identity only after release and current suppression checks", async (t) => {
  const bouncedAt = new Date("2026-09-16T14:00:00Z");
  const email = "manager@example.com";
  let suppressed = false;
  let released = true;
  let resetCount = 0;
  const tx = {
    $queryRaw: async () => [{ locked: 1 }],
    outreach: {
      findUnique: async () => ({
        id: "outreach", kind: "follow_up", artistId: "artist",
        status: "failed", idempotencyKey: "old-key", bouncedAt,
        recipientEmails: [email], fullTeamSend: false,
        festivalAllContactsSend: false, coveredArtists: [],
      }),
      updateMany: async ({ where, data }: {
        where: { id: string; status: string; idempotencyKey: string };
        data: { status: string; idempotencyKey: string; contactId: string; attemptCount: number };
      }) => {
        assert.deepEqual(where, { id: "outreach", status: "failed", idempotencyKey: "old-key" });
        assert.equal(data.status, "cancelled");
        assert.notEqual(data.idempotencyKey, "old-key");
        assert.equal(data.contactId, "contact");
        assert.equal(data.attemptCount, 0);
        resetCount++;
        return { count: 1 };
      },
    },
    outreachSendAttempt: {
      findUnique: async () => ({
        id: "attempt", status: "delivery_failed", testSend: false,
        providerMessageId: "provider", acceptedAt: new Date("2026-09-16T13:00:00Z"),
        webhookEvents: [{ recipientEmails: [email] }],
      }),
    },
    contact: {
      findUnique: async () => ({ artistId: "artist", email, state: "active" }),
      findMany: async () => [{ artistId: "artist", email, state: "active" }],
    },
    emailSuppression: {
      findMany: async () => suppressed ? [{ normalizedEmail: email }] : [],
    },
    emailSuppressionRelease: {
      findMany: async ({ where }: {
        where: { normalizedEmail: { in: string[] }; suppressedAt: { gte: Date }; createdAt: { gte: Date } };
      }) => {
        assert.deepEqual(where, {
          normalizedEmail: { in: [email] },
          suppressedAt: { gte: bouncedAt },
          createdAt: { gte: bouncedAt },
        });
        return released ? [{ normalizedEmail: email }] : [];
      },
    },
  };
  const original = db.$transaction;
  Object.defineProperty(db, "$transaction", {
    configurable: true, writable: true,
    value: (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  });
  t.after(() => Object.defineProperty(db, "$transaction", {
    configurable: true, writable: true, value: original,
  }));
  const review = { expectedIdempotencyKey: "old-key", allowReleasedRecipients: true };
  assert.deepEqual(await resetBouncedOutreachForResend("outreach", "contact", review), { ok: true });
  assert.equal(resetCount, 1);
  suppressed = true;
  assert.equal((await resetBouncedOutreachForResend("outreach", "contact", review)).ok, false);
  suppressed = false;
  released = false;
  assert.equal((await resetBouncedOutreachForResend("outreach", "contact", review)).ok, false);
  released = true;
  assert.equal((await resetBouncedOutreachForResend("outreach", "contact")).ok, false);
  assert.equal((await resetBouncedOutreachForResend("outreach", "contact", {
    ...review, expectedIdempotencyKey: "stale-key",
  })).ok, false);
  assert.equal(resetCount, 1);
});
