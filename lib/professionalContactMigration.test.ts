import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const migrationName = "20260804190000_professional_contact_research";
const migration = readFileSync(
  new URL(
    `../prisma/migrations/${migrationName}/migration.sql`,
    import.meta.url,
  ),
  "utf8",
);
const schema = readFileSync(
  new URL("../prisma/schema.prisma", import.meta.url),
  "utf8",
);

test("professional contact migration is ordered after prior main migrations", () => {
  const migrations = readdirSync(
    new URL("../prisma/migrations", import.meta.url),
    { withFileTypes: true },
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.ok(
    migrations.indexOf("20260804181500_sent_mail_retry_target_refresh") <
      migrations.indexOf(migrationName),
  );
  assert.ok(
    migrations.indexOf(migrationName) <
      migrations.indexOf("20260804193000_immediate_arbitrary_sent_target"),
  );
});

test("professional contact persistence is separate, constrained, and immutable", () => {
  assert.match(migration, /^BEGIN;/);
  for (const table of [
    "ProfessionalContactRequest",
    "ProfessionalContactJob",
    "ProfessionalContactDispatch",
    "ProfessionalContactDispatchAttempt",
    "ProfessionalContactCandidate",
    "ProfessionalContactDecision",
    "ProfessionalContactEvent",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE "${table}"`));
  }
  assert.match(migration, /pending', 'claimed', 'review', 'exhausted', 'completed/);
  assert.match(migration, /ProfessionalContactJob_requestId_normalizedPersonName_key/);
  assert.match(migration, /ProfessionalContactCandidate_jobId_normalizedEmail_key/);
  assert.match(migration, /ProfessionalContactDecision_candidateId_key/);
  assert.match(
    migration,
    /ProfessionalContactDispatchAttempt_dispatchId_attemptNumber_key/,
  );
  assert.match(migration, /ProfessionalContactJob_claimProvenanceToken_key/);
  assert.match(migration, /"patternExamples" JSONB/);
  assert.match(
    migration,
    /pending', 'dispatching', 'dispatched', 'failed'/,
  );
  assert.match(
    migration,
    /dispatch_started', 'dispatch_succeeded', 'dispatch_failed'/,
  );
  assert.match(migration, /Professional contact request snapshots are immutable/);
  assert.match(migration, /Professional contact decisions are immutable/);
  assert.match(migration, /Professional contact audit events are immutable/);
  assert.match(migration, /domain_pattern[\s\S]*confidence" = 'low'/);
  assert.doesNotMatch(migration, /REFERENCES "(?:Artist|Contact)"/);
  assert.match(migration, /COMMIT;\s*$/);
  assert.match(schema, /model ProfessionalContactRequest \{/);
  assert.match(schema, /model ProfessionalContactDecision \{/);
  assert.match(schema, /model ProfessionalContactDispatch \{/);
});
