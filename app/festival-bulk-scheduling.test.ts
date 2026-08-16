import assert from "node:assert/strict";
import test from "node:test";
import { nextScheduledOutreachPoll } from "./festivals/[showId]/page";

test("next scheduled outreach poll follows the ten-minute offset", () => {
  assert.equal(
    nextScheduledOutreachPoll(
      new Date("2026-08-14T15:03:30.000Z"),
    ).toISOString(),
    "2026-08-14T15:07:00.000Z",
  );
  assert.equal(
    nextScheduledOutreachPoll(
      new Date("2026-08-14T15:07:01.000Z"),
    ).toISOString(),
    "2026-08-14T15:17:00.000Z",
  );
});

test("late Friday next poll lands on Saturday for weekend rollover", () => {
  assert.equal(
    nextScheduledOutreachPoll(
      new Date("2026-08-15T03:58:00.000Z"),
    ).toISOString(),
    "2026-08-15T04:07:00.000Z",
  );
});

test("a due time just after Friday's final poll rolls to Saturday's poll", () => {
  const immediateSchedule = new Date("2026-08-15T03:57:30.000Z");
  assert.equal(
    nextScheduledOutreachPoll(immediateSchedule).toISOString(),
    "2026-08-15T04:07:00.000Z",
  );
});

test("Friday's final poll window extends into Saturday", () => {
  const poll = new Date("2026-08-15T03:57:00.000Z");
  assert.equal(
    new Date(poll.getTime() + 15 * 60 * 1000).toISOString(),
    "2026-08-15T04:12:00.000Z",
  );
});
