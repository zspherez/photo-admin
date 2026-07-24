import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

test("template saves redirect with visible success and validation results", () => {
  assert.match(source, /requireServerActionAuth\("\/settings\/template"\)/);
  assert.match(source, /Subject and body are required\./);
  assert.match(source, /Malformed \$\{templateLabel\(kind\)\.toLowerCase\(\)\} variable token/);
  assert.match(source, /Unsupported \$\{templateLabel\(kind\)\.toLowerCase\(\)\} variable/);
  assert.match(source, /Template could not be saved\. Try again\./);
  assert.match(source, /saved: "1"/);
  assert.match(source, /reset: "1"/);
  assert.match(source, /Template saved\./);
  assert.match(source, /Template reset to the built-in default\./);
  assert.doesNotMatch(source, /if \(!subject \|\| !htmlBody\) return/);
});

test("template mutation controls show pending state and are disabled for viewers", () => {
  assert.match(source, /pendingLabel="Saving template…"/);
  assert.match(source, /disabled=\{access === "read_only"\}/);
  assert.match(source, /TemplateEditor[\s\S]*disabled=\{access === "read_only"\}/);
});
