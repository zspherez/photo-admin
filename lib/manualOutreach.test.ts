import assert from "node:assert/strict";
import test from "node:test";
import {
  canMarkOutreachManually,
  isActiveManualOutreachMarker,
  MANUAL_OUTREACH_HTML,
  MANUAL_OUTREACH_SUBJECT,
  manualMarkBlockingReason,
  removeManualOutreachMarker,
  type ManualOutreachMarkerRecord,
} from "./manualOutreach";

const safeRow = {
  status: "failed",
  providerMessageId: null,
  attemptCount: 0,
  sendAttemptCount: 0,
};

test("manual marking allows only histories without protected send state", () => {
  assert.equal(canMarkOutreachManually([]), true);
  assert.equal(canMarkOutreachManually([safeRow]), true);

  for (const status of [
    "sent",
    "scheduled",
    "retry_scheduled",
    "queued",
    "manual_review",
  ]) {
    assert.equal(
      canMarkOutreachManually([{ ...safeRow, status }]),
      false,
      status
    );
  }
  assert.equal(
    canMarkOutreachManually([{ ...safeRow, attemptCount: 1 }]),
    false
  );
  assert.equal(
    manualMarkBlockingReason([{ ...safeRow, providerMessageId: "provider-id" }]),
    "Existing email outreach history requires review"
  );
});

function marker(
  overrides: Partial<ManualOutreachMarkerRecord> = {}
): ManualOutreachMarkerRecord {
  return {
    id: "manual",
    kind: "original",
    showId: "show",
    artistId: "artist",
    status: "sent",
    providerMessageId: null,
    attemptCount: 0,
    sendAttemptCount: 0,
    finalSubject: MANUAL_OUTREACH_SUBJECT,
    finalHtml: MANUAL_OUTREACH_HTML,
    ...overrides,
  };
}

test("active manual marker detection excludes every provider-history signal", () => {
  assert.equal(isActiveManualOutreachMarker(marker()), true);
  assert.equal(
    isActiveManualOutreachMarker(marker({ providerMessageId: "provider" })),
    false
  );
  assert.equal(
    isActiveManualOutreachMarker(marker({ attemptCount: 1 })),
    false
  );
  assert.equal(
    isActiveManualOutreachMarker(marker({ sendAttemptCount: 1 })),
    false
  );
  assert.equal(
    isActiveManualOutreachMarker(marker({ status: "failed" })),
    false
  );
  assert.equal(
    isActiveManualOutreachMarker(marker({ kind: "follow_up" })),
    false,
  );
});

test("unmark changes persisted manual state while preserving provider history", async () => {
  const provider = marker({
    id: "provider",
    providerMessageId: "resend-message",
    attemptCount: 1,
    sendAttemptCount: 1,
    finalSubject: "Real subject",
    finalHtml: "<p>Real email</p>",
  });
  let persisted = [provider, marker()];
  const store = {
    async findById(id: string) {
      return persisted.find((row) => row.id === id) ?? null;
    },
    async deleteActiveMarker(id: string) {
      const before = persisted.length;
      persisted = persisted.filter((row) => row.id !== id);
      return persisted.length === before - 1;
    },
  };

  assert.equal(await removeManualOutreachMarker(store, provider.id), null);
  assert.deepEqual(persisted, [provider, marker()]);

  const removed = await removeManualOutreachMarker(store, "manual");
  assert.equal(removed?.id, "manual");
  assert.deepEqual(persisted, [provider]);
  assert.equal(persisted[0]?.status, "sent");
  assert.equal(persisted[0]?.providerMessageId, "resend-message");
});
