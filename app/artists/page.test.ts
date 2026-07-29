import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const nav = readFileSync(
  new URL("../../components/nav.tsx", import.meta.url),
  "utf8",
);

test("Contacts navigation is presented as a searchable Artists view", () => {
  assert.match(nav, /href: "\/artists", label: "Artists"/);
  assert.match(page, /metadata: Metadata = \{ title: "Artists" \}/);
  assert.match(page, />Artists</);
  assert.match(page, /Search artists, emails, phones, managers, or notes/);
  assert.match(page, /COALESCE\(artist\."customName", ''\)/);
  assert.match(page, /artistDisplayName\(artist\)/);
  assert.match(page, /COALESCE\(contact\."phone", ''\)/);
});

test("artist page exposes contact-status tabs with query-backed counts", () => {
  assert.match(page, /"all", "with", "without"/);
  assert.match(page, /label: "All"/);
  assert.match(page, /label: "With contacts"/);
  assert.match(page, /label: "Without contacts"/);
  assert.match(page, /COUNT\(\*\) FILTER \(WHERE \$\{activeContactExists\}\)/);
  assert.match(page, /AND NOT \$\{activeContactExists\}/);
  assert.match(page, /aria-label="Artist contact status"/);
});

test("artist rows preserve contact and add-contact workflows", () => {
  assert.match(page, /artist\.contacts\.map/);
  assert.match(page, /\/dashboard\/contact\/\$\{contact\.id\}/);
  assert.match(page, /\/dashboard\/add-contact\/\$\{artist\.id\}/);
  assert.match(page, /DirectOutreachProvenance/);
  assert.match(page, /withWorkflowReturnTo/);
  assert.match(page, /aria-label="Artist pages"/);
});
