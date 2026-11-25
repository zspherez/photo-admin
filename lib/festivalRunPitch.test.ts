import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_FESTIVAL_RUN_PITCH,
  renderFestivalRunPitch,
  validateFestivalRunPitchTemplate,
} from "./festivalRunPitch";

test("festival pitch renders distinct festivals across US and Canada", async () => {
  const result = await renderFestivalRunPitch(
    DEFAULT_FESTIVAL_RUN_PITCH,
    "Arlo",
    [
      {
        date: new Date("2027-03-14T00:00:00Z"),
        city: "San Diego", state: "CA", venueName: "Waterfront",
        eventName: "CRSSD Festival", countryCode: "US", countryName: "United States",
      },
      {
        date: new Date("2027-07-09T00:00:00Z"),
        city: "Vancouver", state: "BC", venueName: "Park",
        eventName: "FVDED in the Park", countryCode: "CA", countryName: "Canada",
      },
    ],
    async (key) => key === "portfolio_url" ? "https://portfolio.example" : "Sender",
  );
  assert.match(result.subject, /Arlo festival run/);
  assert.match(result.html, /CRSSD Festival \/ FVDED in the Park/);
  assert.match(result.html, /Mar 14, Jul 9/);
  assert.deepEqual(validateFestivalRunPitchTemplate(DEFAULT_FESTIVAL_RUN_PITCH), []);
});

test("festival pitch escapes untrusted show values and rejects unknown template variables", async () => {
  const result = await renderFestivalRunPitch(
    { subject: "{{artist}}", htmlBody: "<p>{{run_festivals}} in {{run_cities}}</p>" },
    "<Arlo>",
    [{
      date: new Date("2027-03-14T00:00:00Z"),
      city: "<San Diego>", state: "CA", venueName: "Waterfront",
      eventName: "<CRSSD>", countryCode: "US", countryName: "United States",
    }],
    async () => "",
  );
  assert.equal(result.html, "<p>&lt;CRSSD&gt; in &lt;San Diego&gt;, CA</p>");
  assert.deepEqual(
    validateFestivalRunPitchTemplate({ subject: "{{unknown}}", htmlBody: "<p>{{artist}}</p>" }),
    ["unknown"],
  );
});
