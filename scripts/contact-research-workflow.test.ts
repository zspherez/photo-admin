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
  assert.match(source, /copilot-requests: write/);
  assert.match(source, /\/api\/contact-research\/prepare/);
  assert.match(source, /steps\.queue\.outputs\.claimable != '0'/);
  assert.match(source, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(
    source,
    /CONTACT_RESEARCH_AGENT_TOKEN: \$\{\{ secrets\.CRON_SECRET \}\}/
  );
  assert.doesNotMatch(source, /secrets\.CONTACT_RESEARCH_AGENT_TOKEN/);
  assert.doesNotMatch(source, /CONTACT_RESEARCH_MAX_AI_CREDITS/);
  assert.match(source, /CONTACT_RESEARCH_LIMIT: "3"/);
  assert.match(source, /npm run contact-research:agent/);
});
