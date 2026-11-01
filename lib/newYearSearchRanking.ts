import { isListenSignalActive, type ListenSignalRank } from "@/lib/listenSignal";

const SPOTIFY_SOURCES = new Set([
  "spotify_top_long", "spotify_top_medium", "spotify_top_short",
]);
const STATSFM_SOURCES = new Set([
  "statsfm_lifetime", "statsfm_months", "statsfm_weeks",
]);

export type RankedArtistSignal = ListenSignalRank & { artistId: string };

function topArtistIds(
  signals: readonly RankedArtistSignal[],
  sources: ReadonlySet<string>,
  now: Date
): string[] {
  const bestRanks = new Map<string, number>();
  for (const signal of signals) {
    if (!sources.has(signal.source) || !isListenSignalActive(signal, now) ||
      !Number.isInteger(signal.rank) || signal.rank! < 1 || signal.rank! > 100) continue;
    bestRanks.set(signal.artistId, Math.min(bestRanks.get(signal.artistId) ?? Infinity, signal.rank!));
  }
  return [...bestRanks].sort(([idA, rankA], [idB, rankB]) =>
    rankA - rankB || (idA < idB ? -1 : idA > idB ? 1 : 0)
  ).slice(0, 100).map(([artistId]) => artistId);
}

export function selectNewYearSearchArtistIds(
  signals: readonly RankedArtistSignal[],
  now: Date = new Date()
): string[] {
  return [...new Set([
    ...topArtistIds(signals, SPOTIFY_SOURCES, now),
    ...topArtistIds(signals, STATSFM_SOURCES, now),
  ])];
}
