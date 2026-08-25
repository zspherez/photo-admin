import assert from "node:assert/strict";
import test from "node:test";
import {
  eligibleFestivalFollowUp,
  nextScheduledOutreachPoll,
} from "./festivals/[showId]/page";
import type { FollowUpEligibility } from "@/lib/sendOutreach";

function followUpEligibility(
  parentOutreachId: string,
  eligible: boolean,
): FollowUpEligibility {
  return {
    parentOutreachId,
    eligible,
    state: eligible ? "eligible" : "pending",
    mode: eligible ? "new" : null,
    reason: eligible ? null : "Follow-up already pending",
    recipients: ["manager@example.com"],
    recipientDeliveryMode: "to_thread",
    primaryRecipientEmail: null,
    toRecipients: ["manager@example.com"],
    ccRecipients: [],
    providerLayouts: [{ to: ["manager@example.com"], cc: [] }],
    testSend: false,
    fullTeamSend: false,
    contactId: "contact-1",
  };
}

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

test("bulk follow-up selection uses the newest eligible parent consistently", () => {
  const newest = followUpEligibility("parent-new", true);
  const older = followUpEligibility("parent-old", true);
  const parentOutreaches = [
    {
      id: "parent-old",
      artistId: "artist-1",
      createdAt: new Date("2026-08-01T12:00:00.000Z"),
      coveredArtists: [],
    },
    {
      id: "parent-new",
      artistId: "artist-1",
      createdAt: new Date("2026-08-02T12:00:00.000Z"),
      coveredArtists: [],
    },
  ];

  assert.equal(
    eligibleFestivalFollowUp(
      "artist-1",
      parentOutreaches,
      new Map([
        ["parent-old", older],
        ["parent-new", newest],
      ]),
    )?.parentOutreachId,
    "parent-new",
  );
  assert.equal(
    eligibleFestivalFollowUp(
      "artist-1",
      parentOutreaches,
      new Map([
        ["parent-old", older],
        ["parent-new", followUpEligibility("parent-new", false)],
      ]),
    ),
    null,
  );
});
