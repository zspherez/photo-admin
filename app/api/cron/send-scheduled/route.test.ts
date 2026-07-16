import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  getScheduledDispatchHttpStatus,
  getScheduledDispatchState,
} from "@/lib/schedule";

const CLEAN = {
  terminalFailures: 0,
  unscheduledRetryableFailures: 0,
  pendingClaims: 0,
  scheduledRetries: 0,
  bounded: false,
};

test("scheduled dispatch summaries distinguish every polling state", () => {
  assert.equal(getScheduledDispatchState(CLEAN), "complete");
  assert.equal(
    getScheduledDispatchState({ ...CLEAN, pendingClaims: 1 }),
    "pending_claims",
  );
  assert.equal(
    getScheduledDispatchState({ ...CLEAN, scheduledRetries: 1 }),
    "scheduled_retries",
  );
  assert.equal(
    getScheduledDispatchState({
      ...CLEAN,
      unscheduledRetryableFailures: 1,
      pendingClaims: 1,
    }),
    "retryable_failure",
  );
  assert.equal(
    getScheduledDispatchState({
      ...CLEAN,
      terminalFailures: 1,
      pendingClaims: 1,
    }),
    "terminal_failure",
  );
  assert.equal(
    getScheduledDispatchState({ ...CLEAN, bounded: true }),
    "bounded",
  );

  assert.equal(getScheduledDispatchHttpStatus("complete"), 200);
  assert.equal(getScheduledDispatchHttpStatus("pending_claims"), 202);
  assert.equal(getScheduledDispatchHttpStatus("retryable_failure"), 503);
  assert.equal(getScheduledDispatchHttpStatus("terminal_failure"), 500);
});

test("fresh queued claims remain visible until their claim expiry", () => {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

  assert.match(
    source,
    /status: "queued",\s+claimedAt: \{ gt: staleBefore \}/,
  );
  assert.match(
    source,
    /claimSummary\._min\.claimedAt\.getTime\(\) \+ OUTREACH_CLAIM_TIMEOUT_MS/,
  );
  assert.match(source, /pendingClaims,/);
  assert.match(source, /nextClaimExpiryAt,/);
  assert.match(source, /scheduledRetries,/);
  assert.match(source, /complete: state === "complete"/);
});
