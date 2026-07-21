import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  assertOperationTimeRemaining,
  createOperationDeadline,
  makeIntegrationSyncLeaseKey,
  minimumDeadlineTransactionRemainingMs,
  runDeadlineBoundTransaction,
  withIntegrationSyncLease,
  type DeadlineTransactionPolicy,
  type IntegrationSyncLeaseBusyResult,
  type IntegrationSyncLeaseGuard,
  type OperationDeadline,
} from "@/lib/integrationUtils";
import {
  parseTrajectoryManifest,
  TRAJECTORY_PRODUCER,
  TRAJECTORY_STALE_AFTER_HOURS,
  type ParsedTrajectoryManifest,
  type TrajectoryManifestRecommendation,
} from "@/lib/trajectoryContract";

export const TRAJECTORY_IMPORT_LEASE_KEY = makeIntegrationSyncLeaseKey(
  "artist-trajectory",
  "production",
);
export const DEFAULT_TRAJECTORY_UNMAPPED_THRESHOLD = 0.02;

const TRAJECTORY_IMPORT_OPERATION_MS = 5 * 60 * 1_000;
const TRAJECTORY_IMPORT_TRANSACTION = {
  operation: "Artist trajectory import promotion",
  maxWaitMs: 10_000,
  timeoutMs: 120_000,
  minimumTimeoutMs: 30_000,
  lockTimeoutMs: 10_000,
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
} satisfies DeadlineTransactionPolicy;

export type TrajectoryImportIssueCode =
  | "show_not_found"
  | "artist_not_found"
  | "show_artist_membership_missing";

export class TrajectoryImportError extends Error {
  constructor(
    readonly code:
      | "trajectory_run_digest_conflict"
      | "trajectory_suggested_mapping_failed"
      | "trajectory_unmapped_threshold_exceeded"
      | "trajectory_artist_assessment_conflict"
      | "trajectory_mapping_changed"
      | "trajectory_manifest_stale"
      | "trajectory_run_not_newer"
      | "trajectory_contract_order_invalid",
    message: string,
  ) {
    super(message);
    this.name = "TrajectoryImportError";
  }
}

export interface ExistingTrajectoryRun {
  id: string;
  artifactSha256: string;
  status: string;
}

export interface ReadyTrajectoryRun {
  id: string;
  generatedAt: Date;
}

export interface TrajectoryIdentitySnapshot {
  shows: Array<{ id: string; edmtrainId: number }>;
  artists: Array<{ id: string; edmtrainId: number }>;
  memberships: Array<{ showId: string; artistId: string }>;
}

export interface TrajectoryImportIssuePlan {
  id: string;
  recommendationKey: string;
  code: TrajectoryImportIssueCode;
  detail: {
    edmtrainEventId: number;
    edmtrainArtistId: number;
    arm: string;
    isSuggested: boolean;
  };
}

export interface TrajectoryRunArtistPlan {
  id: string;
  artistId: string;
  edmtrainArtistId: number;
  sourceName: string;
  spotifyArtistId: string | null;
  raArtistId: string | null;
  coverageState: string;
  momentumBand: string | null;
  isEarlyStage: boolean;
  isEstablished: boolean;
  isVeteran: boolean;
  eventDelta6m: number | null;
  eventsPrior6m: number | null;
  eventsRecent6m: number | null;
  marketsPrior6m: number | null;
  marketsRecent6m: number | null;
  careerAgeYears: number | null;
  analogSummary: unknown | null;
  releaseContext: unknown;
  genres: string[];
}

export interface TrajectoryRecommendationPlan {
  id: string;
  showId: string;
  edmtrainEventId: number;
  runArtistId: string;
  arm: string;
  listRank: number;
  isSuggested: boolean;
  slatePosition: number | null;
  billingPosition: number;
  lineupSize: number;
  isFirstBilled: boolean;
  rationale: {
    sourceShowDate: string;
    sourceVenueName: string;
    sourceEventName: string;
  };
  sourceFingerprint: string;
}

