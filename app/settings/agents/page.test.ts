import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

test("agent rules settings clearly separate global and artist-specific scope", () => {
  assert.match(source, /Scope: all agent jobs/);
  assert.match(source, /Artist-specific research notes remain separate/);
  assert.match(source, /GLOBAL_AGENT_RULES_MAX_LENGTH/);
  assert.match(source, /maxLength=\{GLOBAL_AGENT_RULES_MAX_LENGTH\}/);
});

test("agent rules settings document versioned claim snapshot behavior", () => {
  assert.match(source, /Saving creates a new version for future claims/);
  assert.match(source, /already\s+claimed keep their snapshotted rules/);
  assert.match(source, /expired, or requeued jobs receive the latest version/);
  assert.match(source, /requireServerActionAuth\("\/settings\/agents"\)/);
});

test("agent rules settings remains usable on narrow screens", () => {
  assert.match(source, /px-4 py-8 sm:px-6 sm:py-10/);
  assert.match(source, /flex flex-col gap-2 sm:flex-row/);
});
