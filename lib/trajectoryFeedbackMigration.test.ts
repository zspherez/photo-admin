import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../prisma/migrations/20260721200000_trajectory_feedback/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

test("feedback migration is additive, transactional, and constrained", () => {
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /COMMIT;\s*$/);
  assert.match(migration, /CREATE TABLE "TrajectoryFeedbackEvent"/);
  assert.match(migration, /CREATE TABLE "TrajectoryShowOutcome"/);
  assert.match(migration, /ADD COLUMN "trajectoryRecommendationId" TEXT/);
  assert.match(migration, /TrajectoryFeedbackEvent_propensity_check/);
  assert.match(migration, /TrajectoryShowOutcome_keeperCount_check/);
  assert.match(migration, /TrajectoryShowOutcome_relationshipValue_check/);
  assert.match(migration, /TrajectoryShowOutcome_publicationValue_check/);
  assert.match(migration, /TrajectoryShowOutcome_evidence_check/);
  assert.match(migration, /TrajectoryFeedbackEvent_supersedesId_key/);
  assert.match(migration, /TrajectoryShowOutcome_supersedesId_key/);
});

test("SQL triggers enforce append-only corrections and exact outreach provenance", () => {
  assert.match(
    migration,
    /TrajectoryFeedbackEvent_append_only[\s\S]*BEFORE UPDATE OR DELETE/,
  );
  assert.match(
    migration,
    /TrajectoryShowOutcome_append_only[\s\S]*BEFORE UPDATE OR DELETE/,
  );
  assert.match(
    migration,
    /feedback corrections must preserve recommendation attribution/,
  );
  assert.match(
    migration,
    /outcome corrections must preserve recommendation attribution/,
  );
  assert.match(
    migration,
    /Outreach_validate_trajectory_attribution[\s\S]*BEFORE INSERT OR UPDATE OF/,
  );
  assert.match(
    migration,
    /trajectory attribution is immutable once assigned/,
  );
  assert.match(
    migration,
    /Outreach and trajectory recommendation attribution do not match/,
  );
  assert.match(
    migration,
    /Follow-up outreach trajectory attribution must match its parent/,
  );
});
