import { Prisma, type TrajectoryArm } from "@prisma/client";
import type { MatchedShow } from "@/lib/match";
import {
  resolveDefaultTrajectoryRun,
  type TrajectoryRunAvailability,
  type TrajectoryRunRecord,
} from "@/lib/trajectoryActiveRun";
import { db } from "@/lib/db";

export interface DashboardRecommendationBadge {
  recommendationId: string;
  runId: string;
  showId: string;
  artistId: string;
  arm: "trajectory" | "momentum" | "exploration" | "portfolio";
  isSuggested: boolean;
}

interface BadgeCandidate {
  id: string;
  runId: string;
  showId: string;
  arm: TrajectoryArm;
  isSuggested: boolean;
  listRank: number;
  slatePosition: number | null;
  runArtist: { artistId: string | null };
}

interface DashboardRecommendationDependencies {
  resolveRun: (now: Date) => Promise<{
    availability: TrajectoryRunAvailability;
    run: TrajectoryRunRecord | null;
  }>;
  findRecommendations: (
    runId: string,
    showIds: readonly string[],
    artistIds: readonly string[],
  ) => Promise<BadgeCandidate[]>;
}

const DEFAULT_DEPENDENCIES: DashboardRecommendationDependencies = {
  resolveRun: resolveDefaultTrajectoryRun,
  findRecommendations: (runId, showIds, artistIds) =>
    db.trajectoryRecommendation.findMany({
      where: {
        runId,
        showId: { in: [...showIds] },
        runArtist: { is: { artistId: { in: [...artistIds] } } },
      },
      orderBy: [
        { isSuggested: "desc" },
        { slatePosition: "asc" },
        { listRank: "asc" },
        { id: "asc" },
      ],
      select: {
        id: true,
        runId: true,
        showId: true,
        arm: true,
        isSuggested: true,
        listRank: true,
        slatePosition: true,
        runArtist: { select: { artistId: true } },
      },
    }),
};

function modelTablesUnavailable(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2021" || error.code === "P2022")
  );
}

function priority(candidate: BadgeCandidate): number {
  if (candidate.isSuggested && candidate.arm === "trajectory") return 2;
  if (candidate.arm === "trajectory") return 3;
  if (candidate.arm === "momentum") return 4;
  if (candidate.arm === "exploration") return 6;
  return 7;
}

export async function getDashboardRecommendationBadges(
  shows: readonly MatchedShow[],
  now: Date,
  dependencies: DashboardRecommendationDependencies = DEFAULT_DEPENDENCIES,
): Promise<DashboardRecommendationBadge[]> {
  const targetKeys = new Set(
    shows.flatMap((show) =>
      show.matchedArtists.map((artist) => `${show.id}\u0000${artist.id}`),
    ),
  );
  if (targetKeys.size === 0) return [];
  const showIds = [...new Set(shows.map((show) => show.id))];
  const artistIds = [
    ...new Set(
      shows.flatMap((show) => show.matchedArtists.map((artist) => artist.id)),
    ),
  ];

  try {
    const resolved = await dependencies.resolveRun(now);
    if (resolved.availability !== "ready" || !resolved.run) return [];
    const candidates = await dependencies.findRecommendations(
      resolved.run.id,
      showIds,
      artistIds,
    );
    candidates.sort(
      (left, right) =>
        priority(left) - priority(right) ||
        (left.slatePosition ?? left.listRank) -
          (right.slatePosition ?? right.listRank) ||
        left.id.localeCompare(right.id),
    );
    const badges = new Map<string, DashboardRecommendationBadge>();
    for (const candidate of candidates) {
      const artistId = candidate.runArtist.artistId;
      if (!artistId || candidate.runId !== resolved.run.id) continue;
      const key = `${candidate.showId}\u0000${artistId}`;
      if (!targetKeys.has(key) || badges.has(key)) continue;
      badges.set(key, {
        recommendationId: candidate.id,
        runId: candidate.runId,
        showId: candidate.showId,
        artistId,
        arm: candidate.arm,
        isSuggested: candidate.isSuggested,
      });
    }
    return [...badges.values()];
  } catch (error) {
    if (modelTablesUnavailable(error)) return [];
    throw error;
  }
}
