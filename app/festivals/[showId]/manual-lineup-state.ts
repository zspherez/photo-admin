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
