import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Prisma } from "@prisma/client";
import {
  createOperationDeadline,
  IntegrationSyncLeaseLostError,
  type IntegrationSyncLeaseGuard,
  type OperationDeadline,
} from "./integrationUtils";
import test from "node:test";
import {
  createPrismaTrajectoryImportPersistence,
  DEFAULT_TRAJECTORY_UNMAPPED_THRESHOLD,
  importTrajectoryManifest,
  TrajectoryImportError,
  type ExistingTrajectoryRun,
  type TrajectoryIdentitySnapshot,
  type TrajectoryImportPersistence,
  type TrajectoryImportTransaction,
} from "./trajectoryImport";
import { db } from "./db";

interface TestRun extends ExistingTrajectoryRun {
  producer: string;
  producerRunId: string;
  activatedAt: Date | null;
  generatedAt: Date;
}

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

function row(
  rank: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const eventId = 517000 + rank;
  const artistId = 113000 + rank;
  const arm = "trajectory";
  return {
    recommendation_key: `729c190d-2864-4c05-b51d-e82a843b6234:${eventId}:${arm}:${artistId}`,
    arm,
    list_rank: rank,
    is_suggested: rank === 1,
    slate_position: rank === 1 ? 1 : null,
    edmtrain_event_id: eventId,
    show_date: "2026-07-25",
    venue_name: "Exact Venue",
    event_name: `Event ${rank}`,
    edmtrain_artist_id: artistId,
    artist_name: `Source Artist ${rank}`,
    billing_position: 1,
    lineup_size: 2,
    is_first_billed: true,
    genres: ["House"],
    spotify_artist_id: null,
    ra_artist_id: null,
    evidence: evidence(),
    ...overrides,
  };
}

function manifest(
  nonSuggestedCount = 1,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const recommendations = Array.from(
    { length: nonSuggestedCount + 1 },
    (_, index) => row(index + 1),
  );
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
    recommendation_count: recommendations.length,
    recommendations,
    ...overrides,
  };
}

