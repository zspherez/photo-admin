import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  dateOnlyFromStoredDate,
  easternDateOnly,
} from "@/lib/calendarDate";
import { db } from "@/lib/db";

const opaqueId = z.string().trim().min(1).max(200);
const optionalNotes = z
  .string()
  .max(4000)
  .transform((value) => value.trim() || null)
  .nullable()
  .optional()
  .transform((value) => value ?? null);

const attributionSchema = z
  .object({
    recommendationId: opaqueId,
    runId: opaqueId,
    showId: opaqueId,
    artistId: opaqueId,
  })
  .strict();

export const trajectoryFeedbackInputSchema = attributionSchema
  .extend({
    action: z.enum([
      "selected",
      "declined",
      "saved",
      "dismissed",
      "manual_override",
    ]),
    propensity: z.number().finite().min(0).max(1).nullable().optional(),
    notes: optionalNotes,
    idempotencyKey: opaqueId,
    supersedesId: opaqueId.nullable().optional(),
  })
  .strict()
  .transform((value) => ({
    ...value,
    propensity: value.propensity ?? null,
    supersedesId: value.supersedesId ?? null,
    manualOverride: value.action === "manual_override",
  }));

export const trajectoryOutcomeInputSchema = attributionSchema
  .extend({
    attended: z.boolean().nullable().optional(),
    access: z
      .enum(["none", "guestlist", "photo_pass", "other"])
      .nullable()
      .optional(),
    keeperCount: z.number().int().min(0).nullable().optional(),
    relationshipValue: z.number().int().min(0).max(2).nullable().optional(),
    publicationValue: z.number().int().min(0).max(2).nullable().optional(),
    shootability: z.enum(["good", "ok", "poor"]).nullable().optional(),
    venueAccessibility: z.enum(["high", "medium", "low"]).nullable().optional(),
    notes: optionalNotes,
    idempotencyKey: opaqueId,
    supersedesId: opaqueId.nullable().optional(),
  })
  .strict()
  .transform((value) => ({
    ...value,
    attended: value.attended ?? null,
    access: value.access ?? null,
    keeperCount: value.keeperCount ?? null,
    relationshipValue: value.relationshipValue ?? null,
    publicationValue: value.publicationValue ?? null,
    shootability: value.shootability ?? null,
    venueAccessibility: value.venueAccessibility ?? null,
    supersedesId: value.supersedesId ?? null,
  }))
  .superRefine((value, context) => {
    if (
      value.attended === null &&
      value.access === null &&
      value.keeperCount === null &&
      value.relationshipValue === null &&
      value.publicationValue === null &&
      value.shootability === null &&
      value.venueAccessibility === null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one structured outcome field is required",
      });
    }
    if (
      value.keeperCount !== null &&
      value.keeperCount > 0 &&
      value.attended !== true
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["keeperCount"],
        message: "A positive keeper count requires attended=true",
      });
    }
  });

export const trajectoryOutreachAttributionInputSchema = attributionSchema
  .extend({
    outreachId: opaqueId,
  })
  .strict();

export type TrajectoryFeedbackInput = z.input<
  typeof trajectoryFeedbackInputSchema
>;
export type ParsedTrajectoryFeedbackInput = z.output<
  typeof trajectoryFeedbackInputSchema
>;
export type TrajectoryOutcomeInput = z.input<
  typeof trajectoryOutcomeInputSchema
>;
export type ParsedTrajectoryOutcomeInput = z.output<
  typeof trajectoryOutcomeInputSchema
>;
export type TrajectoryOutreachAttributionInput = z.input<
  typeof trajectoryOutreachAttributionInputSchema
>;

type KnownRunStatus = "ready" | "stale" | "superseded";

export interface TrajectoryRecommendationContext {
  id: string;
  runId: string;
  showId: string;
  artistId: string | null;
  runStatus: string;
  validUntil: Date;
  showDate: Date;
  showSyncStatus: string;
}

