import type { Prisma } from "@prisma/client";

export interface ListenSignalRank {
  source: string;
  rank: number | null;
  expiresAt: Date | null;
}

const SOURCE_LABELS: Record<string, string> = {
  statsfm_lifetime: "Stats.fm lifetime",
  statsfm_months: "Stats.fm 6mo",
  statsfm_weeks: "Stats.fm 4wk",
  spotify_top_long: "Spotify all-time",
  spotify_top_medium: "Spotify 6mo",
  spotify_top_short: "Spotify 4wk",
  spotify_recent: "Spotify recent",
  spotify_followed: "Spotify follow",
  spotify_playlist: "Spotify playlist",
};

const SOURCE_PRIORITY = new Map(
  Object.keys(SOURCE_LABELS).map((source, index) => [source, index])
);

export function formatRankLabel(source: string, rank: number | null): string {
  const label = SOURCE_LABELS[source] ?? source;
  return rank ? `${label} #${rank}` : label;
}

export function isListenSignalActive(
  signal: Pick<ListenSignalRank, "source" | "expiresAt">,
  now: Date = new Date()
): boolean {
  if (signal.expiresAt) return signal.expiresAt.getTime() > now.getTime();
  return signal.source !== "spotify_recent";
}

export function activeListenSignalWhere(
  now: Date = new Date(),
  sourcePrefix: string | null = null
): Prisma.ListenSignalWhereInput {
  const freshness: Prisma.ListenSignalWhereInput = {
    OR: [
      { expiresAt: { gt: now } },
      { source: { not: "spotify_recent" }, expiresAt: null },
    ],
  };
  return sourcePrefix
    ? { AND: [freshness, { source: { startsWith: sourcePrefix } }] }
    : freshness;
}

function compareListenSignals(a: ListenSignalRank, b: ListenSignalRank): number {
  const rankA = a.rank ?? Number.POSITIVE_INFINITY;
  const rankB = b.rank ?? Number.POSITIVE_INFINITY;
  if (rankA !== rankB) return rankA - rankB;

  const priorityA = SOURCE_PRIORITY.get(a.source) ?? Number.POSITIVE_INFINITY;
  const priorityB = SOURCE_PRIORITY.get(b.source) ?? Number.POSITIVE_INFINITY;
  if (priorityA !== priorityB) return priorityA - priorityB;
  return a.source < b.source ? -1 : a.source > b.source ? 1 : 0;
}

export function pickTopListenSignal<T extends ListenSignalRank>(
  signals: readonly T[],
  now: Date = new Date()
): T | null {
  return signals
    .filter((signal) => isListenSignalActive(signal, now))
    .sort(compareListenSignals)[0] ?? null;
}
