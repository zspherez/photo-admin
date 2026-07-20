import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./page.tsx", import.meta.url),
  "utf8"
);

test("contact audit UI launches the manual workflow and exposes saved evidence", () => {
  assert.match(
    source,
    /actions\/workflows\/contact-audit\.yml/
  );
  assert.match(source, /Run contact audit/);
  assert.match(source, /Verification source/);
  assert.match(source, /Plausible current manager contacts/);
  assert.match(source, /Verified \{formatTimestamp\(job\.verifiedAt\)\}/);
  assert.match(source, /Mark reviewed/);
  assert.match(source, /Open contact/);
});

test("contact audit UI is review-only", () => {
  assert.match(source, /never change contact records/);
  assert.doesNotMatch(source, /db\.contact\.(update|delete|upsert|create)/);
  assert.doesNotMatch(source, /approveContactResearchCandidate/);
  assert.match(source, /markContactAuditReviewed/);
});
