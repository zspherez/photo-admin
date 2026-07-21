import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  createTrajectoryHmacSignature,
  handleTrajectoryIngestRequest,
  isTrustedTrajectoryOidcClaims,
  trajectoryHmacCanonicalMessage,
  type TrajectoryIngestClaim,
  type TrajectoryIngestMode,
  type TrajectoryIngestRequestPersistence,
  type TrajectoryIngestStoredRequest,
} from "./trajectoryIngest";
import type { TrajectoryImportSummary } from "./trajectoryImport";

const NOW = new Date("2026-07-21T20:00:00.000Z");
const SECRET = "dedicated-trajectory-hmac-secret-with-32-bytes";
const RECEIPT_SECRET =
  "dedicated-trajectory-receipt-secret-with-32-bytes";

function evidence() {
  return {
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
  };
}

function manifest(overrides: Record<string, unknown> = {}) {
  const producerRunId =
    (overrides.producer_run_id as string | undefined) ??
    "729c190d-2864-4c05-b51d-e82a843b6234";
  const recommendations = [
    {
      recommendation_key: `${producerRunId}:517001:trajectory:113001`,
      arm: "trajectory",
      list_rank: 1,
      is_suggested: true,
      slate_position: 1,
      edmtrain_event_id: 517001,
      show_date: "2026-07-25",
      venue_name: "Exact Venue",
      event_name: "Exact Event",
      edmtrain_artist_id: 113001,
      artist_name: "Exact Artist",
      billing_position: 1,
      lineup_size: 1,
      is_first_billed: true,
      genres: ["House"],
      spotify_artist_id: null,
      ra_artist_id: null,
      evidence: evidence(),
    },
  ];
  return {
    contract_version: "photo-admin-import-v1",
    producer: "artist_trajectory",
    producer_run_id: producerRunId,
    producer_schema_version: "artist-trajectory-decision-v3",
    generated_at_utc: "2026-07-21T18:00:00.000Z",
    as_of_date: "2026-07-21",
    decision_date: "2026-07-21",
    minimum_show_date: "2026-07-25",
    valid_until_date: "2026-10-19",
    model_status: "provisional_population_matched_event_momentum",
    validation_reference: "output/findings.md",
    full_artifact_sha256: "a".repeat(64),
    producer_revision: null,
    recommendation_count: recommendations.length,
    recommendations,
    ...overrides,
  };
}

function summary(
  mode: "dry-run" | "write",
  status: "planned" | "imported" | "noop" = "planned",
): TrajectoryImportSummary {
  return {
    mode,
    status,
    producerRunId: "729c190d-2864-4c05-b51d-e82a843b6234",
    artifactSha256: "a".repeat(64),
    artifactByteLength: 100,
    validUntil: "2026-07-24T18:00:00.000Z",
    recommendationCount: 1,
    mappedRecommendationCount: 1,
    suggestedRecommendationCount: 1,
    mappedSuggestedRecommendationCount: 1,
    nonSuggestedRecommendationCount: 0,
    mappedNonSuggestedRecommendationCount: 0,
    issueCount: 0,
    unresolvedNonSuggestedRate: 0,
    maximumUnmappedRate: 0.02,
    previousReadyRunsSuperseded: status === "imported" ? 1 : 0,
    runId: status === "imported" ? randomUUID() : null,
    mappingValidation:
      status === "imported"
        ? "transaction-revalidated"
        : "point-in-time",
  };
}

function summaryForRaw(
  raw: Buffer,
  mode: "dry-run" | "write",
  status: "planned" | "imported" | "noop",
): TrajectoryImportSummary {
  const value = JSON.parse(raw.toString("utf8"));
  return {
    ...summary(mode, status),
    producerRunId: value.producer_run_id,
    artifactSha256: createHash("sha256").update(raw).digest("hex"),
    artifactByteLength: raw.byteLength,
  };
}

class MemoryPersistence implements TrajectoryIngestRequestPersistence {
  readonly requests = new Map<string, TrajectoryIngestStoredRequest>();

