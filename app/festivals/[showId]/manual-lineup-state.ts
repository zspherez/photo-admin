import type { ManualFestivalArtistCandidate } from "@/lib/manualFestivalArtist";

export interface ManualFestivalArtistFormState {
  artistName: string;
  message: string | null;
  ambiguities: ManualFestivalArtistCandidate[];
}

export const INITIAL_MANUAL_FESTIVAL_ARTIST_STATE: ManualFestivalArtistFormState = {
  artistName: "",
  message: null,
  ambiguities: [],
};

export interface BulkManualFestivalArtistFormState {
  artistNames: string;
  message: string | null;
  addedCount: number;
  preservedCount: number;
  existingCount: number;
  duplicateCount: number;
  ambiguousNames: string[];
}

export const INITIAL_BULK_MANUAL_FESTIVAL_ARTIST_STATE: BulkManualFestivalArtistFormState =
  {
    artistNames: "",
    message: null,
    addedCount: 0,
    preservedCount: 0,
    existingCount: 0,
    duplicateCount: 0,
    ambiguousNames: [],
  };
