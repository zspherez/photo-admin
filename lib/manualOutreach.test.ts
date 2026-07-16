import assert from "node:assert/strict";
import test from "node:test";
import {
  canMarkOutreachManually,
  manualMarkBlockingReason,
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
