import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  isTrajectoryRunActionable,
  parseTrajectoryDigest,
  parseTrajectoryManifest,
  TRAJECTORY_RAW_SIZE_LIMIT_BYTES,
  trajectoryActionableRunWhere,
  TrajectoryContractError,
  TrajectoryDigestMismatchError,
} from "./trajectoryContract";

function recommendation(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const row = {
    recommendation_key:
      "729c190d-2864-4c05-b51d-e82a843b6234:517095:trajectory:113776",
    arm: "trajectory",
    list_rank: 1,
    is_suggested: true,
    slate_position: 1,
    edmtrain_event_id: 517095,
    show_date: "2026-07-25",
    venue_name: "00:00",
    event_name: "Trigger Collective",
    edmtrain_artist_id: 113776,
    artist_name: "MP LOVE",
    billing_position: 2,
    lineup_size: 4,
    is_first_billed: false,
    genres: ["House"],
    spotify_artist_id: null,
    ra_artist_id: "182882",
    evidence: {
      coverage_state: "C_covered",
      momentum_band: "rising",
      is_early_stage: true,
      is_established: false,
      is_veteran: false,
      events_prior_6m: 0,
      events_recent_6m: 4,
      event_delta_6m: 4,
      markets_prior_6m: 0,
      markets_recent_6m: 1,
      career_age_years: 0.16,
      analog_summary: null,
      release_context: {
        available: false,
        status: "unmatched",
        context_only_not_ranking_feature: true,
        match_quality: null,
      },
    },
  };
  return { ...row, ...overrides };
}

function manifest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    contract_version: "photo-admin-import-v1",
    producer: "artist_trajectory",
    producer_run_id: "729c190d-2864-4c05-b51d-e82a843b6234",
    producer_schema_version: "artist-trajectory-decision-v3",
    generated_at_utc: "2026-07-20T05:14:16.108757+00:00",
    as_of_date: "2026-07-20",
    decision_date: "2026-07-20",
    minimum_show_date: "2026-07-25",
    valid_until_date: "2026-10-18",
    model_status: "provisional_population_matched_event_momentum",
    validation_reference: "output/findings.md",
    full_artifact_sha256: "a".repeat(64),
    producer_revision: null,
    recommendation_count: 1,
    recommendations: [recommendation()],
    ...overrides,
  };
}

function raw(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

test("strict photo-admin-import-v1 contract is accepted and derives freshness", () => {
  const bytes = raw(manifest());
  const digest = createHash("sha256").update(bytes).digest("hex");
  const parsed = parseTrajectoryManifest(bytes, `${digest}  manifest.json\n`);

  assert.equal(parsed.artifactSha256, digest);
  assert.equal(parsed.manifest.recommendations[0].arm, "trajectory");
  assert.equal(
    parsed.validUntil.toISOString(),
    "2026-07-23T05:14:16.108Z",
  );
  assert.equal(parseTrajectoryDigest(digest.toUpperCase()), digest);
});

test("producer methodology versions may advance without changing the import shape", () => {
  const parsed = parseTrajectoryManifest(
    raw(manifest({ producer_schema_version: "artist-trajectory-decision-v4" })),
  );
  assert.equal(
    parsed.manifest.producer_schema_version,
    "artist-trajectory-decision-v4",
  );
});

test("unknown keys, contracts, arms, and coverage states are rejected", () => {
  const cases = [
    manifest({ unexpected: true }),
    manifest({ contract_version: "photo-admin-import-v2" }),
    manifest({
      recommendations: [recommendation({ arm: "probability" })],
    }),
    manifest({
      recommendations: [
        recommendation({
          evidence: {
            ...(recommendation().evidence as Record<string, unknown>),
            coverage_state: "unknown",
          },
        }),
      ],
    }),
    manifest({
      recommendations: [
        recommendation({
          evidence: {
            ...(recommendation().evidence as Record<string, unknown>),
            unexpected: true,
          },
        }),
      ],
    }),
  ];

  for (const value of cases) {
    assert.throws(() => parseTrajectoryManifest(raw(value)), TrajectoryContractError);
  }
});

test("digest mismatch and oversized raw payloads fail before import", () => {
  assert.throws(
    () => parseTrajectoryManifest(raw(manifest()), "b".repeat(64)),
    TrajectoryDigestMismatchError,
  );
  assert.throws(
    () =>
      parseTrajectoryManifest(
        Buffer.alloc(TRAJECTORY_RAW_SIZE_LIMIT_BYTES + 1),
      ),
    /exceeds/,
  );
  assert.throws(() => parseTrajectoryDigest("not-a-digest"), /SHA-256/);
});

test("duplicate recommendation identities and malformed ranks are rejected", () => {
  const first = recommendation();
  const duplicate = { ...first };
  assert.throws(
    () =>
      parseTrajectoryManifest(
        raw(
          manifest({
            recommendation_count: 2,
            recommendations: [first, duplicate],
          }),
        ),
      ),
    /Duplicate recommendation/,
  );
  assert.throws(
    () =>
      parseTrajectoryManifest(
        raw(
          manifest({
            recommendations: [recommendation({ list_rank: 0 })],
          }),
        ),
      ),
    /list_rank/,
  );
});

test("suggested slate, dates, billing, and source keys are internally consistent", () => {
  for (const row of [
    recommendation({ slate_position: 2 }),
    recommendation({ show_date: "2026-02-30" }),
    recommendation({ show_date: "2026-10-19" }),
    recommendation({ billing_position: 5 }),
    recommendation({ is_first_billed: true }),
    recommendation({ recommendation_key: "wrong" }),
  ]) {
    assert.throws(
      () => parseTrajectoryManifest(raw(manifest({ recommendations: [row] }))),
      TrajectoryContractError,
    );
  }
});

test("generation cannot precede the feature and decision dates", () => {
  assert.throws(
    () =>
      parseTrajectoryManifest(
        raw(
          manifest({
            generated_at_utc: "2026-07-19T23:59:59.999Z",
          }),
        ),
      ),
    /generated_at_utc cannot be before decision_date/,
  );
  assert.throws(
    () =>
      parseTrajectoryManifest(
        raw(manifest({ as_of_date: "2026-07-21" })),
      ),
    /as_of_date cannot be after decision_date/,
  );
});

test("ready model opinion is actionable only through its contract freshness bound", () => {
  const validUntil = new Date("2026-07-23T05:14:16.108Z");
  assert.equal(
    isTrajectoryRunActionable(
      { status: "ready", validUntil },
      new Date("2026-07-23T05:14:16.108Z"),
    ),
    true,
  );
  assert.equal(
    isTrajectoryRunActionable(
      { status: "ready", validUntil },
      new Date("2026-07-23T05:14:16.109Z"),
    ),
    false,
  );
  assert.equal(
    isTrajectoryRunActionable(
      { status: "superseded", validUntil },
      new Date("2026-07-21T00:00:00Z"),
    ),
    false,
  );
  assert.deepEqual(
    trajectoryActionableRunWhere(new Date("2026-07-21T00:00:00Z")),
    {
      producer: "artist_trajectory",
      status: "ready",
      validUntil: { gte: new Date("2026-07-21T00:00:00Z") },
    },
  );
});
