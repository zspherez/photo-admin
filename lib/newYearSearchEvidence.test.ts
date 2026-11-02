import assert from "node:assert/strict";
import test from "node:test";
import {
  extractRunEvidence,
  multiCityEvidence,
  newYearSuggestionsForConfirmedShows,
  validateRunEvidence,
  type ConfirmedRunShow,
} from "./newYearSearchEvidence";

const source = "https://www.ticketmaster.com/event/123";

test("requires artist, correct season, US state and explicit date/city on the same event row", () => {
  const boston = extractRunEvidence(
    "Example Artist", "Example Artist Tour",
    "Dec 29, 2026 | Boston, MA | The Hall", source, 2026
  );
  const chicago = extractRunEvidence(
    "Example Artist", "Example Artist Tour",
    "Jan 2, 2027 | Chicago, IL | The Room", source, 2026
  );
  assert.deepEqual(boston && { date: boston.date, city: boston.city, state: boston.state },
    { date: "2026-12-29", city: "Boston", state: "MA" });
  assert.equal(validateRunEvidence("Example Artist", boston!, 2026), true);
  assert.equal(extractRunEvidence("Example Artist", "Example Artist Tour", "2026-12-30 - Miami, FL", source, 2026)?.date, "2026-12-30");
  assert.equal(extractRunEvidence("Example Artist", "Example Artist Tour", "01/02/2027 | Chicago, IL", source, 2026)?.date, "2027-01-02");
  assert.equal(multiCityEvidence([boston!, chicago!]), true);
  assert.equal(multiCityEvidence([boston!, { ...boston!, date: "2026-12-30" }]), false);
  assert.equal(extractRunEvidence("Other Artist", "Example Artist Tour", "Dec 29, 2026 | Boston, MA", source, 2026), null);
  assert.equal(extractRunEvidence("Example Artist", "Example Artist Tour", "Dec 29, 2025 | Boston, MA", source, 2026), null);
  assert.equal(extractRunEvidence("Example Artist", "Example Artist Tour", "Dec 29, 2026 | Toronto, ON", source, 2026), null);
  assert.equal(extractRunEvidence("Example Artist", "Example Artist Tour", "Dec 29, 2026 | Boston, MA | Chicago, IL", source, 2026), null);
  assert.equal(extractRunEvidence("Example Artist", "Example Artist Tour", "Dec 29, 2026 | Boston, MA", "https://127.0.0.1/event", 2026), null);
  assert.equal(validateRunEvidence("Example Artist", { ...boston!, city: "Miami" }, 2026), false);
  assert.equal(validateRunEvidence("Example Artist", {} as typeof boston & NonNullable<unknown>, 2026), false);
});

test("one new external city plus a confirmed active US city qualifies without copying confirmed shows", () => {
  const boston = extractRunEvidence("Example Artist", "Example Artist Tour",
    "Dec 29, 2026 | Boston, MA", source, 2026)!;
  const chicago = extractRunEvidence("Example Artist", "Example Artist Tour",
    "Dec 30, 2026 | Chicago, IL", source, 2026)!;
  const confirmed: ConfirmedRunShow = {
    date: new Date("2026-12-29T00:00:00.000Z"),
    city: "Boston", state: "MA", countryCode: "US", dismissedAt: null,
    syncStatus: "outside_nyc", isFestival: false,
  };
  assert.deepEqual(newYearSuggestionsForConfirmedShows([chicago], [confirmed]), [chicago]);
  assert.deepEqual(newYearSuggestionsForConfirmedShows([boston, chicago], [confirmed]), [chicago]);
  assert.deepEqual(newYearSuggestionsForConfirmedShows([boston], [confirmed]), []);
  assert.deepEqual(newYearSuggestionsForConfirmedShows([chicago], [{ ...confirmed, city: "Chicago", state: "IL" }]), []);

  for (const ineligible of [
    { ...confirmed, dismissedAt: new Date() },
    { ...confirmed, countryCode: "CA" },
    { ...confirmed, syncStatus: "inactive" },
    { ...confirmed, syncStatus: "outside_nyc", isFestival: true },
    { ...confirmed, city: "Unknown" },
  ]) {
    assert.deepEqual(newYearSuggestionsForConfirmedShows([chicago], [ineligible]), []);
  }
});
