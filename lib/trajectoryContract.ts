import { createHash } from "node:crypto";
import { z } from "zod";

export const TRAJECTORY_IMPORT_CONTRACT_VERSION = "photo-admin-import-v1";
export const TRAJECTORY_PRODUCER = "artist_trajectory";
export const TRAJECTORY_PRODUCER_SCHEMA_VERSION =
  "artist-trajectory-decision-v3";
export const TRAJECTORY_MODEL_STATUS =
  "provisional_population_matched_event_momentum";
export const TRAJECTORY_RAW_SIZE_LIMIT_BYTES = 1_000_000;
export const TRAJECTORY_STALE_AFTER_HOURS = 72;

export const TRAJECTORY_ARMS = [
  "trajectory",
  "momentum",
  "exploration",
  "portfolio",
] as const;

export const TRAJECTORY_COVERAGE_STATES = [
  "C_covered",
  "U0_unresolved",
  "U1_no_history",
  "U2_thin_history",
  "Q_query_incomplete",
  "Q_query_failure",
  "J_junk",
] as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const OFFSET_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/;

function isExactCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

const calendarDateSchema = z
  .string()
  .refine(isExactCalendarDate, "Expected a real YYYY-MM-DD calendar date");

const offsetTimestampSchema = z
  .string()
  .regex(OFFSET_TIMESTAMP_PATTERN, "Expected an ISO timestamp in UTC")
  .refine((value) => Number.isFinite(Date.parse(value)), "Invalid timestamp");

const nonEmptyString = z
  .string()
  .refine(
    (value) => value.length > 0 && value === value.trim(),
    "Expected a trimmed non-empty string",
  );
const nullableNonEmptyString = nonEmptyString.nullable();
const nonNegativeInteger = z.number().int().min(0);
const positiveInteger = z.number().int().positive();

const nearestAnalogSchema = z
  .object({
    name: nonEmptyString,
    observation_date: calendarDateSchema,
    distance: z.number().finite().min(0),
    sustained_expansion: z.union([z.literal(0), z.literal(1)]),
    future_event_count: nonNegativeInteger,
    future_distinct_markets: nonNegativeInteger,
  })
  .strict();

const analogSummarySchema = z
  .object({
    configuration: nonEmptyString,
    k: positiveInteger,
    sustained_positive_neighbors: nonNegativeInteger,
    sustained_pool_base_rate: z.number().finite().min(0).max(1),
    nearest: z.array(nearestAnalogSchema).max(3),
  })
  .strict()
  .refine(
    (value) => value.sustained_positive_neighbors <= value.k,
    "sustained_positive_neighbors cannot exceed k",
  );

const releaseContextSchema = z
  .object({
    available: z.boolean(),
    status: z.enum(["not_attempted", "unmatched", "ambiguous", "matched"]),
    context_only_not_ranking_feature: z.literal(true),
    match_quality: nullableNonEmptyString.optional(),
    musicbrainz_artist_id: nullableNonEmptyString.optional(),
    musicbrainz_name: nullableNonEmptyString.optional(),
    last_release_date: calendarDateSchema.nullable().optional(),
    last_release_title: nullableNonEmptyString.optional(),
    release_groups_past_6m: nonNegativeInteger.nullable().optional(),
    release_groups_past_12m: nonNegativeInteger.nullable().optional(),
    release_groups_past_24m: nonNegativeInteger.nullable().optional(),
    label_count: nonNegativeInteger.nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.available !== (value.status === "matched")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "release_context.available must be true only for matched data",
      });
    }
  });

const evidenceSchema = z
  .object({
    coverage_state: z.enum(TRAJECTORY_COVERAGE_STATES),
    momentum_band: z
      .enum(["rising", "strong_acceleration", "declining", "flat"])
      .nullable(),
    is_early_stage: z.boolean(),
    is_established: z.boolean(),
    is_veteran: z.boolean(),
    events_prior_6m: nonNegativeInteger.nullable(),
    events_recent_6m: nonNegativeInteger.nullable(),
    event_delta_6m: z.number().int().nullable(),
    markets_prior_6m: nonNegativeInteger.nullable(),
    markets_recent_6m: nonNegativeInteger.nullable(),
    career_age_years: z.number().finite().min(0).nullable(),
    analog_summary: analogSummarySchema.nullable(),
    release_context: releaseContextSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const countValues = [
      value.events_prior_6m,
      value.events_recent_6m,
      value.event_delta_6m,
      value.markets_prior_6m,
      value.markets_recent_6m,
      value.career_age_years,
    ];
    const hasCompleteFeatures = countValues.every((item) => item !== null);
    if (value.coverage_state === "C_covered" && !hasCompleteFeatures) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Covered recommendations require complete momentum features",
      });
    }
    if (
      value.coverage_state === "C_covered" &&
      value.momentum_band === null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Covered recommendations require a momentum band",
      });
    }
    if (
      value.coverage_state !== "C_covered" &&
      value.momentum_band !== null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Only covered recommendations may carry a momentum band",
      });
    }
  });