  async claim(input: {
    idempotencyKey: string;
    producerRunId: string;
    artifactSha256: string;
    mode: TrajectoryIngestMode;
    producedAt: Date;
    now: Date;
  }): Promise<TrajectoryIngestClaim> {
    const existing = this.requests.get(input.idempotencyKey);
    if (existing) {
      if (
        existing.producerRunId !== input.producerRunId ||
        existing.artifactSha256 !== input.artifactSha256 ||
        existing.mode !== input.mode ||
        existing.producedAt.getTime() !== input.producedAt.getTime()
      ) {
        return { kind: "conflict" };
      }
      if (
        existing.status === "completed" &&
        existing.response &&
        existing.httpStatus
      ) {
        return {
          kind: "replay",
          response: existing.response,
          httpStatus: existing.httpStatus,
        };
      }
      return { kind: "busy" };
    }
    const ownerToken = randomUUID();
    this.requests.set(input.idempotencyKey, {
      idempotencyKey: input.idempotencyKey,
      ownerToken,
      producerRunId: input.producerRunId,
      artifactSha256: input.artifactSha256,
      mode: input.mode,
      producedAt: input.producedAt,
      status: "processing",
      response: null,
      httpStatus: null,
      updatedAt: input.now,
    });
    return { kind: "claimed", ownerToken };
  }

  async complete(input: {
    idempotencyKey: string;
    ownerToken: string;
    response: Record<string, unknown>;
    httpStatus: number;
    completedAt: Date;
  }): Promise<void> {
    const request = this.requests.get(input.idempotencyKey);
    assert.equal(request?.ownerToken, input.ownerToken);
    this.requests.set(input.idempotencyKey, {
      ...request!,
      status: "completed",
      response: input.response,
      httpStatus: input.httpStatus,
      updatedAt: input.completedAt,
    });
  }

  async abandon(
    idempotencyKey: string,
    ownerToken: string,
  ): Promise<void> {
    const request = this.requests.get(idempotencyKey);
    if (request?.ownerToken === ownerToken) {
      this.requests.delete(idempotencyKey);
    }
  }
}

function signedRequest(input: {
  value?: Record<string, unknown>;
  mode: TrajectoryIngestMode;
  idempotencyKey: string;
  producedAt?: string;
  confirmation?: string;
  dryRunReceipt?: string;
  protocol?: "http" | "https";
  digestOverride?: string;
}): Request {
  const raw = Buffer.from(JSON.stringify(input.value ?? manifest()));
  const digest =
    input.digestOverride ??
    createHash("sha256").update(raw).digest("hex");
  const producedAt = input.producedAt ?? NOW.toISOString();
  const confirmation = input.confirmation ?? "";
  const dryRunReceipt = input.dryRunReceipt ?? "";
  const canonical = trajectoryHmacCanonicalMessage({
    idempotencyKey: input.idempotencyKey,
    producedAt,
    artifactSha256: digest,
    mode: input.mode,
    contentLength: raw.byteLength,
    applyConfirmation: confirmation,
    dryRunReceipt,
  });
  return new Request(
    `${input.protocol ?? "https"}://photo-admin.example/api/integrations/trajectory-runs`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(raw.byteLength),
        "Idempotency-Key": input.idempotencyKey,
        "X-Produced-At": producedAt,
        "X-Content-SHA256": digest,
        "X-Trajectory-Mode": input.mode,
        "X-Trajectory-Apply-Confirmation": confirmation,
        "X-Trajectory-Dry-Run-Receipt": dryRunReceipt,
        "X-Signature": createTrajectoryHmacSignature(
          SECRET,
          canonical,
        ),
      },
      body: raw,
    },
  );
}

const environment = {
  TRAJECTORY_INGEST_AUTH_MODE: "hmac",
  TRAJECTORY_INGEST_HMAC_SECRET: SECRET,
  TRAJECTORY_INGEST_RECEIPT_SECRET: RECEIPT_SECRET,
};

