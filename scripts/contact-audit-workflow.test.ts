import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/contact-audit.yml", import.meta.url),
  "utf8"
);
const agent = readFileSync(
  new URL("../.github/agents/contact-audit.agent.md", import.meta.url),
  "utf8"
);
const broker = readFileSync(
  new URL("./contact-audit-broker.mjs", import.meta.url),
  "utf8"
);
const migration = readFileSync(
  new URL(
    "../prisma/migrations/20260720080000_contact_audit/migration.sql",
    import.meta.url
  ),
  "utf8"
);
const resolutionMigration = readFileSync(
  new URL(
    "../prisma/migrations/20260720120000_contact_audit_resolution/migration.sql",
    import.meta.url
  ),
  "utf8"
);
const requestMigration = readFileSync(
  new URL(
    "../prisma/migrations/20260721030000_contact_audit_request_queue/migration.sql",
    import.meta.url
  ),
  "utf8"
);
const rosterMigration = readFileSync(
  new URL(
    "../prisma/migrations/20260721123000_contact_audit_rosters/migration.sql",
    import.meta.url
  ),
  "utf8"
);

test("contact audit workflow polls explicitly requested work and is OIDC-authenticated", () => {
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /cron: "\*\/10 \* \* \* \*"/);
  assert.doesNotMatch(workflow, /pull_request:/);
  assert.match(workflow, /copilot-requests: write/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /audience=photo-admin-contact-audit/);
  assert.match(workflow, /\/api\/contact-audit\/prepare/);
  assert.match(workflow, /workflowRunId/);
  assert.match(workflow, /requested=\$\{requested\}/);
  assert.match(
    workflow,
    /needs\.prepare\.outputs\.requested == 'true' && needs\.prepare\.outputs\.claimable != '0'/
  );
  assert.match(
    workflow,
    /No contact audit request is pending; schedule tick is a no-op/
  );
  assert.match(workflow, /lane_count > 10/);
  assert.match(workflow, /CONTACT_AUDIT_WORKERS: "4"/);
  assert.match(workflow, /npm run contact-audit:agent/);
  assert.doesNotMatch(workflow, /secrets\.CRON_SECRET/);
  assert.doesNotMatch(workflow, /secrets\.CONTACT_AUDIT_AGENT_TOKEN/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /cancel-in-progress: true/);
  assert.doesNotMatch(workflow, /jq -er '\.resumed \| booleans'/);
  assert.match(
    workflow,
    /if \(\.resumed \| type\) == "boolean"[\s\S]*then \(\.resumed \| tostring\)[\s\S]*else error\("invalid resumed boolean"\)/
  );
  const prepareJob = workflow.slice(
    workflow.indexOf("  prepare:"),
    workflow.indexOf("  audit:")
  );
  assert.doesNotMatch(prepareJob, /actions\/checkout|npm ci|copilot@latest/);
  assert.match(workflow, /Requeue failed contact audit attempt/);
  assert.match(workflow, /\/api\/contact-audit\/attempt/);
});