const recommendationSchema = z
  .object({
    recommendation_key: nonEmptyString,
    arm: z.enum(TRAJECTORY_ARMS),
    list_rank: positiveInteger,
    is_suggested: z.boolean(),
    slate_position: positiveInteger.nullable(),
    edmtrain_event_id: positiveInteger,
    show_date: calendarDateSchema,
    venue_name: nonEmptyString,
    event_name: z.string(),
    edmtrain_artist_id: positiveInteger,
    artist_name: nonEmptyString,
    billing_position: positiveInteger,
    lineup_size: positiveInteger,
    is_first_billed: z.boolean(),
    genres: z.array(nonEmptyString).max(6),
    spotify_artist_id: nullableNonEmptyString,
    ra_artist_id: nullableNonEmptyString,
    evidence: evidenceSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.billing_position > value.lineup_size) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "billing_position cannot exceed lineup_size",
      });
    }
    if (value.is_first_billed !== (value.billing_position === 1)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "is_first_billed must match billing_position",
      });
    }
    if (value.is_suggested !== (value.slate_position !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Suggested rows require a slate position and other rows forbid one",
      });
    }
  });

const manifestSchema = z
  .object({
    contract_version: z.literal(TRAJECTORY_IMPORT_CONTRACT_VERSION),
    producer: z.literal(TRAJECTORY_PRODUCER),
    producer_run_id: z.string().uuid(),
    producer_schema_version: z
      .string()
      .regex(/^artist-trajectory-decision-v[1-9]\d*$/),
    generated_at_utc: offsetTimestampSchema,
    as_of_date: calendarDateSchema,
    decision_date: calendarDateSchema,
    minimum_show_date: calendarDateSchema,
    valid_until_date: calendarDateSchema,
    model_status: z.literal(TRAJECTORY_MODEL_STATUS),
    validation_reference: nonEmptyString,
    full_artifact_sha256: z.string().regex(SHA256_PATTERN),
    producer_revision: nullableNonEmptyString,
    recommendation_count: nonNegativeInteger,
    recommendations: z.array(recommendationSchema),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.recommendation_count !== manifest.recommendations.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "recommendation_count does not match recommendations.length",
      });
    }
    if (manifest.as_of_date > manifest.decision_date) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "as_of_date cannot be after decision_date",
      });
    }
    if (manifest.minimum_show_date < manifest.decision_date) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "minimum_show_date cannot be before decision_date",
      });
    }
    if (manifest.valid_until_date < manifest.minimum_show_date) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "valid_until_date cannot be before minimum_show_date",
      });
    }

    const recommendationKeys = new Set<string>();
    const compositeKeys = new Set<string>();
    const ranksByArm = new Map<string, number[]>();
    const suggestedPositions: number[] = [];
    for (const row of manifest.recommendations) {
      const expectedKey = `${manifest.producer_run_id}:${row.edmtrain_event_id}:${row.arm}:${row.edmtrain_artist_id}`;
      if (row.recommendation_key !== expectedKey) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["recommendations"],
          message: `Invalid recommendation_key: ${row.recommendation_key}`,
        });
      }
      if (recommendationKeys.has(row.recommendation_key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["recommendations"],
          message: `Duplicate recommendation_key: ${row.recommendation_key}`,
        });
      }
      recommendationKeys.add(row.recommendation_key);

      const compositeKey = [
        row.edmtrain_event_id,
        row.edmtrain_artist_id,
        row.arm,
      ].join(":");
      if (compositeKeys.has(compositeKey)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["recommendations"],
          message: `Duplicate recommendation identity: ${compositeKey}`,
        });
      }
      compositeKeys.add(compositeKey);

      if (
        row.show_date < manifest.minimum_show_date ||
        row.show_date > manifest.valid_until_date
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["recommendations"],
          message: `Recommendation show_date is outside the declared horizon: ${row.recommendation_key}`,
        });
      }
      const ranks = ranksByArm.get(row.arm) ?? [];
      ranks.push(row.list_rank);
      ranksByArm.set(row.arm, ranks);
      if (row.slate_position !== null) {
        suggestedPositions.push(row.slate_position);
      }
    }

    for (const [arm, ranks] of ranksByArm) {
      if (ranks.length !== new Set(ranks).size) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["recommendations"],
          message: `list_rank must be unique for arm ${arm}`,
        });
      }
    }

    const sortedSlate = [...suggestedPositions].sort(
      (left, right) => left - right,
    );
    if (
      sortedSlate.length !== new Set(sortedSlate).size ||
      sortedSlate.some((position, index) => position !== index + 1)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recommendations"],
        message: "Suggested slate positions must be unique and contiguous from 1",
      });
    }
  });

