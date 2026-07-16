import { normalizeArtistName } from "./normalize";

export type FestivalLineupDecision<T> =
  | { kind: "create" }
  | { kind: "use"; candidate: T }
  | { kind: "ambiguous"; candidates: readonly T[] };

export function chooseFestivalLineupCandidate<T extends { id: string }>(
  candidates: readonly T[],
  selectedId: string | null
): FestivalLineupDecision<T> {
  if (candidates.length === 0) return { kind: "create" };
  if (candidates.length === 1) {
    return { kind: "use", candidate: candidates[0] };
  }
  const selected = selectedId
    ? candidates.find((candidate) => candidate.id === selectedId)
    : null;
  return selected
    ? { kind: "use", candidate: selected }
    : { kind: "ambiguous", candidates };
}

export interface FestivalLineupEntry {
  name: string;
  normalizedName: string;
  selectionKey: string;
}

export function parseFestivalLineupEntries(
  lineup: string
): { entries: FestivalLineupEntry[]; error: string | null } {
  const entries: FestivalLineupEntry[] = [];
  for (const name of lineup
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)) {
    const normalizedName = normalizeArtistName(name);
    if (!normalizedName) {
      return {
        entries: [],
        error: `Lineup artist "${name}" does not contain a usable name.`,
      };
    }
    entries.push({
      name,
      normalizedName,
      selectionKey: `artistChoice:${entries.length}`,
    });
  }
  return { entries, error: null };
}

export function dedupeFestivalArtistIds(
  artistIds: readonly string[]
): string[] {
  return Array.from(new Set(artistIds));
}