test("OIDC claims are pinned to repository, owner, main workflow, event, audience, and SHA", () => {
  const configuration = {
    repository: "producer/artist-trajectory",
    owner: "producer",
    workflowRef:
      "producer/artist-trajectory/.github/workflows/promote-photo-admin.yml@refs/heads/main",
  };
  const claims = {
    aud: "photo-admin-trajectory-ingest",
    repository: configuration.repository,
    repository_owner: configuration.owner,
    ref: "refs/heads/main",
    workflow_ref: configuration.workflowRef,
    event_name: "workflow_dispatch",
    sha: "a".repeat(40),
  };
  assert.equal(
    isTrustedTrajectoryOidcClaims(claims, configuration),
    true,
  );
  for (const [key, value] of [
    ["repository", "other/repo"],
    ["repository_owner", "other"],
    ["ref", "refs/heads/feature"],
    ["workflow_ref", "producer/artist-trajectory/.github/workflows/other.yml@refs/heads/main"],
    ["event_name", "schedule"],
    ["aud", "other-audience"],
    ["sha", "short"],
  ]) {
    assert.equal(
      isTrustedTrajectoryOidcClaims(
        { ...claims, [key]: value },
        configuration,
      ),
      false,
      key,
    );
  }
});

test("dry-run is write-free, proves mapping thresholds, and enables explicitly confirmed apply", async () => {
  const persistence = new MemoryPersistence();
  const calls: boolean[] = [];
  const importManifest = async (
    raw: Buffer,
    options: { dryRun?: boolean },
  ) => {
    calls.push(Boolean(options.dryRun));
    return options.dryRun
      ? summaryForRaw(raw, "dry-run", "planned")
      : summaryForRaw(raw, "write", "imported");
  };

  const dryRun = await handleTrajectoryIngestRequest(
    signedRequest({
      mode: "dry-run",
      idempotencyKey: "run-dry-001",
    }),
    { environment, now: () => NOW, persistence, importManifest },
  );
  assert.equal(dryRun.status, 200);
  const dryRunBody = await dryRun.json();
  assert.equal(dryRunBody.summary.mappedSuggestedRecommendationCount, 1);
  assert.equal(dryRunBody.summary.unresolvedNonSuggestedRate, 0);
  assert.equal(dryRunBody.summary.maximumUnmappedRate, 0.02);
  assert.equal(typeof dryRunBody.dryRunReceipt, "string");
  assert.equal(persistence.requests.size, 0);

  const value = manifest();
  const raw = Buffer.from(JSON.stringify(value));
  const digest = createHash("sha256").update(raw).digest("hex");
  const confirmation =
    `apply:${value.producer_run_id}:${digest}`;
  const apply = await handleTrajectoryIngestRequest(
    signedRequest({
      value,
      mode: "apply",
      idempotencyKey: "run-apply-001",
      confirmation,
      dryRunReceipt: dryRunBody.dryRunReceipt,
    }),
    { environment, now: () => NOW, persistence, importManifest },
  );
  assert.equal(apply.status, 201);
  assert.deepEqual(calls, [true, false]);
});

test("apply rejects without a successful exact-digest dry-run receipt or exact confirmation", async () => {
  const persistence = new MemoryPersistence();
  const noConfirmation = await handleTrajectoryIngestRequest(
    signedRequest({
      mode: "apply",
      idempotencyKey: "run-apply-002",
    }),
    { environment, now: () => NOW, persistence },
  );
  assert.equal(noConfirmation.status, 428);

  const value = manifest();
  const raw = Buffer.from(JSON.stringify(value));
  const digest = createHash("sha256").update(raw).digest("hex");
  const noDryRun = await handleTrajectoryIngestRequest(
    signedRequest({
      value,
      mode: "apply",
      idempotencyKey: "run-apply-003",
      confirmation: `apply:${value.producer_run_id}:${digest}`,
    }),
    { environment, now: () => NOW, persistence },
  );
  assert.equal(noDryRun.status, 428);
  assert.equal(
    (await noDryRun.json()).error.code,
    "trajectory_dry_run_receipt_invalid",
  );
});