export interface StoredTrajectoryFeedback {
  id: string;
  recommendationId: string;
  action: string;
  propensity: number | null;
  manualOverride: boolean;
  notes: string | null;
  idempotencyKey: string;
  supersedesId: string | null;
  recordedAt: Date;
}

export interface StoredTrajectoryOutcome {
  id: string;
  recommendationId: string;
  attended: boolean | null;
  access: string | null;
  keeperCount: number | null;
  relationshipValue: number | null;
  publicationValue: number | null;
  shootability: string | null;
  venueAccessibility: string | null;
  notes: string | null;
  idempotencyKey: string;
  supersedesId: string | null;
  recordedAt: Date;
}

export interface TrajectoryOutreachContext {
  id: string;
  showId: string;
  artistId: string;
  trajectoryRecommendationId: string | null;
}

export interface TrajectoryFeedbackTransaction {
  findRecommendation(
    recommendationId: string,
  ): Promise<TrajectoryRecommendationContext | null>;
  findFeedbackByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<StoredTrajectoryFeedback | null>;
  findFeedback(id: string): Promise<StoredTrajectoryFeedback | null>;
  createFeedback(
    input: ParsedTrajectoryFeedbackInput,
    recordedAt: Date,
  ): Promise<StoredTrajectoryFeedback>;
  findOutcomeByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<StoredTrajectoryOutcome | null>;
  findOutcome(id: string): Promise<StoredTrajectoryOutcome | null>;
  createOutcome(
    input: ParsedTrajectoryOutcomeInput,
    recordedAt: Date,
  ): Promise<StoredTrajectoryOutcome>;
  findOutreach(outreachId: string): Promise<TrajectoryOutreachContext | null>;
  attributeOutreach(
    outreachId: string,
    recommendationId: string,
  ): Promise<void>;
}

export interface TrajectoryFeedbackPersistence {
  withTransaction<T>(
    work: (transaction: TrajectoryFeedbackTransaction) => Promise<T>,
  ): Promise<T>;
}

export class TrajectoryFeedbackError extends Error {
  constructor(
    readonly code:
      | "recommendation_not_found"
      | "recommendation_attribution_mismatch"
      | "recommendation_not_actionable"
      | "historical_recommendation_unknown"
      | "show_not_occurred"
      | "superseded_evidence_not_found"
      | "cross_recommendation_supersession"
      | "idempotency_conflict"
      | "outreach_not_found"
      | "outreach_attribution_mismatch"
      | "outreach_already_attributed",
    message: string,
  ) {
    super(message);
    this.name = "TrajectoryFeedbackError";
  }
}

const feedbackSelect = {
  id: true,
  recommendationId: true,
  action: true,
  propensity: true,
  manualOverride: true,
  notes: true,
  idempotencyKey: true,
  supersedesId: true,
  recordedAt: true,
} satisfies Prisma.TrajectoryFeedbackEventSelect;

const outcomeSelect = {
  id: true,
  recommendationId: true,
  attended: true,
  access: true,
  keeperCount: true,
  relationshipValue: true,
  publicationValue: true,
  shootability: true,
  venueAccessibility: true,
  notes: true,
  idempotencyKey: true,
  supersedesId: true,
  recordedAt: true,
} satisfies Prisma.TrajectoryShowOutcomeSelect;

function isRetryable(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2002" || error.code === "P2034")
  );
}

