import type { Prisma, TrajectoryRunStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { TRAJECTORY_PRODUCER } from "@/lib/trajectoryContract";

export interface TrajectoryRunRecord {
  id: string;
  generatedAt: Date;
  validUntil: Date;
  status: TrajectoryRunStatus;
}

export type TrajectoryRunAvailability =
  | "ready"
  | "none"
  | "failed"
  | "stale"
  | "expired"
  | "superseded"
  | "multiple_ready";

export interface TrajectoryRunStore<
  Run extends TrajectoryRunRecord = TrajectoryRunRecord,
> {
  findReadyRuns(
    producer: typeof TRAJECTORY_PRODUCER,
    limit: number,
  ): Promise<Run[]>;
  findLatestRun(
    producer: typeof TRAJECTORY_PRODUCER,
  ): Promise<Run | null>;
}

export interface TrajectoryActionContext {
  recommendationId: string;
  runId: string;
  showId: string;
  artistId: string;
}

export class TrajectoryActionError extends Error {
  constructor(
    readonly code:
      | "incomplete_attribution"
      | "recommendation_not_actionable"
      | "recommendation_target_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "TrajectoryActionError";
  }
}

export function trajectoryActionTargetMismatch(): TrajectoryActionError {
  return new TrajectoryActionError(
    "recommendation_target_mismatch",
    "The trajectory recommendation does not match this show and artist",
  );
}

interface TrajectoryActionStore extends TrajectoryRunStore {
  findRecommendation(
    context: TrajectoryActionContext,
  ): Promise<{ id: string } | null>;
}

const DEFAULT_RUN_STORE: TrajectoryRunStore = {
  findReadyRuns: (producer, limit) =>
    db.trajectoryModelRun.findMany({
      where: { producer, status: "ready" },
      orderBy: [{ generatedAt: "desc" }, { id: "desc" }],
      take: limit,
      select: {
        id: true,
        generatedAt: true,
        validUntil: true,
        status: true,
      },
    }),
  findLatestRun: (producer) =>
    db.trajectoryModelRun.findFirst({
      where: { producer },
      orderBy: [{ generatedAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        generatedAt: true,
        validUntil: true,
        status: true,
      },
    }),
};

function transactionActionStore(
  tx: Prisma.TransactionClient,
): TrajectoryActionStore {
  return {
    findReadyRuns: (producer, limit) =>
      tx.trajectoryModelRun.findMany({
        where: { producer, status: "ready" },
        orderBy: [{ generatedAt: "desc" }, { id: "desc" }],
        take: limit,
        select: {
          id: true,
          generatedAt: true,
          validUntil: true,
          status: true,
        },
      }),
    findLatestRun: (producer) =>
      tx.trajectoryModelRun.findFirst({
        where: { producer },
        orderBy: [{ generatedAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          generatedAt: true,
          validUntil: true,
          status: true,
        },
      }),
    findRecommendation: (context) =>
      tx.trajectoryRecommendation.findFirst({
        where: {
          id: context.recommendationId,
          runId: context.runId,
          showId: context.showId,
          runArtist: { is: { artistId: context.artistId } },
          show: { is: { syncStatus: "active" } },
        },
        select: { id: true },
      }),
  };
}

export async function resolveTrajectoryRun<Run extends TrajectoryRunRecord>(
  now: Date,
  store: TrajectoryRunStore<Run>,
): Promise<{
  availability: TrajectoryRunAvailability;
  run: Run | null;
}> {
  const readyRuns = await store.findReadyRuns(TRAJECTORY_PRODUCER, 2);
  if (readyRuns.length > 1) {
    return { availability: "multiple_ready", run: readyRuns[0] };
  }
  if (readyRuns.length === 1) {
    const run = readyRuns[0];
    if (run.validUntil.getTime() <= now.getTime()) {
      return { availability: "expired", run };
    }
    return { availability: "ready", run };
  }

  const latest = await store.findLatestRun(TRAJECTORY_PRODUCER);
  if (!latest) return { availability: "none", run: null };
  if (latest.status === "failed") return { availability: "failed", run: latest };
  if (latest.status === "stale") return { availability: "stale", run: latest };
  if (latest.validUntil.getTime() <= now.getTime()) {
    return { availability: "expired", run: latest };
  }
  return { availability: "superseded", run: latest };
}

export function resolveDefaultTrajectoryRun(now: Date) {
  return resolveTrajectoryRun(now, DEFAULT_RUN_STORE);
}

export function trajectoryActionContextFromFormData(
  formData: FormData,
  showId: string,
): TrajectoryActionContext | null {
  const values = {
    recommendationId: String(formData.get("recommendationId") ?? "").trim(),
    runId: String(formData.get("runId") ?? "").trim(),
    artistId: String(formData.get("artistId") ?? "").trim(),
  };
  if (!values.recommendationId && !values.runId && !values.artistId) {
    return null;
  }
  if (!values.recommendationId || !values.runId || !values.artistId || !showId) {
    throw new TrajectoryActionError(
      "incomplete_attribution",
      "Incomplete trajectory recommendation attribution",
    );
  }
  return { ...values, showId };
}

export async function requireActionableTrajectoryRecommendation(
  context: TrajectoryActionContext,
  now: Date = new Date(),
): Promise<void> {
  const store: TrajectoryActionStore = {
    ...DEFAULT_RUN_STORE,
    findRecommendation: (candidate) =>
      db.trajectoryRecommendation.findFirst({
        where: {
          id: candidate.recommendationId,
          runId: candidate.runId,
          showId: candidate.showId,
          runArtist: { is: { artistId: candidate.artistId } },
          show: { is: { syncStatus: "active" } },
        },
        select: { id: true },
      }),
  };
  await requireActionableTrajectoryRecommendationFromStore(context, now, store);
}

async function requireActionableTrajectoryRecommendationFromStore(
  context: TrajectoryActionContext,
  now: Date,
  store: TrajectoryActionStore,
): Promise<void> {
  const resolved = await resolveTrajectoryRun(now, store);
  if (
    resolved.availability !== "ready" ||
    !resolved.run ||
    resolved.run.id !== context.runId
  ) {
    throw new TrajectoryActionError(
      "recommendation_not_actionable",
      "The trajectory recommendation run is no longer actionable",
    );
  }
  const recommendation = await store.findRecommendation(context);
  if (!recommendation) {
    throw trajectoryActionTargetMismatch();
  }
}

export async function requireActionableTrajectoryRecommendationInTransaction(
  tx: Prisma.TransactionClient,
  context: TrajectoryActionContext,
  now: Date = new Date(),
): Promise<void> {
  await requireActionableTrajectoryRecommendationFromStore(
    context,
    now,
    transactionActionStore(tx),
  );
}

export async function runAfterActionableTrajectoryValidation<T>(
  context: TrajectoryActionContext | null | undefined,
  target: { showId: string; artistId: string },
  action: () => Promise<T>,
  validate: (
    context: TrajectoryActionContext,
  ) => Promise<void> = requireActionableTrajectoryRecommendation,
): Promise<T> {
  if (context) {
    if (
      context.showId !== target.showId ||
      context.artistId !== target.artistId
    ) {
      throw trajectoryActionTargetMismatch();
    }
    await validate(context);
  }
  return action();
}

export async function runActionableTrajectoryMutation<T>(
  tx: Prisma.TransactionClient,
  context: TrajectoryActionContext,
  mutation: () => Promise<T>,
  now: Date = new Date(),
): Promise<T> {
  await requireActionableTrajectoryRecommendationInTransaction(
    tx,
    context,
    now,
  );
  return mutation();
}
