import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderEnvDocs, renderEnvExample } from "./envDocs";

// `.env.example` and `docs/environment.md` are generated artifacts (see
// `npm run env:generate` / `npm run env:check`). This test is the same drift
// check as the CLI's `--check` mode, expressed as a deterministic unit test
// so drift is caught by `npm test` too, not only by a separate CI step.

test(".env.example matches the schema-generated content (run `npm run env:generate` if this fails)", () => {
  const onDisk = readFileSync(
    new URL("../.env.example", import.meta.url),
    "utf8"
  );
  assert.equal(onDisk, renderEnvExample());
});

test("docs/environment.md matches the schema-generated content (run `npm run env:generate` if this fails)", () => {
  const onDisk = readFileSync(
    new URL("../docs/environment.md", import.meta.url),
    "utf8"
  );
  assert.equal(onDisk, renderEnvDocs());
});

test("generated .env.example and docs/environment.md never leak an actual secret value", () => {
  // Every schema entry flagged secret must default to an empty string so the
  // generator can never accidentally embed a real value in either artifact.
  const rendered = renderEnvExample() + renderEnvDocs();
  assert.doesNotMatch(rendered, /whsec_[A-Za-z0-9]/);
});