function prismaTrajectoryFeedbackTransaction(
  tx: Prisma.TransactionClient,
): TrajectoryFeedbackTransaction {
  return {
    async findRecommendation(recommendationId) {
      const recommendation = await tx.trajectoryRecommendation.findUnique({
        where: { id: recommendationId },
        select: {
          id: true,
          runId: true,
          showId: true,
          run: {
            select: {
              status: true,
              validUntil: true,
            },
          },
          show: {
            select: {
              date: true,
              syncStatus: true,
            },
          },
          runArtist: {
            select: {
              artistId: true,
            },
          },
        },
      });
      return recommendation
        ? {
            id: recommendation.id,
            runId: recommendation.runId,
            showId: recommendation.showId,
            artistId: recommendation.runArtist.artistId,
            runStatus: recommendation.run.status,
            validUntil: recommendation.run.validUntil,
            showDate: recommendation.show.date,
            showSyncStatus: recommendation.show.syncStatus,
          }
        : null;
    },
    findFeedbackByIdempotencyKey(idempotencyKey) {
      return tx.trajectoryFeedbackEvent.findUnique({
        where: { idempotencyKey },
        select: feedbackSelect,
      });
    },
    findFeedback(id) {
      return tx.trajectoryFeedbackEvent.findUnique({
        where: { id },
        select: feedbackSelect,
      });
    },
    createFeedback(input, recordedAt) {
      return tx.trajectoryFeedbackEvent.create({
        data: {
          recommendationId: input.recommendationId,
          action: input.action,
          propensity: input.propensity,
          manualOverride: input.manualOverride,
          notes: input.notes,
          idempotencyKey: input.idempotencyKey,
          supersedesId: input.supersedesId,
          recordedAt,
        },
        select: feedbackSelect,
      });
    },
    findOutcomeByIdempotencyKey(idempotencyKey) {
      return tx.trajectoryShowOutcome.findUnique({
        where: { idempotencyKey },
        select: outcomeSelect,
      });
    },
    findOutcome(id) {
      return tx.trajectoryShowOutcome.findUnique({
        where: { id },
        select: outcomeSelect,
      });
    },
    createOutcome(input, recordedAt) {
      return tx.trajectoryShowOutcome.create({
        data: {
          recommendationId: input.recommendationId,
          attended: input.attended,
          access: input.access,
          keeperCount: input.keeperCount,
          relationshipValue: input.relationshipValue,
          publicationValue: input.publicationValue,
          shootability: input.shootability,
          venueAccessibility: input.venueAccessibility,
          notes: input.notes,
          idempotencyKey: input.idempotencyKey,
          supersedesId: input.supersedesId,
          recordedAt,
        },
        select: outcomeSelect,
      });
    },
    findOutreach(outreachId) {
      return tx.outreach.findUnique({
        where: { id: outreachId },
        select: {
          id: true,
          showId: true,
          artistId: true,
          trajectoryRecommendationId: true,
        },
      });
    },
    async attributeOutreach(outreachId, recommendationId) {
      await tx.outreach.update({
        where: { id: outreachId },
        data: { trajectoryRecommendationId: recommendationId },
      });
    },
  };
}

export function createPrismaTrajectoryFeedbackPersistence(): TrajectoryFeedbackPersistence {
  return {
    async withTransaction(work) {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          return await db.$transaction(
            async (tx) => work(prismaTrajectoryFeedbackTransaction(tx)),
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          );
        } catch (error) {
          if (attempt < 3 && isRetryable(error)) continue;
          throw error;
        }
      }
      throw new Error("Unable to write trajectory feedback");
    },
  };
}

function assertExactAttribution(
  recommendation: TrajectoryRecommendationContext | null,
  input: {
    recommendationId: string;
    runId: string;
    showId: string;
    artistId: string;
  },
): asserts recommendation is TrajectoryRecommendationContext {
  if (!recommendation) {
    throw new TrajectoryFeedbackError(
      "recommendation_not_found",
      "Trajectory recommendation not found",
    );
  }
  if (
    recommendation.id !== input.recommendationId ||
    recommendation.runId !== input.runId ||
    recommendation.showId !== input.showId ||
    recommendation.artistId !== input.artistId
  ) {
    throw new TrajectoryFeedbackError(
      "recommendation_attribution_mismatch",
      "Recommendation does not match the supplied run, show, and artist",
    );
  }
}

