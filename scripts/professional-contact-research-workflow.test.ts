import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL(
    "../.github/workflows/professional-contact-research.yml",
    import.meta.url,
  ),
  "utf8",
);
const runner = readFileSync(
  new URL("./run-professional-contact-research-agent.sh", import.meta.url),
  "utf8",
);
const agent = readFileSync(
  new URL(
    "../.github/agents/professional-contact-research.agent.md",
    import.meta.url,
  ),
  "utf8",
);

test("professional contact workflow is recurring, manual, OIDC-scoped, and bounded", () => {
  assert.match(workflow, /Recovery only: normal requests dispatch this workflow immediately/);
  assert.match(workflow, /cron: "37 \* \* \* \*"/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /request_id:/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /copilot-requests: write/);
  assert.match(workflow, /audience=photo-admin-professional-contact-research/);
  assert.match(workflow, /\/api\/professional-contact-research\/prepare/);
  assert.match(workflow, /lane_count > 5/);
  assert.match(workflow, /npm run professional-contact-research:agent/);
  assert.doesNotMatch(workflow, /secrets\.PROFESSIONAL_CONTACT_RESEARCH_AGENT_TOKEN/);
  assert.doesNotMatch(workflow, /pull_request:/);
  assert.doesNotMatch(workflow, /actions: write/);
});

test("professional contact agent has only narrow tools and privacy constraints", () => {
  assert.match(agent, /tools: \["bash"\]/);
  assert.match(agent, /Never collect or submit a private, home, personal/);
  assert.match(agent, /Never submit free-mail addresses/);
  assert.match(agent, /domain-pattern inference only as a last resort/i);
  assert.match(agent, /human review/i);
  assert.match(agent, /Every submitted source URL must first be opened with `fetch`/);
  assert.match(
    agent,
    /exact email and the claimed person's name must appear together/,
  );
  assert.match(agent, /block containing multiple distinct people or multiple emails is/);
  assert.match(agent, /fetched ownership\/control statement on the official website/);
  assert.match(
    agent,
    /independent authoritative[\s\S]*company profile or government record/,
  );
  assert.match(agent, /two to five `patternExamples`/);
  assert.match(agent, /`priorCandidates` lists at most 20/);
  assert.match(agent, /A `422` with code `duplicate_candidates` leaves the claim active/);
  assert.match(agent, /Do not inspect files or environment variables, call curl/);
  assert.match(runner, /professional-contact-research-broker\.mjs/);
  assert.match(runner, /professional-contact-research-agent-tool/);
  assert.doesNotMatch(runner, /sudo|--allow-all|mktemp/);
});