function raw(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

function exactSnapshot(value: Record<string, unknown>): TrajectoryIdentitySnapshot {
  const recommendations = value.recommendations as Array<
    Record<string, unknown>
  >;
  return {
    shows: recommendations.map((item) => ({
      id: `show-${item.edmtrain_event_id}`,
      edmtrainId: item.edmtrain_event_id as number,
    })),
    artists: recommendations.map((item) => ({
      id: `artist-${item.edmtrain_artist_id}`,
      edmtrainId: item.edmtrain_artist_id as number,
    })),
    memberships: recommendations.map((item) => ({
      showId: `show-${item.edmtrain_event_id}`,
      artistId: `artist-${item.edmtrain_artist_id}`,
    })),
  };
}

class MemoryPersistence implements TrajectoryImportPersistence {
  runs: TestRun[] = [];
  runArtists: Array<{ runId: string; artistId: string }> = [];
  recommendations: Array<{ runId: string; showId: string }> = [];
  issues: Array<{ runId: string; code: string }> = [];
  leaseCalls = 0;
  transactionCalls = 0;
  busy = false;
  loseLease = false;
  failPromotion = false;
  transactionNow = new Date("2026-07-21T12:00:00.000Z");
  transactionTimes: Date[] = [];
  beforeTransaction: (() => void) | null = null;

  constructor(readonly snapshot: TrajectoryIdentitySnapshot) {}

  async findExistingRun(
    producer: string,
    producerRunId: string,
  ): Promise<ExistingTrajectoryRun | null> {
    return (
      this.runs.find(
        (run) =>
          run.producer === producer && run.producerRunId === producerRunId,
      ) ?? null
    );
  }

  async loadIdentitySnapshot(): Promise<TrajectoryIdentitySnapshot> {
    return this.snapshot;
  }

  async withLease<T>(
    work: (lease: IntegrationSyncLeaseGuard) => Promise<T>,
    deadline: OperationDeadline,
  ): Promise<
    | { ok: true; status: "completed"; data: T }
    | {
        ok: false;
        status: "busy";
        reason: "lease_conflict";
        leaseKey: string;
        expiresAt: string | null;
        retryAfterMs: number | null;
      }
  > {
    void deadline;
    this.leaseCalls++;
    if (this.busy) {
      return {
        ok: false as const,
        status: "busy" as const,
        reason: "lease_conflict" as const,
        leaseKey: "integration-sync:artist-trajectory:test",
        expiresAt: null,
        retryAfterMs: null,
      };
    }
    const guard = {
      key: "integration-sync:artist-trajectory:test",
      ownerToken: "owner",
      async assertOwned() {},
      async fenceTransaction() {},
    };
    return {
      ok: true as const,
      status: "completed" as const,
      data: await work(guard),
    };
  }

  async withTransaction<T>(
    deadline: OperationDeadline,
    work: (transaction: TrajectoryImportTransaction) => Promise<T>,
  ): Promise<T> {
    void deadline;
    this.transactionCalls++;
    const before = structuredClone({
      runs: this.runs,
      runArtists: this.runArtists,
      recommendations: this.recommendations,
      issues: this.issues,
    });
    this.beforeTransaction?.();
    const transaction: TrajectoryImportTransaction = {
      findExistingRun: (producer, producerRunId) =>
        this.findExistingRun(producer, producerRunId),
      findReadyRun: async (producer) => {
        const ready = this.runs.find(
          (run) => run.producer === producer && run.status === "ready",
        );
        return ready
          ? { id: ready.id, generatedAt: ready.generatedAt }
          : null;
      },
      loadIdentitySnapshot: async () => this.snapshot,
      currentTime: async () =>
        this.transactionTimes.shift() ?? this.transactionNow,
      fence: async (lease) => {
        if (this.loseLease) {
          throw new IntegrationSyncLeaseLostError(lease.key);
        }
      },
      createRun: async ({ id, parsed }) => {
        this.runs.push({
          id,
          producer: parsed.manifest.producer,
          producerRunId: parsed.manifest.producer_run_id,
          artifactSha256: parsed.artifactSha256,
          status: "importing",
          activatedAt: null,
          generatedAt: parsed.generatedAt,
        });
      },
      createRunArtists: async (runId, artists) => {
        this.runArtists.push(
          ...artists.map((artist) => ({ runId, artistId: artist.artistId })),
        );
      },
      createRecommendations: async (runId, recommendations) => {
        this.recommendations.push(
          ...recommendations.map((item) => ({ runId, showId: item.showId })),
        );
      },
      createIssues: async (runId, issues) => {
        this.issues.push(
          ...issues.map((issue) => ({ runId, code: issue.code })),
        );
      },
      supersedeReadyRuns: async (producer) => {
        let count = 0;
        for (const run of this.runs) {
          if (run.producer === producer && run.status === "ready") {
            run.status = "superseded";
            count++;
          }
        }
        return count;
      },
      promoteRun: async (runId, activatedAt) => {
        if (this.failPromotion) throw new Error("simulated promotion failure");
        const run = this.runs.find((candidate) => candidate.id === runId);
        if (!run) throw new Error("missing run");
        run.status = "ready";
        run.activatedAt = activatedAt;
      },
    };
    try {
      return await work(transaction);
    } catch (error) {
      this.runs = before.runs;
      this.runArtists = before.runArtists;
      this.recommendations = before.recommendations;
      this.issues = before.issues;
      throw error;
    }
  }
}

test("exact EDMTrain mappings and ShowArtist membership import atomically", async () => {
  const value = manifest();
  const persistence = new MemoryPersistence(exactSnapshot(value));
  persistence.runs.push({
    id: "old-ready",
    producer: "artist_trajectory",
    producerRunId: "old-run",
    artifactSha256: "b".repeat(64),
    status: "ready",
    activatedAt: new Date("2026-07-19T00:00:00Z"),
    generatedAt: new Date("2026-07-19T00:00:00Z"),
  });

  const summary = await importTrajectoryManifest(raw(value), {
    persistence,
    now: () => new Date("2026-07-21T00:00:00Z"),
  });

  assert.equal(summary.status, "imported");
  assert.equal(summary.mappingValidation, "transaction-revalidated");
  assert.equal(summary.previousReadyRunsSuperseded, 1);
  assert.equal(persistence.runs.find((run) => run.id === "old-ready")?.status, "superseded");
  assert.equal(persistence.runs.filter((run) => run.status === "ready").length, 1);
  assert.equal(persistence.runArtists.length, 2);
  assert.equal(persistence.recommendations.length, 2);
  assert.equal(persistence.issues.length, 0);
});

test("names never provide fallback identity mapping", async () => {
  const value = manifest();
  const snapshot = exactSnapshot(value);
  snapshot.artists = [
    {
      id: "same-name-wrong-id",
      edmtrainId: 999999,
    },
  ];
  snapshot.memberships = [];
  const persistence = new MemoryPersistence(snapshot);

  await assert.rejects(
    importTrajectoryManifest(raw(value), { persistence }),
    (error: unknown) =>
      error instanceof TrajectoryImportError &&
      error.code === "trajectory_suggested_mapping_failed",
  );
  assert.equal(persistence.transactionCalls, 0);
});

test("missing membership rejects a suggested recommendation", async () => {
  const value = manifest();
  const snapshot = exactSnapshot(value);
  snapshot.memberships = snapshot.memberships.slice(1);
  const persistence = new MemoryPersistence(snapshot);

  await assert.rejects(
    importTrajectoryManifest(raw(value), { persistence }),
    /Suggested recommendation cannot be mapped exactly/,
  );
  assert.equal(persistence.runs.length, 0);
});

test("non-suggested mapping issues persist at the 2% default threshold", async () => {
  assert.equal(DEFAULT_TRAJECTORY_UNMAPPED_THRESHOLD, 0.02);
  const value = manifest(50);
  const snapshot = exactSnapshot(value);
  snapshot.shows = snapshot.shows.filter(
    (show) => show.edmtrainId !== 517051,
  );
  snapshot.memberships = snapshot.memberships.filter(
    (membership) => membership.showId !== "show-517051",
  );
  const persistence = new MemoryPersistence(snapshot);

  const summary = await importTrajectoryManifest(raw(value), { persistence });

  assert.equal(summary.status, "imported");
  assert.equal(summary.issueCount, 1);
  assert.equal(summary.unresolvedNonSuggestedRate, 0.02);
  assert.deepEqual(persistence.issues.map((issue) => issue.code), [
    "show_not_found",
  ]);
});

test("non-suggested mapping issues above 2% reject before writes", async () => {
  const value = manifest(49);
  const snapshot = exactSnapshot(value);
  snapshot.artists = snapshot.artists.filter(
    (artist) => artist.edmtrainId !== 113050,
  );
  const persistence = new MemoryPersistence(snapshot);

  await assert.rejects(
    importTrajectoryManifest(raw(value), { persistence }),
    (error: unknown) =>
      error instanceof TrajectoryImportError &&
      error.code === "trajectory_unmapped_threshold_exceeded",
  );
  assert.equal(persistence.transactionCalls, 0);
  assert.equal(persistence.issues.length, 0);
});

test("lease busy and lease loss never write or displace a ready run", async () => {
  const value = manifest();
  const busy = new MemoryPersistence(exactSnapshot(value));
  busy.busy = true;
  const busySummary = await importTrajectoryManifest(raw(value), {
    persistence: busy,
  });
  assert.equal(busySummary.status, "busy");
  assert.equal(busy.transactionCalls, 0);

  const lost = new MemoryPersistence(exactSnapshot(value));
  lost.loseLease = true;
  lost.runs.push({
    id: "old-ready",
    producer: "artist_trajectory",
    producerRunId: "old-run",
    artifactSha256: "b".repeat(64),
    status: "ready",
    activatedAt: new Date(),
    generatedAt: new Date("2026-07-19T00:00:00Z"),
  });
  await assert.rejects(
    importTrajectoryManifest(raw(value), { persistence: lost }),
    IntegrationSyncLeaseLostError,
  );
  assert.deepEqual(lost.runs.map((run) => [run.id, run.status]), [
    ["old-ready", "ready"],
  ]);
});

test("same producer run and digest is a no-op while a different digest conflicts", async () => {
  const value = manifest();
  const bytes = raw(value);
  const persistence = new MemoryPersistence(exactSnapshot(value));
  const first = await importTrajectoryManifest(bytes, { persistence });
  const second = await importTrajectoryManifest(bytes, { persistence });
  assert.equal(first.status, "imported");
  assert.equal(second.status, "noop");
  assert.equal(persistence.transactionCalls, 1);

  const changed = manifest(1, { validation_reference: "changed.md" });
  await assert.rejects(
    importTrajectoryManifest(raw(changed), { persistence }),
    (error: unknown) =>
      error instanceof TrajectoryImportError &&
      error.code === "trajectory_run_digest_conflict",
  );
  assert.equal(persistence.runs.filter((run) => run.status === "ready").length, 1);
});

test("promotion failure rolls back supersession and retains the old ready run", async () => {
  const value = manifest();
  const persistence = new MemoryPersistence(exactSnapshot(value));
  persistence.failPromotion = true;
  persistence.runs.push({
    id: "old-ready",
    producer: "artist_trajectory",
    producerRunId: "old-run",
    artifactSha256: "b".repeat(64),
    status: "ready",
    activatedAt: new Date("2026-07-19T00:00:00Z"),
    generatedAt: new Date("2026-07-19T00:00:00Z"),
  });

  await assert.rejects(
    importTrajectoryManifest(raw(value), { persistence }),
    /simulated promotion failure/,
  );
  assert.deepEqual(persistence.runs.map((run) => [run.id, run.status]), [
    ["old-ready", "ready"],
  ]);
  assert.equal(persistence.recommendations.length, 0);
});

test("membership changes between planning and promotion reject atomically", async () => {
  const value = manifest();
  const snapshot = exactSnapshot(value);
  const persistence = new MemoryPersistence(snapshot);
  persistence.runs.push({
    id: "old-ready",
    producer: "artist_trajectory",
    producerRunId: "old-run",
    artifactSha256: "b".repeat(64),
    status: "ready",
    activatedAt: new Date("2026-07-19T00:00:00Z"),
    generatedAt: new Date("2026-07-19T00:00:00Z"),
  });
  persistence.beforeTransaction = () => {
    snapshot.memberships = snapshot.memberships.slice(1);
  };

  await assert.rejects(
    importTrajectoryManifest(raw(value), {
      persistence,
      now: () => new Date("2026-07-21T12:00:00Z"),
    }),
    (error: unknown) =>
      error instanceof TrajectoryImportError &&
      error.code === "trajectory_mapping_changed",
  );
  assert.deepEqual(persistence.runs.map((run) => [run.id, run.status]), [
    ["old-ready", "ready"],
  ]);
  assert.equal(persistence.recommendations.length, 0);
});

test("expired and exact-boundary manifests reject before lease or writes", async () => {
  for (const importTime of [
    "2026-07-23T05:14:16.108Z",
    "2026-07-23T05:14:16.109Z",
  ]) {
    const value = manifest();
    const persistence = new MemoryPersistence(exactSnapshot(value));
    persistence.runs.push({
      id: "old-ready",
      producer: "artist_trajectory",
      producerRunId: "old-run",
      artifactSha256: "b".repeat(64),
      status: "ready",
      activatedAt: new Date("2026-07-19T00:00:00Z"),
      generatedAt: new Date("2026-07-19T00:00:00Z"),
    });

    await assert.rejects(
      importTrajectoryManifest(raw(value), {
        persistence,
        now: () => new Date(importTime),
      }),
      (error: unknown) =>
        error instanceof TrajectoryImportError &&
        error.code === "trajectory_manifest_stale",
    );
    assert.equal(persistence.leaseCalls, 0);
    assert.deepEqual(persistence.runs.map((run) => [run.id, run.status]), [
      ["old-ready", "ready"],
    ]);
  }
});

test("a manifest generated after import time is rejected before writes", async () => {
  const value = manifest();
  const persistence = new MemoryPersistence(exactSnapshot(value));
  await assert.rejects(
    importTrajectoryManifest(raw(value), {
      persistence,
      now: () => new Date("2026-07-20T05:14:16.107Z"),
    }),
    (error: unknown) =>
      error instanceof TrajectoryImportError &&
      error.code === "trajectory_contract_order_invalid",
  );
  assert.equal(persistence.leaseCalls, 0);
});

test("freshness is rechecked at transaction time before any insert", async () => {
  const value = manifest();
  const persistence = new MemoryPersistence(exactSnapshot(value));
  persistence.transactionNow = new Date("2026-07-23T05:14:16.108Z");
  persistence.runs.push({
    id: "old-ready",
    producer: "artist_trajectory",
    producerRunId: "old-run",
    artifactSha256: "b".repeat(64),
    status: "ready",
    activatedAt: new Date("2026-07-19T00:00:00Z"),
    generatedAt: new Date("2026-07-19T00:00:00Z"),
  });

  await assert.rejects(
    importTrajectoryManifest(raw(value), {
      persistence,
      now: () => new Date("2026-07-21T12:00:00Z"),
    }),
    (error: unknown) =>
      error instanceof TrajectoryImportError &&
      error.code === "trajectory_manifest_stale",
  );
  assert.deepEqual(persistence.runs.map((run) => [run.id, run.status]), [
    ["old-ready", "ready"],
  ]);
  assert.equal(persistence.runArtists.length, 0);
});

test("expiry during inserts rolls back before ready-run supersession", async () => {
  const value = manifest();
  const persistence = new MemoryPersistence(exactSnapshot(value));
  persistence.transactionTimes = [
    new Date("2026-07-23T05:14:16.107Z"),
    new Date("2026-07-23T05:14:16.108Z"),
  ];
  persistence.runs.push({
    id: "old-ready",
    producer: "artist_trajectory",
    producerRunId: "old-run",
    artifactSha256: "b".repeat(64),
    status: "ready",
    activatedAt: new Date("2026-07-19T00:00:00Z"),
    generatedAt: new Date("2026-07-19T00:00:00Z"),
  });

  await assert.rejects(
    importTrajectoryManifest(raw(value), {
      persistence,
      now: () => new Date("2026-07-21T12:00:00Z"),
    }),
    (error: unknown) =>
      error instanceof TrajectoryImportError &&
      error.code === "trajectory_manifest_stale",
  );
  assert.deepEqual(persistence.runs.map((run) => [run.id, run.status]), [
    ["old-ready", "ready"],
  ]);
  assert.equal(persistence.runArtists.length, 0);
  assert.equal(persistence.recommendations.length, 0);
});

test("an older generated run cannot supersede a newer ready run", async () => {
  const value = manifest();
  const persistence = new MemoryPersistence(exactSnapshot(value));
  persistence.runs.push({
    id: "newer-ready",
    producer: "artist_trajectory",
    producerRunId: "newer-run",
    artifactSha256: "b".repeat(64),
    status: "ready",
    activatedAt: new Date("2026-07-21T06:00:00Z"),
    generatedAt: new Date("2026-07-21T06:00:00Z"),
  });

  await assert.rejects(
    importTrajectoryManifest(raw(value), {
      persistence,
      now: () => new Date("2026-07-21T12:00:00Z"),
    }),
    (error: unknown) =>
      error instanceof TrajectoryImportError &&
      error.code === "trajectory_run_not_newer",
  );
  assert.deepEqual(persistence.runs.map((run) => [run.id, run.status]), [
    ["newer-ready", "ready"],
  ]);
  assert.equal(persistence.recommendations.length, 0);
});

test("dry-run plans exact mappings without lease acquisition or database writes", async () => {
  const value = manifest();
  const persistence = new MemoryPersistence(exactSnapshot(value));
  const summary = await importTrajectoryManifest(raw(value), {
    persistence,
    dryRun: true,
  });

  assert.equal(summary.status, "planned");
  assert.equal(summary.mode, "dry-run");
  assert.equal(summary.mappingValidation, "point-in-time");
  assert.equal(summary.mappedRecommendationCount, 2);
  assert.equal(persistence.leaseCalls, 0);
  assert.equal(persistence.transactionCalls, 0);
  assert.equal(persistence.runs.length, 0);
});

test("runtime importer has no canonical identity mutation or fallback surface", () => {
  const source = readFileSync(
    new URL("./trajectoryImport.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /(?:db|tx)\.(?:artist|show)\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)/,
  );
  assert.doesNotMatch(source, /normalizeArtistName|raArtistId.*find|name.*find/i);
  assert.match(
    source,
    /where: \{ edmtrainId: \{ in: \[\.\.\.edmtrainArtistIds\] \} \}/,
  );
  assert.match(
    source,
    /isolationLevel: Prisma\.TransactionIsolationLevel\.Serializable/,
  );
  assert.match(source, /error\.code === "P2034"/);
  const promotion = source.slice(
    source.indexOf("async function promoteTrajectoryImportPlan"),
  );
  assert.ok(
    promotion.indexOf("transaction.loadIdentitySnapshot(") <
      promotion.indexOf("transaction.createRun("),
  );
});

test("default promotion retries serialization failures within the deadline", async () => {
  type TransactionRunner = {
    $transaction<T>(
      callback: (tx: Prisma.TransactionClient) => Promise<T>,
      options?: {
        maxWait?: number;
        timeout?: number;
        isolationLevel?: Prisma.TransactionIsolationLevel;
      },
    ): Promise<T>;
  };
  const target = db as unknown as TransactionRunner;
  const descriptor = Object.getOwnPropertyDescriptor(db, "$transaction");
  const isolationLevels: Array<
    Prisma.TransactionIsolationLevel | undefined
  > = [];
  let attempts = 0;
  target.$transaction = async (callback, options) => {
    attempts++;
    isolationLevels.push(options?.isolationLevel);
    if (attempts === 1) {
      throw new Prisma.PrismaClientKnownRequestError(
        "serialization conflict",
        { code: "P2034", clientVersion: "test" },
      );
    }
    return callback({
      $queryRaw: async () => [],
    } as unknown as Prisma.TransactionClient);
  };

  try {
    const persistence = createPrismaTrajectoryImportPersistence();
    const result = await persistence.withTransaction(
      createOperationDeadline(120_000),
      async () => "completed",
    );
    assert.equal(result, "completed");
    assert.equal(attempts, 2);
    assert.deepEqual(isolationLevels, [
      Prisma.TransactionIsolationLevel.Serializable,
      Prisma.TransactionIsolationLevel.Serializable,
    ]);
  } finally {
    if (descriptor) Object.defineProperty(db, "$transaction", descriptor);
    else Reflect.deleteProperty(db, "$transaction");
  }
});
