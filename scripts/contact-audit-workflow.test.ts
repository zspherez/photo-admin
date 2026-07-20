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

test("contact audit workflow is manual, bounded, and OIDC-authenticated", () => {
  assert.match(workflow, /workflow_dispatch/);
  assert.doesNotMatch(workflow, /schedule:/);
  assert.doesNotMatch(workflow, /pull_request:/);
  assert.match(workflow, /copilot-requests: write/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /audience=photo-admin-contact-audit/);
  assert.match(workflow, /\/api\/contact-audit\/prepare/);
  assert.match(workflow, /lane_count > 10/);
  assert.match(workflow, /CONTACT_AUDIT_WORKERS: "4"/);
  assert.match(workflow, /npm run contact-audit:agent/);
  assert.doesNotMatch(workflow, /secrets\.CRON_SECRET/);
  assert.doesNotMatch(workflow, /secrets\.CONTACT_AUDIT_AGENT_TOKEN/);
  assert.doesNotMatch(workflow, /jq -er '\.resumed \| booleans'/);
  assert.match(
    workflow,
    /if \(\.resumed \| type\) == "boolean"[\s\S]*then \(\.resumed \| tostring\)[\s\S]*else error\("invalid resumed boolean"\)/
  );
});

test("audit agent and broker preserve review-only manager policy", () => {
  assert.match(agent, /review-only audit/);
  assert.match(agent, /Never edit, replace, approve, deactivate/);
  assert.match(agent, /Never propose\s+a booking agent, publicist/);
  assert.match(agent, /Never bypass a login, paywall/);
  assert.match(agent, /submit-result/);
  assert.doesNotMatch(broker, /contactResearchCandidate/);
  assert.doesNotMatch(
    broker,
    /\/api\/contact-research\/[^"]*\/result/
  );
  assert.match(broker, /\/api\/contact-audit\//);
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