function assertKnownHistoricalRun(
  recommendation: TrajectoryRecommendationContext,
): asserts recommendation is TrajectoryRecommendationContext & {
  runStatus: KnownRunStatus;
} {
  if (
    recommendation.runStatus !== "ready" &&
    recommendation.runStatus !== "stale" &&
    recommendation.runStatus !== "superseded"
  ) {
    throw new TrajectoryFeedbackError(
      "historical_recommendation_unknown",
      "Feedback cannot be attached to an importing or failed model run",
    );
  }
}

export function hasTrajectoryShowOccurred(
  showDate: Date,
  now: Date,
): boolean {
  return dateOnlyFromStoredDate(showDate) <= easternDateOnly(now);
}

function assertSameFeedback(
  existing: StoredTrajectoryFeedback,
  input: ParsedTrajectoryFeedbackInput,
): void {
  if (
    existing.recommendationId !== input.recommendationId ||
    existing.action !== input.action ||
    existing.propensity !== input.propensity ||
    existing.manualOverride !== input.manualOverride ||
    existing.notes !== input.notes ||
    existing.supersedesId !== input.supersedesId
  ) {
    throw new TrajectoryFeedbackError(
      "idempotency_conflict",
      "Trajectory feedback idempotency key was reused for different evidence",
    );
  }
}

async function recordTrajectoryFeedbackWithTransaction(
  input: ParsedTrajectoryFeedbackInput,
  tx: TrajectoryFeedbackTransaction,
  now: Date,
): Promise<{ created: boolean; event: StoredTrajectoryFeedback }> {
  const recommendation = await tx.findRecommendation(input.recommendationId);
  assertExactAttribution(recommendation, input);

  const existing = await tx.findFeedbackByIdempotencyKey(input.idempotencyKey);
  if (existing) {
    assertSameFeedback(existing, input);
    return { created: false, event: existing };
  }

  if (input.supersedesId) {
    assertKnownHistoricalRun(recommendation);
    const superseded = await tx.findFeedback(input.supersedesId);
    if (!superseded) {
      throw new TrajectoryFeedbackError(
        "superseded_evidence_not_found",
        "Superseded trajectory feedback was not found",
      );
    }
    if (superseded.recommendationId !== input.recommendationId) {
      throw new TrajectoryFeedbackError(
        "cross_recommendation_supersession",
        "A correction cannot supersede feedback from another recommendation",
      );
    }
  } else if (
    recommendation.runStatus !== "ready" ||
    recommendation.validUntil <= now ||
    recommendation.showSyncStatus !== "active"
  ) {
    throw new TrajectoryFeedbackError(
      "recommendation_not_actionable",
      "New recommendation decisions require a current ready run and active show",
    );
  }

  return {
    created: true,
    event: await tx.createFeedback(input, now),
  };
}

export function recordTrajectoryFeedbackInTransaction(
  rawInput: TrajectoryFeedbackInput,
  tx: Prisma.TransactionClient,
  now: Date = new Date(),
): Promise<{ created: boolean; event: StoredTrajectoryFeedback }> {
  return recordTrajectoryFeedbackWithTransaction(
    trajectoryFeedbackInputSchema.parse(rawInput),
    prismaTrajectoryFeedbackTransaction(tx),
    now,
  );
}

function assertSameOutcome(
  existing: StoredTrajectoryOutcome,
  input: ParsedTrajectoryOutcomeInput,
): void {
  if (
    existing.recommendationId !== input.recommendationId ||
    existing.attended !== input.attended ||
    existing.access !== input.access ||
    existing.keeperCount !== input.keeperCount ||
    existing.relationshipValue !== input.relationshipValue ||
    existing.publicationValue !== input.publicationValue ||
    existing.shootability !== input.shootability ||
    existing.venueAccessibility !== input.venueAccessibility ||
    existing.notes !== input.notes ||
    existing.supersedesId !== input.supersedesId
  ) {
    throw new TrajectoryFeedbackError(
      "idempotency_conflict",
      "Trajectory outcome idempotency key was reused for different evidence",
    );
  }
}