test("audit agent and broker preserve review-only manager policy", () => {
  assert.match(agent, /review-only audit/);
  assert.match(agent, /Never edit, replace, approve, deactivate/);
  assert.match(agent, /Never propose\s+a booking agent, publicist/);
  assert.match(agent, /Never bypass a login, paywall/);
  assert.match(agent, /submit-result/);
  assert.match(agent, /immutable snapshot of every active contact/);
  assert.match(agent, /every supplied roster entry exactly once/);
  assert.match(agent, /Existing roster contacts must remain separate/);
  assert.match(agent, /Any active email in the roster is management context/);
  assert.match(broker, /contactRoster/);
  assert.match(broker, /rosterReview/);
  assert.doesNotMatch(broker, /contactResearchCandidate/);
  assert.doesNotMatch(
    broker,
    /\/api\/contact-research\/[^"]*\/result/
  );
  assert.match(broker, /\/api\/contact-audit\//);
});

test("contact audit roster migration is normalized, immutable, and legacy-safe", () => {
  assert.match(rosterMigration, /^BEGIN;/);
  assert.match(rosterMigration, /CREATE TABLE "ContactAuditRosterSnapshot"/);
  assert.match(rosterMigration, /CREATE TABLE "ContactAuditRosterEntry"/);
  assert.match(
    rosterMigration,
    /ContactAuditRosterSnapshot_runId_snapshotArtistId_key/
  );
  assert.match(rosterMigration, /ContactAuditJob_roster_link_check/);
  assert.match(rosterMigration, /target must belong to the job artist roster/);
  assert.match(rosterMigration, /roster snapshots are immutable/);
  assert.match(rosterMigration, /"rosterReview" IS DISTINCT FROM/);
  assert.doesNotMatch(rosterMigration, /UPDATE "ContactAuditJob"/);
  assert.doesNotMatch(rosterMigration, /DELETE FROM "ContactAudit/);
  assert.match(rosterMigration, /COMMIT;\s*$/);
});

test("contact audit migration is explicit and transactional", () => {
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /CREATE TABLE "ContactAuditRun"/);
  assert.match(migration, /CREATE TABLE "ContactAuditJob"/);
  assert.match(migration, /CREATE TABLE "ContactAuditAlternative"/);
  assert.match(migration, /ON DELETE SET NULL/);
  assert.match(migration, /ContactAuditJob_result_consistency_check/);
  assert.match(migration, /COMMIT;\s*$/);
});

test("contact audit decisions have immutable constrained provenance", () => {
  assert.match(resolutionMigration, /^BEGIN;/);
  assert.match(
    resolutionMigration,
    /ContactAuditJob_resolution_consistency_check/
  );
  assert.match(
    resolutionMigration,
    /ContactAuditJob_selectedAlternativeId_fkey/
  );
  assert.match(
    resolutionMigration,
    /Selected contact audit alternative must belong to its job/
  );
  assert.match(
    resolutionMigration,
    /Resolved contact audit decisions and provenance are immutable/
  );
  assert.match(
    resolutionMigration,
    /Resolved contact audit alternatives are immutable/
  );
  assert.match(
    resolutionMigration,
    /Resolved contact audit history cannot be deleted/
  );
  assert.match(
    resolutionMigration,
    /"finding" IS NOT NULL[\s\S]*"verifiedAt" IS NOT NULL[\s\S]*"resolvedAt" IS NOT NULL/
  );
  assert.match(
    resolutionMigration,
    /"resolvedArtistName" IS NOT NULL[\s\S]*char_length\(btrim\("resolvedArtistName"\)\) > 0/
  );
  assert.match(resolutionMigration, /COMMIT;\s*$/);
});

test("contact audit request migration constrains lifecycle and one active request", () => {
  assert.match(requestMigration, /^BEGIN;/);
  assert.match(requestMigration, /CREATE TABLE "ContactAuditRequest"/);
  assert.match(
    requestMigration,
    /"status" IN \('pending', 'running', 'completed', 'failed'\)/
  );
  assert.match(
    requestMigration,
    /CREATE UNIQUE INDEX "ContactAuditRequest_one_active_key"[\s\S]*WHERE "status" IN \('pending', 'running'\)/
  );
  assert.match(requestMigration, /ContactAuditRequest_lifecycle_check/);
  assert.match(
    requestMigration,
    /INSERT INTO "ContactAuditRequest"[\s\S]*FROM "ContactAuditRun" running[\s\S]*WHERE running\."status" = 'running'[\s\S]*ORDER BY running\."createdAt" ASC, running\."id" ASC[\s\S]*LIMIT 1/
  );
  assert.match(requestMigration, /'legacy-' \|\| running\."id"/);
  assert.doesNotMatch(
    requestMigration,
    /UPDATE\s+"ContactAudit(?:Run|Job)"/
  );
  assert.doesNotMatch(requestMigration, /DELETE FROM "ContactAudit(?:Run|Job)"/);
  assert.match(requestMigration, /ContactAuditRequest_transition_guard/);
  assert.match(requestMigration, /run link is immutable/);
  assert.match(requestMigration, /COMMIT;\s*$/);
});
