import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const actions = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");

test("emails page has active and recoverable dismissed views", () => {
  assert.match(page, /type EmailView = "active" \| "dismissed"/);
  assert.match(page, /dismissedAt: view === "dismissed" \? \{ not: null \} : null/);
  assert.match(page, /Active \{activeCount\}/);
  assert.match(page, /Dismissed \{dismissedCount\}/);
  assert.match(page, /EmailBulkSelection/);
  assert.match(page, /const selectionKey = `\$\{view\}:\$\{pagination\.page\}:/);
  assert.match(page, /key=\{selectionKey\}/);
  assert.match(page, /name="emailIds"/);
});

test("bulk visibility action authenticates and only toggles dismissedAt", () => {
  assert.match(actions, /updateArbitraryEmailVisibilityAction/);
  assert.match(actions, /requireServerActionAuth\("\/emails"\)/);
  assert.match(actions, /id: \{ in: ids \}/);
  assert.match(actions, /dismissedAt: view === "dismissed" \? null : new Date\(\)/);
  assert.doesNotMatch(
    actions.slice(actions.indexOf("updateArbitraryEmailVisibilityAction")),
    /arbitraryEmail\.delete/,
  );
});
