import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

function source(file: string): string {
  return readFileSync(path.join(process.cwd(), file), "utf8");
}

test("outreach and custom history share one Emails section header", () => {
  const header = source("components/email-center-header.tsx");
  const outreach = source("app/outreach/page.tsx");
  const custom = source("app/emails/page.tsx");

  assert.match(header, /aria-label="Email sections"/);
  assert.match(header, /href: "\/outreach", label: "Outreach"/);
  assert.match(header, /href: "\/emails", label: "Custom emails"/);
  assert.match(header, /href="\/emails\/new"/);
  assert.match(outreach, /<EmailCenterHeader active="outreach" \/>/);
  assert.match(custom, /<EmailCenterHeader active="custom" \/>/);
});

test("existing outreach URLs and filter forms remain stable", () => {
  const outreach = source("app/outreach/page.tsx");

  assert.match(outreach, /return query \? `\/outreach\?\$\{query\}` : "\/outreach"/);
  assert.match(outreach, /action="\/outreach"/);
});
