import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  getScheduledDispatchDisposition,
  getNextMondaySlot,
  isStaleOutreachClaim,
  isWeekendET,
  OUTREACH_CLAIM_TIMEOUT_MS,
  OUTREACH_PROVIDER_TRANSACTION_TIMEOUT_MS,
  SCHEDULED_DISPATCH_MAX_MS,
  SCHEDULED_DISPATCH_ROUTE_TIMEOUT_MS,
  SCHEDULED_DISPATCH_TRANSACTION_RESPONSE_MARGIN_MS,
  shouldContinueScheduledDispatch,
} from "./schedule";

test("weekend detection uses Eastern Time", () => {
  assert.equal(isWeekendET(new Date("2026-07-18T03:30:00Z")), false);
  assert.equal(isWeekendET(new Date("2026-07-18T04:30:00Z")), true);
});

test("next Monday slot handles daylight saving time", () => {
  assert.equal(
    getNextMondaySlot(new Date("2026-07-18T16:00:00Z")).toISOString(),
    "2026-07-20T13:00:00.000Z"
  );
  assert.equal(
    getNextMondaySlot(new Date("2026-12-05T16:00:00Z")).toISOString(),
    "2026-12-07T14:00:00.000Z"
  );
});

test("claim and dispatch bounds are deterministic", () => {
  const now = new Date("2026-07-16T04:00:00Z");
  assert.equal(
    isStaleOutreachClaim(
      new Date(now.getTime() - OUTREACH_CLAIM_TIMEOUT_MS + 1),
      now
    ),
    false
  );
  assert.equal(
    isStaleOutreachClaim(
      new Date(now.getTime() - OUTREACH_CLAIM_TIMEOUT_MS),
      now
    ),
    true
  );
  assert.equal(
    SCHEDULED_DISPATCH_MAX_MS +
      OUTREACH_PROVIDER_TRANSACTION_TIMEOUT_MS +
      SCHEDULED_DISPATCH_TRANSACTION_RESPONSE_MARGIN_MS,
    SCHEDULED_DISPATCH_ROUTE_TIMEOUT_MS,
  );
  assert.equal(SCHEDULED_DISPATCH_MAX_MS, 20_000);
  assert.equal(shouldContinueScheduledDispatch(1_000, 99, 20_999), true);
  assert.equal(shouldContinueScheduledDispatch(1_000, 100, 1_001), false);
  assert.equal(shouldContinueScheduledDispatch(1_000, 0, 21_000), false);
  assert.equal(
    getScheduledDispatchDisposition({ ok: true }),
    "success",
  );
  assert.equal(
    getScheduledDispatchDisposition({ ok: true, skipped: true }),
    "skipped",
  );
  assert.equal(
    getScheduledDispatchDisposition({ ok: false, retryScheduled: true }),
    "retryable",
  );
  assert.equal(
    getScheduledDispatchDisposition({ ok: false }),
    "terminal",
  );
});

test("scheduled retry polling continues evenings and weekends within bounds", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/send-scheduled.yml", import.meta.url),
    "utf8",
  );
  const route = readFileSync(
    new URL("../app/api/cron/send-scheduled/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /cron: "\*\/15 13-15 \* \* 1-5"/);
  assert.match(workflow, /cron: "17 \*\/4 \* \* \*"/);
  assert.match(
    workflow,
    /group: photo-admin-send-scheduled\s+cancel-in-progress: false/,
  );
  assert.match(workflow, /timeout-minutes: 20/);
  assert.match(workflow, /deadline=\$\(\(SECONDS \+ 15 \* 60\)\)/);
  assert.match(workflow, /\.state \|/);
  assert.match(workflow, /\.pendingClaims/);
  assert.match(workflow, /\.scheduledRetries/);
  assert.match(workflow, /\.nextClaimExpiryAt/);
  assert.match(workflow, /next_retry_at/);
  assert.match(workflow, /poll_delay > 300/);
  assert.match(workflow, /max_response_polls=8/);
  assert.match(workflow, /four-hour safety schedule will continue recovery/);
  assert.match(workflow, /terminal_failures_seen=0/);
  assert.match(workflow, /\.terminalFailures/);
  assert.match(workflow, /\.retryableFailures/);
  assert.match(
    workflow,
    /terminal_failures_seen=\$\(\(terminal_failures_seen \+ terminal_failures\)\)/,
  );
  assert.match(
    workflow,
    /pending_claims == 0 && unscheduled_retryable_failures == 0/,
  );
  assert.match(workflow, /claims remained unresolved through the polling deadline/);
  assert.ok(
    workflow.indexOf('if [[ "${structured_response}" == "true" ]]') <
      workflow.indexOf("retryable=false"),
  );

  assert.match(
    route,
    /status: "queued",\s+claimedAt: \{ gt: staleBefore \}/,
  );
  assert.match(route, /export const maxDuration = 60/);
  assert.match(route, /nextRetryAt,/);
  assert.match(route, /nextClaimExpiryAt,/);
  assert.match(route, /pendingClaims,/);
  assert.match(route, /scheduledRetries,/);
  assert.match(route, /complete: state === "complete"/);
  assert.match(
    route,
    /const bounded = !shouldContinueScheduledDispatch\(/,
  );
  assert.match(route, /terminalFailures,/);
  assert.match(route, /retryableFailures,/);
  assert.match(route, /disposition: "retryable"/);
  assert.match(route, /status: getScheduledDispatchHttpStatus\(state\)/);
});
