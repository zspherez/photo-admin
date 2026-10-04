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

export class FestivalLineupMergeSelectionError extends Error {}

export function planFestivalLineupMerges(
  choices: readonly {
    name: string;
    normalizedName: string;
    candidates: readonly { id: string }[];
    selectedId: string | null;
    confirmed: boolean;
  }[],
): Array<{ name: string; targetId: string; sourceIds: string[] }> {
  const plans = new Map<
    string,
    { name: string; targetId: string; sourceIds: string[] }
  >();
  for (const choice of choices) {
    if (!choice.confirmed) continue;
    if (choice.candidates.length === 0) {
      throw new FestivalLineupMergeSelectionError(
        `${choice.name} no longer has matching records. Review the lineup before merging.`,
      );
    }
    if (choice.candidates.length === 1) continue;
    if (!choice.selectedId ||
        !choice.candidates.some((candidate) => candidate.id === choice.selectedId)) {
      throw new FestivalLineupMergeSelectionError(
        `Choose the record to keep for ${choice.name} before merging.`,
      );
    }
    const existing = plans.get(choice.normalizedName);
    if (existing && existing.targetId !== choice.selectedId) {
      throw new FestivalLineupMergeSelectionError(
        `Lineup entries for ${choice.name} choose different records. They cannot be merged together.`,
      );
    }
    if (!existing) {
      plans.set(choice.normalizedName, {
        name: choice.name,
        targetId: choice.selectedId,
        sourceIds: choice.candidates
          .filter((candidate) => candidate.id !== choice.selectedId)
          .map((candidate) => candidate.id),
      });
    }
  }
  for (const choice of choices) {
    const plan = plans.get(choice.normalizedName);
    if (
      plan &&
      choice.candidates.length > 1 &&
      choice.selectedId !== plan.targetId
    ) {
      throw new FestivalLineupMergeSelectionError(
        `Every ${choice.name} lineup entry must select the same record before merging.`,
      );
    }
  }
  return [...plans.values()];
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
