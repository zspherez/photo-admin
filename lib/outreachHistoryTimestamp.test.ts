import assert from "node:assert/strict";
import test from "node:test";
import { outreachHistoryTimestamp } from "./outreachHistoryTimestamp";

const createdAt = new Date("2026-09-24T16:54:00Z");
const scheduledFor = new Date("2026-09-24T16:55:00Z");
const base = {
  status: "scheduled",
  createdAt,
  scheduledFor,
  nextAttemptAt: scheduledFor,
  sentAt: null,
};

test("scheduled outreach shows its dispatch time in the configured timezone, not UTC creation time", () => {
  assert.deepEqual(outreachHistoryTimestamp(base, "America/New_York"), {
    date: scheduledFor,
    label: "Scheduled",
    text: "Sep 24, 12:55 PM",
  });
});

test("retries show their next attempt while sent and unsent rows retain their own timestamps", () => {
  const retryAt = new Date("2026-09-24T17:30:00Z");
  assert.equal(
    outreachHistoryTimestamp(
      { ...base, status: "retry_scheduled", nextAttemptAt: retryAt },
      "America/New_York",
    ).text,
    "Sep 24, 1:30 PM",
  );
  assert.equal(
    outreachHistoryTimestamp(
      { ...base, status: "sent", sentAt: retryAt },
      "America/New_York",
    ).label,
    "Sent",
  );
  assert.equal(
    outreachHistoryTimestamp(
      { ...base, status: "failed" },
      "America/New_York",
    ).date,
    createdAt,
  );
});
