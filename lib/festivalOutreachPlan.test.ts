import assert from "node:assert/strict";
import test from "node:test";
import {
  festivalConfirmedPlan,
  matchesFestivalConfirmedPlan,
  type FestivalPlanCandidate,
} from "./festivalOutreachPlan";

const candidate = (id: string, artist: string, email: string): FestivalPlanCandidate => ({
  selectionId: `original:${id}`,
  contactId: id,
  coveredArtistIds: [artist],
  groupKey: email,
  outreachKind: "original",
  recipients: [email],
  primaryRecipientEmail: email,
  recipientDeliveryMode: "individual_threads",
  immutableDeliveryMode: false,
});

test("confirmation plan freezes recipient groups and exact artist coverage", () => {
  const preview = [
    candidate("jon-a", "a", "jon@example.com"),
    candidate("jon-b", "b", "jon@example.com"),
    candidate("emily", "a", "emily@example.com"),
    candidate("anthony", "b", "anthony@example.com"),
  ];
  const ids = preview.map((item) => item.selectionId);
  const confirmed = festivalConfirmedPlan(preview, ids, "individual_threads");
  assert.equal(confirmed.length, 3);
  assert.deepEqual(confirmed.find((group) => group.groupKey === "jon@example.com")?.coveredArtistIds, ["a", "b"]);
  assert.equal(matchesFestivalConfirmedPlan(confirmed,
    festivalConfirmedPlan(preview, ids, "individual_threads")), true);
  assert.equal(matchesFestivalConfirmedPlan(confirmed,
    festivalConfirmedPlan([
      { ...preview[0], recipients: ["changed@example.com"], groupKey: "changed@example.com",
        primaryRecipientEmail: "changed@example.com" }, ...preview.slice(1),
    ], ids, "individual_threads")), false);
  assert.equal(matchesFestivalConfirmedPlan(confirmed,
    festivalConfirmedPlan(preview, ids.filter((id) => id !== "original:jon-b"),
      "individual_threads")), false);
  assert.equal(matchesFestivalConfirmedPlan(confirmed,
    festivalConfirmedPlan(preview, ids, "to_thread")), false);
  assert.equal(matchesFestivalConfirmedPlan(
    confirmed.map((group) => ({ ...group, coveredArtistIds: ["tampered"] })),
    confirmed,
  ), false);
  assert.equal(matchesFestivalConfirmedPlan(null, confirmed), false);
});