test("identical idempotency replay returns the stored response and conflicting reuse rejects", async () => {
  const persistence = new MemoryPersistence();
  let calls = 0;
  const dryRun = await handleTrajectoryIngestRequest(
    signedRequest({
      mode: "dry-run",
      idempotencyKey: "run-replay-dry-001",
    }),
    {
      environment,
      now: () => NOW,
      persistence,
      importManifest: async (raw) =>
        summaryForRaw(raw, "dry-run", "planned"),
    },
  );
  const dryRunReceipt = (await dryRun.json()).dryRunReceipt;
  const value = manifest();
  const raw = Buffer.from(JSON.stringify(value));
  const digest = createHash("sha256").update(raw).digest("hex");
  const request = () =>
    signedRequest({
      value,
      mode: "apply",
      idempotencyKey: "run-replay-001",
      confirmation: `apply:${value.producer_run_id}:${digest}`,
      dryRunReceipt,
    });
  const dependencies = {
    environment,
    now: () => NOW,
    persistence,
    importManifest: async (raw: Buffer) => {
      calls++;
      return summaryForRaw(raw, "write", "imported");
    },
  };
  assert.equal(
    (await handleTrajectoryIngestRequest(request(), dependencies))
      .status,
    201,
  );
  const replay = await handleTrajectoryIngestRequest(
    request(),
    dependencies,
  );
  assert.equal(replay.status, 201);
  assert.equal((await replay.json()).replayed, true);
  assert.equal(calls, 1);

  const changedValue = manifest({ validation_reference: "changed.md" });
  const changedDryRun = await handleTrajectoryIngestRequest(
    signedRequest({
      value: changedValue,
      mode: "dry-run",
      idempotencyKey: "run-replay-dry-002",
    }),
    {
      environment,
      now: () => NOW,
      persistence,
      importManifest: async (raw) =>
        summaryForRaw(raw, "dry-run", "planned"),
    },
  );
  const changedReceipt = (await changedDryRun.json()).dryRunReceipt;
  const changedRaw = Buffer.from(JSON.stringify(changedValue));
  const changedDigest = createHash("sha256")
    .update(changedRaw)
    .digest("hex");
  const conflict = await handleTrajectoryIngestRequest(
    signedRequest({
      value: changedValue,
      mode: "apply",
      idempotencyKey: "run-replay-001",
      confirmation:
        `apply:${changedValue.producer_run_id}:${changedDigest}`,
      dryRunReceipt: changedReceipt,
    }),
    dependencies,
  );
  assert.equal(conflict.status, 409);
  assert.equal(
    (await conflict.json()).error.code,
    "trajectory_idempotency_conflict",
  );
});

test("request transport rejects stale timestamps, digest mismatch, oversized declarations, and production HTTP", async () => {
  const persistence = new MemoryPersistence();
  const stale = await handleTrajectoryIngestRequest(
    signedRequest({
      mode: "dry-run",
      idempotencyKey: "run-stale-001",
      producedAt: "2026-07-21T19:40:00.000Z",
    }),
    { environment, now: () => NOW, persistence },
  );
  assert.equal(stale.status, 409);

  const digestMismatch = await handleTrajectoryIngestRequest(
    signedRequest({
      mode: "dry-run",
      idempotencyKey: "run-digest-001",
      digestOverride: "b".repeat(64),
    }),
    { environment, now: () => NOW, persistence },
  );
  assert.equal(digestMismatch.status, 400);

  const oversized = new Request(
    "https://photo-admin.example/api/integrations/trajectory-runs",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": "1000001",
        "Idempotency-Key": "run-large-001",
        "X-Produced-At": NOW.toISOString(),
        "X-Content-SHA256": "a".repeat(64),
        "X-Trajectory-Mode": "dry-run",
      },
      body: "{}",
    },
  );
  assert.equal(
    (
      await handleTrajectoryIngestRequest(oversized, {
        environment,
        now: () => NOW,
        persistence,
      })
    ).status,
    413,
  );

  const insecure = await handleTrajectoryIngestRequest(
    signedRequest({
      mode: "dry-run",
      idempotencyKey: "run-http-001",
      protocol: "http",
    }),
    {
      environment: {
        ...environment,
        NODE_ENV: "production",
      },
      now: () => NOW,
      persistence,
    },
  );
  assert.equal(insecure.status, 400);
});

test("contract failures never echo producer-controlled data URLs", async () => {
  const value = manifest();
  value.recommendations[0].recommendation_key =
    "data:text/plain,do-not-echo";
  const response = await handleTrajectoryIngestRequest(
    signedRequest({
      value,
      mode: "dry-run",
      idempotencyKey: "run-redact-001",
    }),
    {
      environment,
      now: () => NOW,
      persistence: new MemoryPersistence(),
    },
  );
  const text = await response.text();
  assert.equal(response.status, 400);
  assert.doesNotMatch(text, /data:/);
});
