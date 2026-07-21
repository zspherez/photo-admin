import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const source = fs.readFileSync(
  path.join(process.cwd(), "app/dashboard/dashboard-client.tsx"),
  "utf8"
);

test("dashboard replaces page navigation with infinite loading states", () => {
  assert.doesNotMatch(source, /Dashboard pages|← Previous|Next →/);
  assert.match(source, /new IntersectionObserver/);
  assert.match(source, /rootMargin: "600px 0px"/);
  assert.match(source, />\s*\{loading \? "Loading…" : error \? "Retry" : "Load more"\}/);
  assert.match(source, /Couldn’t load more shows/);
  assert.match(source, /You’ve reached the end/);
  assert.match(source, /aria-live="polite"/);
});

test("dashboard retains a manual fallback and prevents concurrent loads", () => {
  assert.match(source, /loadingRef\.current/);
  assert.match(source, /disabled=\{loading\}/);
  assert.match(source, /Automatic loading is off; use the Load more button/);
  assert.match(source, /prefers-reduced-motion: reduce/);
  assert.match(source, /saveData/);
});
