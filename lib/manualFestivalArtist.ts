import { chooseFestivalLineupCandidate } from "@/lib/festivalLineup";
import { normalizeArtistName } from "@/lib/normalize";

export interface ManualFestivalArtistCandidate {
  id: string;
  name: string;
  spotifyId: string | null;
  statsfmId: string | null;
  edmtrainId: number | null;
  onLineup: boolean;
  manuallyAdded: boolean;
}

export const MANUAL_FESTIVAL_ARTIST_LIST_LIMIT = 200;
export const MANUAL_FESTIVAL_ARTIST_NAME_MAX_LENGTH = 300;

export interface ParsedManualFestivalArtistList {
  artists: Array<{ name: string; normalizedName: string }>;
  duplicateCount: number;
  error: string | null;
}

export function parseManualFestivalArtistList(
  value: string,
): ParsedManualFestivalArtistList {
  const rawNames = value
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean);
  if (rawNames.length === 0) {
    return {
      artists: [],
      duplicateCount: 0,
      error: "Enter at least one artist name.",
    };
  }
  if (rawNames.length > MANUAL_FESTIVAL_ARTIST_LIST_LIMIT) {
    return {
      artists: [],
      duplicateCount: 0,
      error: `Add at most ${MANUAL_FESTIVAL_ARTIST_LIST_LIMIT} artists at a time.`,
    };
  }

  const artists: ParsedManualFestivalArtistList["artists"] = [];
  const seen = new Set<string>();
  let duplicateCount = 0;
  for (const name of rawNames) {
    if (name.length > MANUAL_FESTIVAL_ARTIST_NAME_MAX_LENGTH) {
      return {
        artists: [],
        duplicateCount,
        error: `Artist names must be ${MANUAL_FESTIVAL_ARTIST_NAME_MAX_LENGTH} characters or fewer.`,
      };
    }
    const normalizedName = normalizeArtistName(name);
    if (!normalizedName) {
      return {
        artists: [],
        duplicateCount,
        error: `"${name}" must contain letters or numbers.`,
      };
    }
    if (seen.has(normalizedName)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(normalizedName);
    artists.push({ name, normalizedName });
  }
  return { artists, duplicateCount, error: null };
}

export type ManualFestivalArtistDecision =
  | { kind: "create" }
  | { kind: "use"; candidate: ManualFestivalArtistCandidate }
  | { kind: "already-on-lineup"; candidate: ManualFestivalArtistCandidate }
  | { kind: "ambiguous"; candidates: readonly ManualFestivalArtistCandidate[] };

export function chooseManualFestivalArtist(
  candidates: readonly ManualFestivalArtistCandidate[],
  selectedId: string | null,
): ManualFestivalArtistDecision {
  const decision = chooseFestivalLineupCandidate(candidates, selectedId);
  if (decision.kind !== "use") return decision;
  return decision.candidate.onLineup
    ? { kind: "already-on-lineup", candidate: decision.candidate }
    : decision;
}

export type ManualFestivalArtistRemoval =
  | "provider-owned"
  | "delete-association"
  | "retain-provider-association";

export function manualFestivalArtistRemoval(
  association: {
    providerManaged: boolean;
    manuallyAdded: boolean;
  },
): ManualFestivalArtistRemoval {
  if (!association.manuallyAdded) return "provider-owned";
  return association.providerManaged
    ? "retain-provider-association"
    : "delete-association";
}
