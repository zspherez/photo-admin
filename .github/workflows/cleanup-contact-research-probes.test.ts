import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL(
  "./cleanup-contact-research-probes.yml",
  import.meta.url
);

function job(source: string, name: "dry_run" | "apply") {
  const start = source.indexOf(`  ${name}:`);
  const end =
    name === "dry_run" ? source.indexOf("\n  apply:", start) : source.length;
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return source.slice(start, end);
}

test("cleanup workflow exposes only separate dry-run and apply modes", async () => {
  const source = await readFile(workflowUrl, "utf8");
  assert.match(
    source,
    /mode:\n\s+description:[^\n]+\n\s+required: true\n\s+type: choice\n\s+options:\n\s+- dry_run\n\s+- apply/
  );
  assert.equal(source.match(/^\s+- (?:dry_run|apply)$/gm)?.length, 2);
  assert.match(
    job(source, "dry_run"),
    /inputs\.mode == 'dry_run'[\s\S]*inputs\.confirmation == 'DRY_RUN_RESEARCH_PROBES'/
  );
  assert.match(
    job(source, "apply"),
    /inputs\.mode == 'apply'[\s\S]*inputs\.confirmation == 'CLEANUP_RESEARCH_PROBES'/
  );
});

test("dry-run cannot reach apply and publishes a validated JSON summary", async () => {
  const dryRun = job(await readFile(workflowUrl, "utf8"), "dry_run");
  assert.match(dryRun, /cleanup-contact-research-probes\.ts --dry-run/);
  assert.match(dryRun, /--expected-mode dry-run/);
  assert.match(dryRun, /GITHUB_STEP_SUMMARY|validate-contact-research-probe-summary/);
  assert.match(dryRun, /actions\/upload-artifact@v4/);
  assert.match(dryRun, /dry-run-summary\.json/);
  assert.doesNotMatch(dryRun, /--apply|CLEANUP_RESEARCH_PROBES/);
});

test("apply reruns and validates preflight before apply and post-verification", async () => {
  const apply = job(await readFile(workflowUrl, "utf8"), "apply");
  const dryRunIndex = apply.indexOf(
    "cleanup-contact-research-probes.ts --dry-run"
  );
  const preflightValidationIndex = apply.indexOf(
    "--input artifacts/apply-preflight-summary.json"
  );
  const applyIndex = apply.indexOf("--apply");
  const verifyIndex = apply.indexOf("--verify");
  assert.ok(dryRunIndex >= 0);
  assert.ok(preflightValidationIndex > dryRunIndex);
  assert.ok(applyIndex > preflightValidationIndex);
  assert.ok(verifyIndex > applyIndex);
  assert.match(apply, /--expected-mode dry-run/);
  assert.match(apply, /--expected-mode apply/);
  assert.match(apply, /--expected-mode verify/);
  assert.match(apply, /--confirmation "\$CLEANUP_CONFIRMATION"/);
  assert.doesNotMatch(
    apply,
    /inputs\.(?:manifest|manifest_version|job_count|candidate_count)/
  );
});

test("both modes retain protected main-only trust and database gates", async () => {
  const source = await readFile(workflowUrl, "utf8");
  for (const name of ["dry_run", "apply"] as const) {
    const selected = job(source, name);
    assert.match(selected, /github\.repository == 'zspherez\/photo-admin'/);
    assert.match(selected, /github\.ref == 'refs\/heads\/main'/);
    assert.match(
      selected,
      /github\.workflow_ref == 'zspherez\/photo-admin\/\.github\/workflows\/cleanup-contact-research-probes\.yml@refs\/heads\/main'/
    );
    assert.match(selected, /environment: production/);
    assert.match(selected, /persist-credentials: false/);
    assert.match(selected, /ref: refs\/heads\/main/);
    assert.match(selected, /db:verify-targets -- --require-all-migrations/);
  }
  assert.doesNotMatch(
    source,
    /\b(?:build|deploy|release|pause|migrate:deploy)\b/i
  );
});

test("database secrets are scoped to database steps and never summarized", async () => {
  const source = await readFile(workflowUrl, "utf8");
  assert.match(source, /DATABASE_URL: \$\{\{ secrets\.DATABASE_URL \}\}/);
  assert.match(source, /DIRECT_URL: \$\{\{ secrets\.DIRECT_URL \}\}/);
  assert.doesNotMatch(source, /\becho\b.*(?:DATABASE_URL|DIRECT_URL)/i);
  assert.doesNotMatch(
    source,
    /run:\s*[^\n]*\$\{\{\s*secrets\.(?:DATABASE_URL|DIRECT_URL)/i
  );
  assert.doesNotMatch(
    source,
    /(?:evidence|agentNotes|DATABASE_URL|DIRECT_URL).*GITHUB_STEP_SUMMARY/i
  );
});
