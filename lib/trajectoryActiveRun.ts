import type { TrajectoryRunStatus } from "@prisma/client";
import { db } from "@/lib/db";
import {
  TRAJECTORY_PRODUCER,
  TRAJECTORY_STALE_AFTER_HOURS,
} from "@/lib/trajectoryContract";

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

export function trajectoryFreshnessCutoff(now: Date): Date {
  return new Date(
    now.getTime() - TRAJECTORY_STALE_AFTER_HOURS * 60 * 60 * 1_000,
  );
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
    if (run.generatedAt.getTime() <= trajectoryFreshnessCutoff(now).getTime()) {
      return { availability: "stale", run };
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
    throw new Error("Incomplete trajectory recommendation attribution");
  }
  return { ...values, showId };
}

export async function requireActionableTrajectoryRecommendation(
  context: TrajectoryActionContext,
  now: Date = new Date(),
): Promise<void> {
  const resolved = await resolveDefaultTrajectoryRun(now);
  if (
    resolved.availability !== "ready" ||
    !resolved.run ||
    resolved.run.id !== context.runId
  ) {
    throw new Error("The trajectory recommendation run is no longer actionable");
  }
  const recommendation = await db.trajectoryRecommendation.findFirst({
    where: {
      id: context.recommendationId,
      runId: context.runId,
      showId: context.showId,
      runArtist: { is: { artistId: context.artistId } },
      show: { is: { syncStatus: "active" } },
    },
    select: { id: true },
  });
  if (!recommendation) {
    throw new Error(
      "The trajectory recommendation does not match this show and artist",
    );
  }
}
