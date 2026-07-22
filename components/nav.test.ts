import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./nav.tsx", import.meta.url), "utf8");

test("primary navigation keeps dashboard shows and manual show sync distinct", () => {
  assert.match(
    source,
    /\{ href: "\/dashboard", label: "Shows", match:/
  );
  assert.match(
    source,
    /\{ href: "\/shows", label: "All shows \/ Sync", match: \(p\) => p === "\/shows" \}/
  );
});

test("primary navigation does not expose the legacy New tab", () => {
  assert.doesNotMatch(source, /href: "\/new"/);
  assert.doesNotMatch(source, /label: "New"/);
});

test("mobile navigation exposes core workflows and an accessible overflow menu", () => {
  assert.match(source, /aria-label="Mobile navigation"/);
  assert.match(source, /const MOBILE_ITEMS = \[/);
  assert.match(source, /label: "Research"/);
  assert.match(source, /label: "Audit"/);
  assert.match(source, /label: "Emails"/);
  assert.match(source, /<summary/);
  assert.match(source, /All sections/);
});