export interface TrajectoryImportWritePlan {
  kind: "write";
  parsed: ParsedTrajectoryManifest;
  runId: string;
  runArtists: TrajectoryRunArtistPlan[];
  recommendations: TrajectoryRecommendationPlan[];
  issues: TrajectoryImportIssuePlan[];
  nonSuggestedCount: number;
  unresolvedNonSuggestedCount: number;
  unresolvedNonSuggestedRate: number;
}

export interface TrajectoryImportNoopPlan {
  kind: "noop";
  parsed: ParsedTrajectoryManifest;
  existingRunId: string;
}

export type TrajectoryImportPlan =
  | TrajectoryImportWritePlan
  | TrajectoryImportNoopPlan;

export interface TrajectoryImportSummary {
  mode: "dry-run" | "write";
  status: "planned" | "imported" | "noop" | "busy";
  producerRunId: string;
  artifactSha256: string;
  artifactByteLength: number;
  validUntil: string;
  recommendationCount: number;
  mappedRecommendationCount: number;
  issueCount: number;
  unresolvedNonSuggestedRate: number;
  previousReadyRunsSuperseded: number;
  runId: string | null;
  mappingValidation:
    | "point-in-time"
    | "transaction-revalidated"
    | "not-performed";
  lease?: IntegrationSyncLeaseBusyResult;
}

interface TrajectoryRunCreateInput {
  id: string;
  parsed: ParsedTrajectoryManifest;
  summary: Record<string, unknown>;
}

export interface TrajectoryImportTransaction {
  findExistingRun(
    producer: string,
    producerRunId: string,
  ): Promise<ExistingTrajectoryRun | null>;
  findReadyRun(producer: string): Promise<ReadyTrajectoryRun | null>;
  loadIdentitySnapshot(
    edmtrainEventIds: readonly number[],
    edmtrainArtistIds: readonly number[],
  ): Promise<TrajectoryIdentitySnapshot>;
  currentTime(): Promise<Date>;
  fence(lease: IntegrationSyncLeaseGuard): Promise<void>;
  createRun(input: TrajectoryRunCreateInput): Promise<void>;
  createRunArtists(
    runId: string,
    artists: readonly TrajectoryRunArtistPlan[],
  ): Promise<void>;
  createRecommendations(
    runId: string,
    recommendations: readonly TrajectoryRecommendationPlan[],
  ): Promise<void>;
  createIssues(
    runId: string,
    issues: readonly TrajectoryImportIssuePlan[],
  ): Promise<void>;
  supersedeReadyRuns(producer: string): Promise<number>;
  promoteRun(runId: string, activatedAt: Date): Promise<void>;
}

export interface TrajectoryImportPersistence {
  findExistingRun(
    producer: string,
    producerRunId: string,
  ): Promise<ExistingTrajectoryRun | null>;
  loadIdentitySnapshot(
    edmtrainEventIds: readonly number[],
    edmtrainArtistIds: readonly number[],
  ): Promise<TrajectoryIdentitySnapshot>;
  withLease<T>(
    work: (lease: IntegrationSyncLeaseGuard) => Promise<T>,
    deadline: OperationDeadline,
  ): Promise<
    | { ok: true; status: "completed"; data: T }
    | IntegrationSyncLeaseBusyResult
  >;
  withTransaction<T>(
    deadline: OperationDeadline,
    work: (transaction: TrajectoryImportTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface TrajectoryImportOptions {
  dryRun?: boolean;
  expectedDigest?: string | null;
  maximumUnmappedRate?: number;
  deadline?: OperationDeadline;
  now?: () => Date;
  persistence?: TrajectoryImportPersistence;
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function isRetryableTrajectoryTransactionError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2034"
  );
}

async function runTrajectorySerializableTransaction<T>(
  deadline: OperationDeadline,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await runDeadlineBoundTransaction(
        deadline,
        TRAJECTORY_IMPORT_TRANSACTION,
        work,
      );
    } catch (error) {
      if (
        attempt < 3 &&
        isRetryableTrajectoryTransactionError(error)
      ) {
        assertOperationTimeRemaining(
          deadline,
          minimumDeadlineTransactionRemainingMs(
            TRAJECTORY_IMPORT_TRANSACTION,
          ),
          "Retry artist trajectory serializable promotion",
        );
        continue;
      }
      throw error;
    }
  }
  throw new Error("Unable to complete artist trajectory promotion");
}

