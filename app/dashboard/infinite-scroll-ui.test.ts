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
  assert.match(source, /"Load more"/);
  assert.match(source, /Couldn’t load more shows/);
  assert.match(source, /You’ve reached the end/);
  assert.match(source, /aria-live="polite"/);
});

test("all NYC cards keep badges optional and load policy state for active contacts", () => {
  assert.match(source, /key: "all-nyc", label: "All NYC shows"/);
  assert.match(source, /\{artist\.topSignal && \(/);
  assert.match(
    source,
    /query\.mode === "all-nyc"[\s\S]*artist\.outreachEligible/
  );
  assert.match(source, /sendability\?\.sendable === true/);
  assert.match(source, /sendability\.mode === "new"/);
  assert.match(source, /isScheduled/);
  assert.match(source, /!contact && artist\.workflowEligible/);
  assert.match(source, /returnTo=\{returnTo\}/);
});

test("dashboard retains a manual fallback and prevents concurrent loads", () => {
  assert.match(source, /loadingRef\.current/);
  assert.match(source, /disabled=\{loading\}/);
  assert.match(source, /Automatic loading is off; use the Load more button/);
  assert.match(source, /prefers-reduced-motion: reduce/);
  assert.match(source, /saveData/);
});

test("dashboard restores deep returns only after saved batches load", () => {
  assert.match(source, /sessionStorage\.setItem/);
  assert.match(source, /window\.history\.replaceState/);
  assert.match(source, /batchCountRef\.current < restoreRequest\.batches/);
  assert.ok(
    source.indexOf("await requestBatch") <
      source.indexOf("restoreScrollPosition(restoreRequest)"),
  );
  assert.match(source, /data-dashboard-show-id/);
  assert.match(source, /Previous show list position restored/);
});

test("dashboard action returns mark restoration while filter changes reset it", () => {
  assert.match(source, /onSubmitCapture=\{handleSubmitCapture\}/);
  assert.match(source, /markRestoreIntent\(\)/);
  assert.match(source, /data-dashboard-filter-form="true"/);
  assert.match(source, /clearRestoreIntent\(\)/);
  assert.match(source, /parseDashboardRestoreState/);
  assert.match(source, /sessionStorage\.removeItem\(storageKey\)/);
});

test("HTTP 410 switches to safe refresh without a retry loop", () => {
  assert.match(source, /response\.status === 410/);
  assert.match(source, /setSnapshotExpired\(true\)/);
  assert.match(source, /sessionStorage\.removeItem\(storageKey\)/);
  assert.match(source, /"Refresh results"/);
  assert.match(
    source,
    /if \(snapshotExpired\) \{\s*window\.location\.reload\(\);\s*\} else if/,
  );
});
