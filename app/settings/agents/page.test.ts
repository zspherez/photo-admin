import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pageSource = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const formSource = readFileSync(
  new URL("./agent-rules-form.tsx", import.meta.url),
  "utf8",
);
const actionSource = readFileSync(
  new URL("./actions.ts", import.meta.url),
  "utf8",
);

test("agent settings use one plain-language direct outreach textarea", () => {
  assert.match(formSource, />\s*Global agent rules\s*</);
  assert.match(formSource, />\s*Direct outreach rules\s*</);
  assert.equal(
    formSource.match(/name="directOutreachInstructions"/g)?.length,
    1,
  );
  assert.match(
    formSource,
    /When an artist is managed by Leif Fosse, add a direct outreach note that I have his number\./,
  );
  for (const forbidden of [
    /["'`]DIRECT_OUTREACH/,
    /\bJSON\b/,
    /\bDSL\b/,
    /stable id/i,
    /canonical/i,
    /Add rule/,
    /Remove rule/,
    /ruleManager/,
    /ruleNote/,
  ]) {
    assert.doesNotMatch(formSource, forbidden);
  }
});

test("direct outreach remains separate, versioned, and human reviewed", () => {
  assert.match(formSource, /General rules cannot authorize direct outreach/);
  assert.match(formSource, /pending proposal for human\s+review/);
  assert.match(formSource, /person must approve/);
  assert.match(formSource, /exact snapshotted instructions/);
  assert.match(formSource, /Artist-specific research notes remain separate/);
  assert.match(actionSource, /requireServerActionAuth\("\/settings\/agents"\)/);
  assert.match(actionSource, /normalizeDirectOutreachInstructions/);
  assert.match(pageSource, /directOutreachInstructions/);
});

test("agent settings preserve input errors and remain mobile friendly", () => {
  assert.match(formSource, /useActionState/);
  assert.match(formSource, /aria-invalid/);
  assert.match(formSource, /aria-describedby/);
  assert.match(pageSource, /px-4 py-8 sm:px-6 sm:py-10/);
  assert.match(formSource, /flex flex-col gap-2 sm:flex-row/);
  assert.match(formSource, /className="w-full sm:w-auto"/);
});
