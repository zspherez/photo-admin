import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  formatNextDispatchActionLabel,
  getNextMondaySlot,
  getNextNormalOutreachDispatch,
  getOutreachRecoveryCutoff,
  getScheduledDispatchDisposition,
  isOutreachMorningDispatchWindow,
  isStaleOutreachClaim,
  isWeekendET,
  OUTREACH_CLAIM_TIMEOUT_MS,
  OUTREACH_MORNING_DISPATCH_HOUR,
  OUTREACH_MORNING_DISPATCH_LABEL,
  OUTREACH_MORNING_UTC_CANDIDATE_HOURS,
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

test("next normal dispatch uses the same weekday morning before cutoff", () => {
  assert.equal(
    getNextNormalOutreachDispatch(
      new Date("2026-07-20T12:59:59.000Z"),
    ).toISOString(),
    "2026-07-20T13:00:00.000Z",
  );
  assert.equal(
    getNextNormalOutreachDispatch(
      new Date("2026-07-20T13:00:00.000Z"),
    ).toISOString(),
    "2026-07-21T13:00:00.000Z",
  );
});

test("next normal dispatch advances nights and weekends to a weekday", () => {
  assert.equal(
    getNextNormalOutreachDispatch(
      new Date("2026-07-21T02:30:00.000Z"),
    ).toISOString(),
    "2026-07-21T13:00:00.000Z",
  );
  assert.equal(
    getNextNormalOutreachDispatch(
      new Date("2026-07-25T02:30:00.000Z"),
    ).toISOString(),
    "2026-07-27T13:00:00.000Z",
  );
  assert.equal(
    getNextNormalOutreachDispatch(
      new Date("2026-07-25T16:00:00.000Z"),
    ).toISOString(),
    "2026-07-27T13:00:00.000Z",
  );
  assert.equal(
    getNextNormalOutreachDispatch(
      new Date("2026-07-26T16:00:00.000Z"),
    ).toISOString(),
    "2026-07-27T13:00:00.000Z",
  );
});

test("next normal dispatch is DST-safe across spring and fall boundaries", () => {
  assert.equal(
    getNextNormalOutreachDispatch(
      new Date("2026-03-06T15:30:00.000Z"),
    ).toISOString(),
    "2026-03-09T13:00:00.000Z",
  );
  assert.equal(
    getNextNormalOutreachDispatch(
      new Date("2026-10-30T14:30:00.000Z"),
    ).toISOString(),
    "2026-11-02T14:00:00.000Z",
  );
});

test("next dispatch label uses the shared cadence", () => {
  assert.equal(OUTREACH_MORNING_DISPATCH_LABEL, "9:00 AM ET");
  assert.equal(
    formatNextDispatchActionLabel(new Date("2026-07-20T13:00:00.000Z")),
    "Queue for Mon 9:00 AM ET",
  );
});

test("morning dispatch window is explicit and DST-safe", () => {
  assert.equal(
    isOutreachMorningDispatchWindow(new Date("2026-03-09T13:30:00Z")),
    true,
  );
  assert.equal(
    isOutreachMorningDispatchWindow(new Date("2026-03-09T14:00:00Z")),
    false,
  );
  assert.equal(
    isOutreachMorningDispatchWindow(new Date("2026-11-02T14:30:00Z")),
    true,
  );
  assert.equal(
    isOutreachMorningDispatchWindow(new Date("2026-11-02T13:30:00Z")),
    false,
  );
  assert.equal(
    isOutreachMorningDispatchWindow(new Date("2026-11-07T14:30:00Z")),
    false,
  );
});

test("recovery waits until normal scheduled outreach is two hours overdue", () => {
  assert.equal(
    getOutreachRecoveryCutoff(
      new Date("2026-07-20T17:00:00.000Z"),
    ).toISOString(),
    "2026-07-20T15:00:00.000Z",
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

test("normal morning dispatch and exceptional recovery stay distinct", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/send-scheduled.yml", import.meta.url),
    "utf8",
  );
  const route = readFileSync(
    new URL("../app/api/cron/send-scheduled/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /cron: "0 13 \* \* 1-5"/);
  assert.match(workflow, /cron: "0 14 \* \* 1-5"/);
  assert.match(workflow, /cron: "17 \*\/4 \* \* \*"/);
  assert.match(workflow, /TZ=America\/New_York/);
  assert.match(workflow, /local_hour.*!= "09"/);
  assert.deepEqual(OUTREACH_MORNING_UTC_CANDIDATE_HOURS, [13, 14]);
  assert.equal(OUTREACH_MORNING_DISPATCH_HOUR, 9);
  for (const candidateHour of OUTREACH_MORNING_UTC_CANDIDATE_HOURS) {
    assert.ok(
      workflow.includes(`cron: "0 ${candidateHour} * * 1-5"`),
    );
  }
  assert.match(
    workflow,
    new RegExp(
      `local_hour.*!= "${String(OUTREACH_MORNING_DISPATCH_HOUR).padStart(2, "0")}"`,
    ),
  );
  assert.match(workflow, /dispatch_mode="morning"/);
  assert.match(workflow, /dispatch_mode="recovery"/);
  assert.match(workflow, /send-scheduled\?mode=\$\{dispatch_mode\}/);
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
  assert.match(
    workflow,
    /exceptional four-hour recovery schedule will continue recovery/,
  );
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
  assert.match(
    route,
    /status: "scheduled",\s+nextAttemptAt: \{\s+lte: mode === "recovery" \? recoveryCutoff : now/,
  );
  assert.match(
    route,
    /status: "retry_scheduled",\s+nextAttemptAt: \{ lte: now \}/,
  );
  assert.match(
    route,
    /status: "queued",\s+nextAttemptAt: \{ lte: now \},\s+OR:/,
  );
  assert.match(
    route,
    /status: "sending",\s+nextAttemptAt: \{ lte: now \},\s+claimedAt: \{ lte: staleBefore \}/,
  );
  assert.match(route, /isOutreachMorningDispatchWindow\(\)/);
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