export async function recordTrajectoryFeedback(
  rawInput: TrajectoryFeedbackInput,
  options: {
    persistence?: TrajectoryFeedbackPersistence;
    now?: () => Date;
  } = {},
): Promise<{ created: boolean; event: StoredTrajectoryFeedback }> {
  const input = trajectoryFeedbackInputSchema.parse(rawInput);
  const persistence =
    options.persistence ?? createPrismaTrajectoryFeedbackPersistence();
  const now = options.now?.() ?? new Date();

  return persistence.withTransaction((tx) =>
    recordTrajectoryFeedbackWithTransaction(input, tx, now),
  );
}

export async function recordTrajectoryOutcome(
  rawInput: TrajectoryOutcomeInput,
  options: {
    persistence?: TrajectoryFeedbackPersistence;
    now?: () => Date;
  } = {},
): Promise<{ created: boolean; outcome: StoredTrajectoryOutcome }> {
  const input = trajectoryOutcomeInputSchema.parse(rawInput);
  const persistence =
    options.persistence ?? createPrismaTrajectoryFeedbackPersistence();
  const now = options.now?.() ?? new Date();

  return persistence.withTransaction(async (tx) => {
    const recommendation = await tx.findRecommendation(
      input.recommendationId,
    );
    assertExactAttribution(recommendation, input);

    const existing = await tx.findOutcomeByIdempotencyKey(
      input.idempotencyKey,
    );
    if (existing) {
      assertSameOutcome(existing, input);
      return { created: false, outcome: existing };
    }

    assertKnownHistoricalRun(recommendation);

    if (
      !input.supersedesId &&
      !hasTrajectoryShowOccurred(recommendation.showDate, now)
    ) {
      throw new TrajectoryFeedbackError(
        "show_not_occurred",
        "Show outcomes cannot be recorded before the canonical show date",
      );
    }

    if (input.supersedesId) {
      const superseded = await tx.findOutcome(input.supersedesId);
      if (!superseded) {
        throw new TrajectoryFeedbackError(
          "superseded_evidence_not_found",
          "Superseded trajectory outcome was not found",
        );
      }
      if (superseded.recommendationId !== input.recommendationId) {
        throw new TrajectoryFeedbackError(
          "cross_recommendation_supersession",
          "A correction cannot supersede an outcome from another recommendation",
        );
      }
    }

    return {
      created: true,
      outcome: await tx.createOutcome(input, now),
    };
  });
}

export async function attributeTrajectoryOutreach(
  rawInput: TrajectoryOutreachAttributionInput,
  options: {
    persistence?: TrajectoryFeedbackPersistence;
  } = {},
): Promise<{ attributed: boolean }> {
  const input = trajectoryOutreachAttributionInputSchema.parse(rawInput);
  const persistence =
    options.persistence ?? createPrismaTrajectoryFeedbackPersistence();

  return persistence.withTransaction(async (tx) => {
    const recommendation = await tx.findRecommendation(
      input.recommendationId,
    );
    assertExactAttribution(recommendation, input);
    assertKnownHistoricalRun(recommendation);

    const outreach = await tx.findOutreach(input.outreachId);
    if (!outreach) {
      throw new TrajectoryFeedbackError(
        "outreach_not_found",
        "Outreach not found",
      );
    }
    if (
      outreach.showId !== input.showId ||
      outreach.artistId !== input.artistId
    ) {
      throw new TrajectoryFeedbackError(
        "outreach_attribution_mismatch",
        "Outreach does not match the recommendation show and artist",
      );
    }
    if (outreach.trajectoryRecommendationId === input.recommendationId) {
      return { attributed: false };
    }
    if (outreach.trajectoryRecommendationId !== null) {
      throw new TrajectoryFeedbackError(
        "outreach_already_attributed",
        "Outreach is already attributed to another recommendation",
      );
    }

    await tx.attributeOutreach(input.outreachId, input.recommendationId);
    return { attributed: true };
  });
}
