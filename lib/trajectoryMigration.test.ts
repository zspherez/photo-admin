import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../prisma/migrations/20260721110000_artist_trajectory_runs/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const schema = readFileSync(
  new URL("../prisma/schema.prisma", import.meta.url),
  "utf8",
);

function modelBlock(name: string): string {
  const match = schema.match(
    new RegExp(String.raw`model ${name} \{([\s\S]*?)\n\}`),
  );
  assert.ok(match, `${name} model is missing`);
  return match[1];
}

test("trajectory migration is additive, transactional, and fully constrained", () => {
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /COMMIT;\s*$/);
  for (const table of [
    "TrajectoryModelRun",
    "TrajectoryRunArtist",
    "TrajectoryRecommendation",
    "TrajectoryImportIssue",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE "${table}"`));
  }
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "TrajectoryModelRun_one_ready_artist_trajectory_idx"[\s\S]*WHERE "producer" = 'artist_trajectory' AND "status" = 'ready'/,
  );
  assert.match(migration, /TrajectoryModelRun_artifactByteLength_check/);
  assert.match(migration, /TrajectoryModelRun_activation_check/);
  assert.match(
    migration,
    /TrajectoryModelRun_freshness_check[\s\S]*INTERVAL '72 hours'/,
  );
  assert.match(migration, /TrajectoryRunArtist_momentumBand_check/);
  assert.match(migration, /TrajectoryRecommendation_slate_check/);
  assert.match(migration, /TrajectoryRecommendation_billing_check/);
  assert.match(
    migration,
    /TrajectoryRecommendation_runId_slatePosition_suggested_key[\s\S]*WHERE "isSuggested"/,
  );
});

test("trajectory schema remains an additive model-opinion layer", () => {
  const artist = modelBlock("Artist");
  const show = modelBlock("Show");
  const listenSignal = modelBlock("ListenSignal");
  for (const canonical of [artist, show, listenSignal]) {
    assert.doesNotMatch(
      canonical,
      /\b(momentum|trajectoryArm|modelStatus|probability|slatePosition)\b/i,
    );
  }
  assert.doesNotMatch(schema, /model TrajectoryFeedbackEvent/);
  assert.doesNotMatch(schema, /model TrajectoryShowOutcome/);
});