export type TrajectoryManifest = z.infer<typeof manifestSchema>;
export type TrajectoryManifestRecommendation =
  TrajectoryManifest["recommendations"][number];
export type TrajectoryArm = (typeof TRAJECTORY_ARMS)[number];
export type TrajectoryCoverageState =
  (typeof TRAJECTORY_COVERAGE_STATES)[number];

export class TrajectoryContractError extends Error {
  readonly code = "trajectory_contract_invalid";

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "TrajectoryContractError";
  }
}

export class TrajectoryDigestMismatchError extends Error {
  readonly code = "trajectory_digest_mismatch";

  constructor() {
    super("Trajectory manifest SHA-256 does not match the expected digest");
    this.name = "TrajectoryDigestMismatchError";
  }
}

export interface ParsedTrajectoryManifest {
  manifest: TrajectoryManifest;
  artifactSha256: string;
  artifactByteLength: number;
  generatedAt: Date;
  asOfDate: Date;
  decisionDate: Date;
  minimumShowDate: Date;
  recommendationHorizonEnd: Date;
  validUntil: Date;
}

export function parseTrajectoryDigest(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(
    /^([0-9a-fA-F]{64})(?:[ \t]+[* ]?[^\r\n]+)?$/,
  );
  if (!match) {
    throw new TrajectoryContractError(
      "Expected a SHA-256 hex value or a single sha256sum-formatted line",
    );
  }
  return match[1].toLowerCase();
}

export function trajectoryCalendarDate(value: string): Date {
  if (!isExactCalendarDate(value)) {
    throw new TrajectoryContractError(`Invalid calendar date: ${value}`);
  }
  return new Date(`${value}T00:00:00.000Z`);
}

export function trajectoryValidUntil(generatedAt: Date): Date {
  return new Date(
    generatedAt.getTime() + TRAJECTORY_STALE_AFTER_HOURS * 60 * 60 * 1_000,
  );
}

export function isTrajectoryRunActionable(
  run: { status: string; validUntil: Date },
  now = new Date(),
): boolean {
  return run.status === "ready" && run.validUntil.getTime() >= now.getTime();
}

export function trajectoryActionableRunWhere(now = new Date()) {
  return {
    producer: TRAJECTORY_PRODUCER,
    status: "ready" as const,
    validUntil: { gte: now },
  };
}

function contractErrorMessage(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${path}${issue.message}`;
    })
    .join("; ");
}

export function parseTrajectoryManifest(
  raw: Buffer,
  expectedDigest?: string | null,
): ParsedTrajectoryManifest {
  if (raw.byteLength > TRAJECTORY_RAW_SIZE_LIMIT_BYTES) {
    throw new TrajectoryContractError(
      `Trajectory manifest exceeds ${TRAJECTORY_RAW_SIZE_LIMIT_BYTES} bytes`,
    );
  }
  const artifactSha256 = createHash("sha256").update(raw).digest("hex");
  if (
    expectedDigest &&
    artifactSha256 !== parseTrajectoryDigest(expectedDigest)
  ) {
    throw new TrajectoryDigestMismatchError();
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new TrajectoryContractError("Trajectory manifest is not valid JSON", {
      cause: error,
    });
  }

  const parsed = manifestSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new TrajectoryContractError(contractErrorMessage(parsed.error), {
      cause: parsed.error,
    });
  }
  const manifest = parsed.data;
  const generatedAt = new Date(manifest.generated_at_utc);
  return {
    manifest,
    artifactSha256,
    artifactByteLength: raw.byteLength,
    generatedAt,
    asOfDate: trajectoryCalendarDate(manifest.as_of_date),
    decisionDate: trajectoryCalendarDate(manifest.decision_date),
    minimumShowDate: trajectoryCalendarDate(manifest.minimum_show_date),
    recommendationHorizonEnd: trajectoryCalendarDate(
      manifest.valid_until_date,
    ),
    validUntil: trajectoryValidUntil(generatedAt),
  };
}
