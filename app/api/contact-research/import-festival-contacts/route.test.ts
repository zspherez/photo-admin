import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("festival contact import endpoint uses trusted research authorization", () => {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  assert.match(source, /isValidContactResearchAuthorization/);
  assert.match(source, /decodeFestivalContactImportPayload/);
  assert.match(source, /importFestivalContactsCsv/);
  assert.doesNotMatch(source, /CONTACT_RESEARCH_AGENT_TOKEN/);
  assert.match(source, /FestivalContactImportError/);
  assert.match(source, /status: error instanceof FestivalContactImportError \? 400 : 500/);
  const workflow = readFileSync(
    new URL(
      "../../../../.github/workflows/contact-research.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(workflow, /FESTIVAL_CONTACTS_IMPORT_GZIP_BASE64/);
  assert.match(workflow, /audience=photo-admin-contact-research/);
  assert.match(workflow, /import_dry_run/);
  assert.doesNotMatch(
    workflow,
    /echo\s+["']?\$\{FESTIVAL_CONTACTS_IMPORT_GZIP_BASE64\}/,
  );
  assert.doesNotMatch(workflow, /set -x/);
});