export function createPrismaTrajectoryImportPersistence(): TrajectoryImportPersistence {
  return {
    async findExistingRun(producer, producerRunId) {
      return db.trajectoryModelRun.findUnique({
        where: {
          producer_producerRunId: { producer, producerRunId },
        },
        select: { id: true, artifactSha256: true, status: true },
      });
    },
    async loadIdentitySnapshot(edmtrainEventIds, edmtrainArtistIds) {
      const [shows, artists] = await Promise.all([
        db.show.findMany({
          where: { edmtrainId: { in: [...edmtrainEventIds] } },
          select: { id: true, edmtrainId: true },
        }),
        db.artist.findMany({
          where: { edmtrainId: { in: [...edmtrainArtistIds] } },
          select: { id: true, edmtrainId: true },
        }),
      ]);
      const usableShows = shows.flatMap((show) =>
        show.edmtrainId === null
          ? []
          : [{ id: show.id, edmtrainId: show.edmtrainId }],
      );
      const usableArtists = artists.flatMap((artist) =>
        artist.edmtrainId === null
          ? []
          : [
              {
                id: artist.id,
                edmtrainId: artist.edmtrainId,
              },
            ],
      );
      const memberships = await db.showArtist.findMany({
        where: {
          showId: { in: usableShows.map((show) => show.id) },
          artistId: { in: usableArtists.map((artist) => artist.id) },
        },
        select: { showId: true, artistId: true },
      });
      return { shows: usableShows, artists: usableArtists, memberships };
    },
    withLease(work, deadline) {
      return withIntegrationSyncLease(TRAJECTORY_IMPORT_LEASE_KEY, work, {
        deadline,
        minimumRemainingMs: minimumDeadlineTransactionRemainingMs(
          TRAJECTORY_IMPORT_TRANSACTION,
        ),
      });
    },
    withTransaction(deadline, work) {
      return runTrajectorySerializableTransaction(
        deadline,
        async (tx) =>
          work({
            async findExistingRun(producer, producerRunId) {
              return tx.trajectoryModelRun.findUnique({
                where: {
                  producer_producerRunId: { producer, producerRunId },
                },
                select: { id: true, artifactSha256: true, status: true },
              });
            },
            findReadyRun(producer) {
              return tx.trajectoryModelRun.findFirst({
                where: { producer, status: "ready" },
                select: { id: true, generatedAt: true },
              });
            },
            async loadIdentitySnapshot(
              edmtrainEventIds,
              edmtrainArtistIds,
            ) {
              const [shows, artists] = await Promise.all([
                tx.show.findMany({
                  where: { edmtrainId: { in: [...edmtrainEventIds] } },
                  select: { id: true, edmtrainId: true },
                }),
                tx.artist.findMany({
                  where: { edmtrainId: { in: [...edmtrainArtistIds] } },
                  select: { id: true, edmtrainId: true },
                }),
              ]);
              const usableShows = shows.flatMap((show) =>
                show.edmtrainId === null
                  ? []
                  : [{ id: show.id, edmtrainId: show.edmtrainId }],
              );
              const usableArtists = artists.flatMap((artist) =>
                artist.edmtrainId === null
                  ? []
                  : [{ id: artist.id, edmtrainId: artist.edmtrainId }],
              );
              const memberships = await tx.showArtist.findMany({
                where: {
                  showId: { in: usableShows.map((show) => show.id) },
                  artistId: {
                    in: usableArtists.map((artist) => artist.id),
                  },
                },
                select: { showId: true, artistId: true },
              });
              return {
                shows: usableShows,
                artists: usableArtists,
                memberships,
              };
            },
            async currentTime() {
              const rows = await tx.$queryRaw<Array<{ now: Date }>>(
                Prisma.sql`SELECT clock_timestamp() AS "now"`,
              );
              const current = rows[0]?.now;
              if (!current) {
                throw new Error("Unable to read transaction time");
              }
              return current;
            },
            fence(lease) {
              return lease.fenceTransaction(tx);
            },
            async createRun({ id, parsed, summary }) {
              const manifest = parsed.manifest;
              await tx.trajectoryModelRun.create({
                data: {
                  id,
                  producer: manifest.producer,
                  producerRunId: manifest.producer_run_id,
                  contractVersion: manifest.contract_version,
                  producerSchemaVersion: manifest.producer_schema_version,
                  artifactSha256: parsed.artifactSha256,
                  fullArtifactSha256: manifest.full_artifact_sha256,
                  artifactByteLength: parsed.artifactByteLength,
                  producerRevision: manifest.producer_revision,
                  generatedAt: parsed.generatedAt,
                  asOfDate: parsed.asOfDate,
                  decisionDate: parsed.decisionDate,
                  minimumShowDate: parsed.minimumShowDate,
                  validUntil: parsed.validUntil,
                  modelStatus: manifest.model_status,
                  validationReference: manifest.validation_reference,
                  status: "importing",
                  summary: asJson(summary),
                },
              });
            },
            async createRunArtists(runId, artists) {
              if (artists.length === 0) return;
              await tx.trajectoryRunArtist.createMany({
                data: artists.map((artist) => ({
                  id: artist.id,
                  runId,
                  artistId: artist.artistId,
                  edmtrainArtistId: artist.edmtrainArtistId,
                  sourceName: artist.sourceName,
                  spotifyArtistId: artist.spotifyArtistId,
                  raArtistId: artist.raArtistId,
                  coverageState: artist.coverageState as
                    | "C_covered"
                    | "U0_unresolved"
                    | "U1_no_history"
                    | "U2_thin_history"
                    | "Q_query_incomplete"
                    | "Q_query_failure"
                    | "J_junk",
                  momentumBand: artist.momentumBand,
                  isEarlyStage: artist.isEarlyStage,
                  isEstablished: artist.isEstablished,
                  isVeteran: artist.isVeteran,
                  eventDelta6m: artist.eventDelta6m,
                  eventsPrior6m: artist.eventsPrior6m,
                  eventsRecent6m: artist.eventsRecent6m,
                  marketsPrior6m: artist.marketsPrior6m,
                  marketsRecent6m: artist.marketsRecent6m,
                  careerAgeYears: artist.careerAgeYears,
                  analogSummary:
                    artist.analogSummary === null
                      ? Prisma.DbNull
                      : asJson(artist.analogSummary),
                  releaseContext: asJson(artist.releaseContext),
                  genres: asJson(artist.genres),
                })),
              });
            },
            async createRecommendations(runId, recommendations) {
              if (recommendations.length === 0) return;
              await tx.trajectoryRecommendation.createMany({
                data: recommendations.map((recommendation) => ({
                  id: recommendation.id,
                  runId,
                  showId: recommendation.showId,
                  runArtistId: recommendation.runArtistId,
                  arm: recommendation.arm as
                    | "trajectory"
                    | "momentum"
                    | "exploration"
                    | "portfolio",
                  listRank: recommendation.listRank,
                  isSuggested: recommendation.isSuggested,
                  slatePosition: recommendation.slatePosition,
                  billingPosition: recommendation.billingPosition,
                  lineupSize: recommendation.lineupSize,
                  isFirstBilled: recommendation.isFirstBilled,
                  rationale: asJson(recommendation.rationale),
                  sourceFingerprint:
                    recommendation.sourceFingerprint,
                })),
              });
            },
            async createIssues(runId, issues) {
              if (issues.length === 0) return;
              await tx.trajectoryImportIssue.createMany({
                data: issues.map((issue) => ({
                  id: issue.id,
                  runId,
                  recommendationKey: issue.recommendationKey,
                  code: issue.code,
                  detail: asJson(issue.detail),
                })),
              });
            },
            async supersedeReadyRuns(producer) {
              const result = await tx.trajectoryModelRun.updateMany({
                where: { producer, status: "ready" },
                data: { status: "superseded" },
              });
              return result.count;
            },
            async promoteRun(runId, activatedAt) {
              await tx.trajectoryModelRun.update({
                where: { id: runId },
                data: { status: "ready", activatedAt },
              });
            },
          }),
      );
    },
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sourceFingerprint(row: TrajectoryManifestRecommendation): string {
  return createHash("sha256").update(stableJson(row)).digest("hex");
}

function artistAssessment(row: TrajectoryManifestRecommendation) {
  return {
    sourceName: row.artist_name,
    spotifyArtistId: row.spotify_artist_id,
    raArtistId: row.ra_artist_id,
    coverageState: row.evidence.coverage_state,
    momentumBand: row.evidence.momentum_band,
    isEarlyStage: row.evidence.is_early_stage,
    isEstablished: row.evidence.is_established,
    isVeteran: row.evidence.is_veteran,
    eventDelta6m: row.evidence.event_delta_6m,
    eventsPrior6m: row.evidence.events_prior_6m,
    eventsRecent6m: row.evidence.events_recent_6m,
    marketsPrior6m: row.evidence.markets_prior_6m,
    marketsRecent6m: row.evidence.markets_recent_6m,
    careerAgeYears: row.evidence.career_age_years,
    analogSummary: row.evidence.analog_summary,
    releaseContext: row.evidence.release_context,
    genres: row.genres,
  };
}

function mappingIssue(
  row: TrajectoryManifestRecommendation,
  code: TrajectoryImportIssueCode,
): TrajectoryImportIssuePlan {
  return {
    id: randomUUID(),
    recommendationKey: row.recommendation_key,
    code,
    detail: {
      edmtrainEventId: row.edmtrain_event_id,
      edmtrainArtistId: row.edmtrain_artist_id,
      arm: row.arm,
      isSuggested: row.is_suggested,
    },
  };
}

function assertThreshold(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("maximumUnmappedRate must be between 0 and 1");
  }
}

function assertTrajectoryImportableAt(
  parsed: ParsedTrajectoryManifest,
  importTime: Date,
): void {
  if (
    parsed.asOfDate.getTime() > parsed.decisionDate.getTime() ||
    parsed.decisionDate.getTime() > parsed.generatedAt.getTime() ||
    parsed.generatedAt.getTime() > importTime.getTime()
  ) {
    throw new TrajectoryImportError(
      "trajectory_contract_order_invalid",
      "Trajectory manifest timestamps violate as-of, decision, and generation ordering",
    );
  }
  if (parsed.validUntil.getTime() <= importTime.getTime()) {
    throw new TrajectoryImportError(
      "trajectory_manifest_stale",
      "Trajectory manifest freshness expired before import",
    );
  }
}

function assertTrajectoryMappingsUnchanged(
  plan: TrajectoryImportWritePlan,
  snapshot: TrajectoryIdentitySnapshot,
): void {
  const shows = new Map(snapshot.shows.map((show) => [show.edmtrainId, show.id]));
  const artists = new Map(
    snapshot.artists.map((artist) => [artist.edmtrainId, artist.id]),
  );
  const memberships = new Set(
    snapshot.memberships.map(
      (membership) => `${membership.showId}:${membership.artistId}`,
    ),
  );
  const runArtists = new Map(
    plan.runArtists.map((artist) => [artist.id, artist]),
  );

  for (const recommendation of plan.recommendations) {
    if (
      shows.get(recommendation.edmtrainEventId) !==
      recommendation.showId
    ) {
      throw new TrajectoryImportError(
        "trajectory_mapping_changed",
        "Trajectory show identity changed before promotion",
      );
    }
    const runArtist = runArtists.get(recommendation.runArtistId);
    if (
      !runArtist ||
      artists.get(runArtist.edmtrainArtistId) !== runArtist.artistId
    ) {
      throw new TrajectoryImportError(
        "trajectory_mapping_changed",
        "Trajectory artist identity changed before promotion",
      );
    }
    if (
      !memberships.has(
        `${recommendation.showId}:${runArtist.artistId}`,
      )
    ) {
      throw new TrajectoryImportError(
        "trajectory_mapping_changed",
        "Trajectory show membership changed before promotion",
      );
    }
  }
}

export async function buildTrajectoryImportPlan(
  parsed: ParsedTrajectoryManifest,
  persistence: TrajectoryImportPersistence,
  maximumUnmappedRate = DEFAULT_TRAJECTORY_UNMAPPED_THRESHOLD,
): Promise<TrajectoryImportPlan> {
  assertThreshold(maximumUnmappedRate);
  const manifest = parsed.manifest;
  const existing = await persistence.findExistingRun(
    manifest.producer,
    manifest.producer_run_id,
  );
  if (existing) {
    if (existing.artifactSha256 !== parsed.artifactSha256) {
      throw new TrajectoryImportError(
        "trajectory_run_digest_conflict",
        "The producer run ID already exists with a different manifest digest",
      );
    }
    return {
      kind: "noop",
      parsed,
      existingRunId: existing.id,
    };
  }

  const eventIds = Array.from(
    new Set(manifest.recommendations.map((row) => row.edmtrain_event_id)),
  );
  const artistIds = Array.from(
    new Set(manifest.recommendations.map((row) => row.edmtrain_artist_id)),
  );
  const snapshot = await persistence.loadIdentitySnapshot(eventIds, artistIds);
  const shows = new Map(snapshot.shows.map((show) => [show.edmtrainId, show]));
  const artists = new Map(
    snapshot.artists.map((artist) => [artist.edmtrainId, artist]),
  );
  const memberships = new Set(
    snapshot.memberships.map(
      (membership) => `${membership.showId}:${membership.artistId}`,
    ),
  );

  const runId = randomUUID();
  const runArtistsByEdmtrainId = new Map<number, TrajectoryRunArtistPlan>();
  const artistAssessments = new Map<number, string>();
  const recommendations: TrajectoryRecommendationPlan[] = [];
  const issues: TrajectoryImportIssuePlan[] = [];

  for (const row of manifest.recommendations) {
    const show = shows.get(row.edmtrain_event_id);
    const artist = artists.get(row.edmtrain_artist_id);
    let issue: TrajectoryImportIssuePlan | null = null;
    if (!show) {
      issue = mappingIssue(row, "show_not_found");
    } else if (!artist) {
      issue = mappingIssue(row, "artist_not_found");
    } else if (!memberships.has(`${show.id}:${artist.id}`)) {
      issue = mappingIssue(row, "show_artist_membership_missing");
    }

    if (issue) {
      if (row.is_suggested) {
        throw new TrajectoryImportError(
          "trajectory_suggested_mapping_failed",
          `Suggested recommendation cannot be mapped exactly (${issue.code})`,
        );
      }
      issues.push(issue);
      continue;
    }
    if (!show || !artist) {
      throw new Error("Trajectory mapping invariant failed");
    }

    const assessment = artistAssessment(row);
    const assessmentFingerprint = stableJson(assessment);
    const priorAssessment = artistAssessments.get(row.edmtrain_artist_id);
    if (priorAssessment && priorAssessment !== assessmentFingerprint) {
      throw new TrajectoryImportError(
        "trajectory_artist_assessment_conflict",
        `Conflicting assessments for EDMTrain artist ${row.edmtrain_artist_id}`,
      );
    }
    artistAssessments.set(row.edmtrain_artist_id, assessmentFingerprint);

    let runArtist = runArtistsByEdmtrainId.get(row.edmtrain_artist_id);
    if (!runArtist) {
      runArtist = {
        id: randomUUID(),
        artistId: artist.id,
        edmtrainArtistId: row.edmtrain_artist_id,
        ...assessment,
      };
      runArtistsByEdmtrainId.set(row.edmtrain_artist_id, runArtist);
    }
    recommendations.push({
      id: randomUUID(),
      showId: show.id,
      edmtrainEventId: row.edmtrain_event_id,
      runArtistId: runArtist.id,
      arm: row.arm,
      listRank: row.list_rank,
      isSuggested: row.is_suggested,
      slatePosition: row.slate_position,
      billingPosition: row.billing_position,
      lineupSize: row.lineup_size,
      isFirstBilled: row.is_first_billed,
      rationale: {
        sourceShowDate: row.show_date,
        sourceVenueName: row.venue_name,
        sourceEventName: row.event_name,
      },
      sourceFingerprint: sourceFingerprint(row),
    });
  }

  const nonSuggestedCount = manifest.recommendations.filter(
    (row) => !row.is_suggested,
  ).length;
  const unresolvedNonSuggestedCount = issues.length;
  const unresolvedNonSuggestedRate =
    nonSuggestedCount === 0
      ? 0
      : unresolvedNonSuggestedCount / nonSuggestedCount;
  if (unresolvedNonSuggestedRate > maximumUnmappedRate) {
    throw new TrajectoryImportError(
      "trajectory_unmapped_threshold_exceeded",
      `Unmapped non-suggested recommendation rate ${unresolvedNonSuggestedRate.toFixed(4)} exceeds ${maximumUnmappedRate.toFixed(4)}`,
    );
  }

  return {
    kind: "write",
    parsed,
    runId,
    runArtists: [...runArtistsByEdmtrainId.values()],
    recommendations,
    issues,
    nonSuggestedCount,
    unresolvedNonSuggestedCount,
    unresolvedNonSuggestedRate,
  };
}

function summaryForPlan(
  plan: TrajectoryImportPlan,
  mode: "dry-run" | "write",
  status: TrajectoryImportSummary["status"],
  previousReadyRunsSuperseded = 0,
): TrajectoryImportSummary {
  const parsed = plan.parsed;
  if (plan.kind === "noop") {
    return {
      mode,
      status: "noop",
      producerRunId: parsed.manifest.producer_run_id,
      artifactSha256: parsed.artifactSha256,
      artifactByteLength: parsed.artifactByteLength,
      validUntil: parsed.validUntil.toISOString(),
      recommendationCount: parsed.manifest.recommendation_count,
      mappedRecommendationCount: parsed.manifest.recommendation_count,
      issueCount: 0,
      unresolvedNonSuggestedRate: 0,
      previousReadyRunsSuperseded: 0,
      runId: plan.existingRunId,
      mappingValidation: "not-performed",
    };
  }
  return {
    mode,
    status,
    producerRunId: parsed.manifest.producer_run_id,
    artifactSha256: parsed.artifactSha256,
    artifactByteLength: parsed.artifactByteLength,
    validUntil: parsed.validUntil.toISOString(),
    recommendationCount: parsed.manifest.recommendation_count,
    mappedRecommendationCount: plan.recommendations.length,
    issueCount: plan.issues.length,
    unresolvedNonSuggestedRate: plan.unresolvedNonSuggestedRate,
    previousReadyRunsSuperseded,
    runId: mode === "write" && status === "imported" ? plan.runId : null,
    mappingValidation:
      status === "imported"
        ? "transaction-revalidated"
        : mode === "dry-run"
          ? "point-in-time"
          : "not-performed",
  };
}

async function promoteTrajectoryImportPlan(
  plan: TrajectoryImportWritePlan,
  lease: IntegrationSyncLeaseGuard,
  persistence: TrajectoryImportPersistence,
  deadline: OperationDeadline,
): Promise<TrajectoryImportSummary> {
  return persistence.withTransaction(deadline, async (transaction) => {
    await transaction.fence(lease);
    const existing = await transaction.findExistingRun(
      plan.parsed.manifest.producer,
      plan.parsed.manifest.producer_run_id,
    );
    if (existing) {
      if (existing.artifactSha256 !== plan.parsed.artifactSha256) {
        throw new TrajectoryImportError(
          "trajectory_run_digest_conflict",
          "The producer run ID already exists with a different manifest digest",
        );
      }
      return summaryForPlan(
        {
          kind: "noop",
          parsed: plan.parsed,
          existingRunId: existing.id,
        },
        "write",
        "noop",
      );
    }

    const readyRun = await transaction.findReadyRun(
      plan.parsed.manifest.producer,
    );
    if (
      readyRun &&
      readyRun.generatedAt.getTime() >=
        plan.parsed.generatedAt.getTime()
    ) {
      throw new TrajectoryImportError(
        "trajectory_run_not_newer",
        "Trajectory run is not newer than the current ready run",
      );
    }

    const transactionSnapshot =
      await transaction.loadIdentitySnapshot(
        plan.recommendations.map(
          (recommendation) => recommendation.edmtrainEventId,
        ),
        plan.runArtists.map((artist) => artist.edmtrainArtistId),
      );
    assertTrajectoryMappingsUnchanged(plan, transactionSnapshot);
    const transactionNow = await transaction.currentTime();
    assertTrajectoryImportableAt(plan.parsed, transactionNow);

    await transaction.createRun({
      id: plan.runId,
      parsed: plan.parsed,
      summary: {
        recommendationCount: plan.parsed.manifest.recommendation_count,
        mappedRecommendationCount: plan.recommendations.length,
        importIssueCount: plan.issues.length,
        unresolvedNonSuggestedRate: plan.unresolvedNonSuggestedRate,
        recommendationHorizonEnd:
          plan.parsed.recommendationHorizonEnd.toISOString(),
        freshnessPolicy: {
          staleAfterHours: TRAJECTORY_STALE_AFTER_HOURS,
          expectedRefreshCadenceHours: 24,
          timezone: "America/New_York",
        },
      },
    });
    await transaction.createRunArtists(plan.runId, plan.runArtists);
    await transaction.createRecommendations(
      plan.runId,
      plan.recommendations,
    );
    await transaction.createIssues(plan.runId, plan.issues);
    const promotionNow = await transaction.currentTime();
    assertTrajectoryImportableAt(plan.parsed, promotionNow);
    const superseded =
      await transaction.supersedeReadyRuns(TRAJECTORY_PRODUCER);
    await transaction.promoteRun(plan.runId, promotionNow);
    return summaryForPlan(plan, "write", "imported", superseded);
  });
}

export async function importTrajectoryManifest(
  raw: Buffer,
  options: TrajectoryImportOptions = {},
): Promise<TrajectoryImportSummary> {
  const parsed = parseTrajectoryManifest(raw, options.expectedDigest);
  const importNow = (options.now ?? (() => new Date()))();
  assertTrajectoryImportableAt(parsed, importNow);
  const persistence =
    options.persistence ?? createPrismaTrajectoryImportPersistence();
  const threshold =
    options.maximumUnmappedRate ?? DEFAULT_TRAJECTORY_UNMAPPED_THRESHOLD;

  if (options.dryRun) {
    const plan = await buildTrajectoryImportPlan(
      parsed,
      persistence,
      threshold,
    );
    return summaryForPlan(plan, "dry-run", "planned");
  }

  const deadline =
    options.deadline ?? createOperationDeadline(TRAJECTORY_IMPORT_OPERATION_MS);
  const leased = await persistence.withLease(async (lease) => {
    const plan = await buildTrajectoryImportPlan(
      parsed,
      persistence,
      threshold,
    );
    if (plan.kind === "noop") {
      return summaryForPlan(plan, "write", "noop");
    }
    return promoteTrajectoryImportPlan(
      plan,
      lease,
      persistence,
      deadline,
    );
  }, deadline);

  if (!leased.ok) {
    return {
      mode: "write",
      status: "busy",
      producerRunId: parsed.manifest.producer_run_id,
      artifactSha256: parsed.artifactSha256,
      artifactByteLength: parsed.artifactByteLength,
      validUntil: parsed.validUntil.toISOString(),
      recommendationCount: parsed.manifest.recommendation_count,
      mappedRecommendationCount: 0,
      issueCount: 0,
      unresolvedNonSuggestedRate: 0,
      previousReadyRunsSuperseded: 0,
      runId: null,
      mappingValidation: "not-performed",
      lease: leased,
    };
  }
  return leased.data;
}
