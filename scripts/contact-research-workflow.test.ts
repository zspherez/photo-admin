import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../.github/workflows/contact-research.yml", import.meta.url),
  "utf8"
);

test("contact research automation is scheduled, bounded, and preflighted", () => {
  assert.match(source, /cron: "23 \* \* \* \*"/);
  assert.match(source, /workflow_dispatch/);
  assert.doesNotMatch(source, /pull_request:/);
  assert.doesNotMatch(source, /CONTACT_RESEARCH_AUTOMATION_ENABLED/);
  assert.match(source, /actions: write/);
  assert.match(source, /copilot-requests: write/);
  assert.match(source, /id-token: write/);
  assert.match(source, /audience=photo-admin-contact-research/);
  assert.match(source, /\/api\/contact-research\/prepare/);
  assert.match(source, /CONTACT_RESEARCH_BATCH_SIZE: "200"/);
  assert.match(source, /worker_count > 10/);
  assert.match(source, /per_worker_limit/);
  assert.match(
    source,
    /worker: \$\{\{ fromJSON\(needs\.prepare\.outputs\.workers\) \}\}/
  );
  assert.match(source, /needs\.prepare\.outputs\.claimable != '0'/);
  assert.match(source, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(source, /secrets\.CRON_SECRET/);
  assert.doesNotMatch(source, /secrets\.CONTACT_RESEARCH_AGENT_TOKEN/);
  assert.doesNotMatch(source, /CONTACT_RESEARCH_MAX_AI_CREDITS/);
  assert.match(
    source,
    /CONTACT_RESEARCH_LIMIT: \$\{\{ needs\.prepare\.outputs\.per_worker_limit \}\}/
  );
  assert.match(source, /npm run contact-research:agent/);
  assert.match(source, /gh workflow run contact-research\.yml/);
  assert.match(source, /CONTINUATION_DEPTH >= 19/);
});
