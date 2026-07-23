import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../.github/workflows/contact-research.yml", import.meta.url),
  "utf8"
);

test("contact research automation is scheduled, bounded, and preflighted", () => {
  assert.match(source, /cron: "\*\/10 \* \* \* \*"/);
  assert.match(source, /cron: "23 \* \* \* \*"/);
  assert.match(
    source,
    /Poll existing queued work every 10 minutes without refreshing discovery/,
  );
  assert.match(source, /photo-admin-contact-research-refresh/);
  assert.match(source, /photo-admin-contact-research-poll/);
  assert.match(source, /REFRESH_QUEUE:/);
  assert.match(source, /refreshQueue: \$refreshQueue/);
  const oidcRequest = source.slice(
    source.indexOf('oidc_token="$('),
    source.indexOf('echo "::add-mask::${oidc_token}"'),
  );
  const appRequest = source.slice(
    source.indexOf('claimable="$('),
    source.indexOf('lane_count="${claimable}"'),
  );
  assert.doesNotMatch(oidcRequest, /refreshQueue|--data|Content-Type/);
  assert.match(appRequest, /Content-Type: application\/json/);
  assert.match(appRequest, /--data[\s\S]*refreshQueue/);
  assert.match(appRequest, /\/api\/contact-research\/prepare/);
  assert.match(source, /workflow_dispatch/);
  assert.doesNotMatch(source, /pull_request:/);
  assert.doesNotMatch(source, /CONTACT_RESEARCH_AUTOMATION_ENABLED/);
  assert.doesNotMatch(source, /actions: write/);
  assert.match(source, /copilot-requests: write/);
  assert.match(source, /id-token: write/);
  assert.match(source, /audience=photo-admin-contact-research/);
  assert.match(source, /Authorization:[^\n]*oidc_token/);
  assert.match(source, /\/api\/contact-research\/prepare/);
  assert.match(source, /lane_count > 10/);
  assert.match(
    source,
    /lane: \$\{\{ fromJSON\(needs\.prepare\.outputs\.workers\) \}\}/
  );
  assert.match(source, /needs\.prepare\.outputs\.claimable != '0'/);
  assert.match(source, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(source, /secrets\.CRON_SECRET/);
  assert.doesNotMatch(source, /secrets\.CONTACT_RESEARCH_AGENT_TOKEN/);
  assert.doesNotMatch(source, /CONTACT_RESEARCH_AGENT_TOKEN:/);
  assert.doesNotMatch(source, /CONTACT_RESEARCH_MAX_AI_CREDITS/);
  assert.match(source, /CONTACT_RESEARCH_WORKERS: "4"/);
  assert.match(source, /CONTACT_RESEARCH_LANE: \$\{\{ matrix\.lane \}\}/);
  assert.match(source, /npm run contact-research:agent/);
  assert.match(source, /actions\/upload-artifact@v4/);
  assert.match(source, /actions\/download-artifact@v4/);
  assert.match(source, /summarize-contact-research-usage\.mjs/);
  assert.doesNotMatch(source, /merge-multiple: true/);
  assert.doesNotMatch(source, /gh workflow run contact-research\.yml/);
  assert.doesNotMatch(source, /continuation_depth/);
});
