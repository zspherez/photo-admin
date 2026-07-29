import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildFestivalConfirmationGroups } from "./festival-bulk-outreach-form";

const source = readFileSync(
  new URL("./festival-bulk-outreach-form.tsx", import.meta.url),
  "utf8",
);

test("festival bulk outreach supports select all and grouped confirmation", () => {
  assert.match(source, />\s*Select all\s*</);
  assert.match(source, />\s*Send to selected\s*</);
  assert.match(source, /Confirm festival outreach/);
  assert.match(source, /<th[^>]*>Email<\/th>/);
  assert.match(source, /<th[^>]*>Associated artists<\/th>/);
  assert.match(source, /<th[^>]*>Email format<\/th>/);
  assert.match(source, /"Shared"/);
  assert.match(source, /"Individual"/);
  assert.match(source, /PendingSubmitButton/);
  assert.match(source, /dialog\.showModal\(\)/);
  assert.match(source, /onCancel=\{\(\) => setConfirming\(false\)\}/);
  assert.match(source, /Confirm send \/ schedule/);
});

test("confirmation groups selected artists by the exact server grouping key", () => {
  assert.deepEqual(
    buildFestivalConfirmationGroups(
      [
        {
          contactId: "contact-a",
          artistName: "Artist A",
          groupKey: "manager@example.com",
          emailLabel: "manager@example.com",
          selectedByDefault: false,
        },
        {
          contactId: "contact-b",
          artistName: "Artist B",
          groupKey: "manager@example.com",
          emailLabel: "manager@example.com",
          selectedByDefault: false,
        },
        {
          contactId: "contact-c",
          artistName: "Artist C",
          groupKey: "contact:contact-c",
          emailLabel: "team@example.com, manager@example.com",
          selectedByDefault: false,
        },
      ],
      ["contact-a", "contact-b", "contact-c"],
    ),
    [
      {
        groupKey: "manager@example.com",
        emailLabel: "manager@example.com",
        artistNames: ["Artist A", "Artist B"],
      },
      {
        groupKey: "contact:contact-c",
        emailLabel: "team@example.com, manager@example.com",
        artistNames: ["Artist C"],
      },
    ],
  );
});
