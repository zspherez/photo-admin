import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const page = readFileSync(path.join(root, "app/metrics/page.tsx"), "utf8");
const nav = readFileSync(path.join(root, "components/nav.tsx"), "utf8");
const proxy = readFileSync(path.join(root, "proxy.ts"), "utf8");

test("trajectory metrics are authenticated and discoverable", () => {
  assert.match(nav, /href:\s*"\/metrics",\s*label:\s*"Metrics"/);
  assert.doesNotMatch(proxy, /["']\/metrics["']/);
  assert.match(page, /Authenticated, aggregate operational counts only/);
});

test("metrics disclose limits and avoid PII, probability, and causality claims", () => {
  for (const marker of [
    "No contact PII is",
    "not probabilities",
    "do not establish that a recommendation",
    "Export lag",
    "Unavailable",
    "Primary/backup comparison unavailable",
    "Source non-suggested",
    "<ArmTable",
  ]) {
    assert.match(page, new RegExp(marker));
  }
  assert.doesNotMatch(page, /recipientEmails|expectedRecipientEmail|contactDetail/);
  assert.doesNotMatch(page, /success rate|conversion rate|lift|impact/i);
  assert.doesNotMatch(page, /latestExportableChangeAt|Latest exportable change/);
});
