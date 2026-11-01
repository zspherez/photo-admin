import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_NEW_YEAR_PITCH,
  renderNewYearPitch,
  validateNewYearPitchTemplate,
} from "./newYearPitch";

test("New Year's pitch renders the artist and multi-city schedule before compose", async () => {
  const shows = [
    { date: new Date("2026-12-30T00:00:00Z"), city: "Chicago", state: "IL" },
    { date: new Date("2026-12-31T00:00:00Z"), city: "Miami", state: "FL" },
  ].map((show) => ({
    ...show,
    venueName: "Venue",
    eventName: null,
    countryCode: "US",
    countryName: "United States",
  }));
  const result = await renderNewYearPitch(
    DEFAULT_NEW_YEAR_PITCH,
    "Example Artist",
    shows,
    async (key) => key === "portfolio_url" ? "https://example.com" : "Sender"
  );
  assert.match(result.subject, /Example Artist New Year's run/);
  assert.match(result.html, /Chicago, IL \/ Miami, FL/);
  assert.match(result.html, /Dec 30, Dec 31/);
  assert.equal(validateNewYearPitchTemplate(DEFAULT_NEW_YEAR_PITCH).length, 0);
});

test("New Year's pitch escapes substituted artist and city values", async () => {
  const result = await renderNewYearPitch(
    { subject: "{{artist}}", htmlBody: "<p>{{run_cities}}</p>" },
    "<Artist>",
    [{
      date: new Date("2026-12-31T00:00:00Z"),
      city: "<Chicago>",
      state: "IL",
      venueName: "Venue",
      eventName: null,
      countryCode: "US",
      countryName: "United States",
    }],
    async () => ""
  );
  assert.equal(result.html, "<p>&lt;Chicago&gt;, IL</p>");
  assert.deepEqual(
    validateNewYearPitchTemplate({
      subject: "{{unsupported}}",
      htmlBody: "<p>{{artist}}</p>",
    }),
    ["unsupported"]
  );
});
