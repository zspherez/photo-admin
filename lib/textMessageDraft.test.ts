import assert from "node:assert/strict";
import test from "node:test";
import { buildSmsDraftHref } from "./smsDraft";
import { renderTextMessageDraft } from "./textMessageDraft";

const settings: Record<string, string> = {
  portfolio_url: "https://photos.example",
  sender_name: "Josh",
  sender_email: "josh@example.com",
  sender_phone: "555-0100",
  sender_city: "New York",
};

test("text drafts render the selected show template as plain text", async () => {
  const body = await renderTextMessageDraft({
    context: {
      artistName: "Example Artist",
      venueName: "Randall's Island",
      showDate: new Date("2026-09-19T00:00:00.000Z"),
      managerName: "Taylor",
      eventName: "Experts Only Festival",
      city: "New York",
      state: "NY",
    },
    template: {
      htmlBody:
        "<p>Hi {{manager_name}}, can I photograph {{artist}} at {{festival_name}}?</p><p>{{sender_name}} · {{portfolio_url}}</p>",
    },
    readSetting: async (key, fallback) => settings[key] ?? fallback,
  });

  assert.equal(
    body,
    "Hi Taylor, can I photograph Example Artist at Experts Only Festival?\n\nJosh · https://photos.example",
  );
});

test("SMS draft href includes the encoded template body", () => {
  assert.equal(
    buildSmsDraftHref("+1 (555) 010-0200", "Hi Taylor,\nFestival photo request"),
    "sms:+1 (555) 010-0200?body=Hi%20Taylor%2C%0AFestival%20photo%20request",
  );
});
