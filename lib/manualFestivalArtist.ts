import { chooseFestivalLineupCandidate } from "@/lib/festivalLineup";

export interface ManualFestivalArtistCandidate {
  id: string;
  name: string;
  spotifyId: string | null;
  statsfmId: string | null;
  edmtrainId: number | null;
  onLineup: boolean;
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
  if (
    candidates.length > 1 &&
    candidates.every((candidate) => candidate.onLineup)
  ) {
    return { kind: "already-on-lineup", candidate: candidates[0] };
  }
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
