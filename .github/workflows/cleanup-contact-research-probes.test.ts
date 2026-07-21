import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL(
  "./cleanup-contact-research-probes.yml",
  import.meta.url
);

test("cleanup workflow is main-only, protected, and exactly confirmed", async () => {
  const source = await readFile(workflowUrl, "utf8");
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /github\.ref == 'refs\/heads\/main'/);
  assert.match(
    source,
    /github\.workflow_ref == 'zspherez\/photo-admin\/\.github\/workflows\/cleanup-contact-research-probes\.yml@refs\/heads\/main'/
  );
  assert.match(source, /inputs\.confirmation == 'CLEANUP_RESEARCH_PROBES'/);
  assert.match(source, /environment: production/);
  assert.match(source, /persist-credentials: false/);
  assert.match(source, /ref: refs\/heads\/main/);
});

test("cleanup workflow performs only target verification, dry-run, apply, and verify", async () => {
  const source = await readFile(workflowUrl, "utf8");
  assert.match(source, /db:verify-targets/);
  assert.match(source, /cleanup-contact-research-probes\.ts --dry-run/);
  assert.match(source, /--apply/);
  assert.match(source, /--confirmation "\$CLEANUP_CONFIRMATION"/);
  assert.match(source, /cleanup-contact-research-probes\.ts --verify/);
  assert.doesNotMatch(
    source,
    /\b(?:build|deploy|release|pause|migrate:deploy)\b/i
  );
});

test("cleanup workflow passes database secrets only through step environments", async () => {
  const source = await readFile(workflowUrl, "utf8");
  assert.match(source, /DATABASE_URL: \$\{\{ secrets\.DATABASE_URL \}\}/);
  assert.match(source, /DIRECT_URL: \$\{\{ secrets\.DIRECT_URL \}\}/);
  assert.doesNotMatch(source, /\becho\b.*(?:DATABASE_URL|DIRECT_URL)/i);
  assert.doesNotMatch(
    source,
    /run:\s*[^\n]*\$\{\{\s*secrets\.(?:DATABASE_URL|DIRECT_URL)/i
  );
});
