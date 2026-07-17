export interface FestivalFormValues {
  name: string;
  date: string;
  venueName: string;
  city: string;
  state: string;
  countryCode: string;
  lineup: string;
}

export interface FestivalArtistCandidate {
  id: string;
  name: string;
  spotifyId: string | null;
  statsfmId: string | null;
  edmtrainId: number | null;
}

export interface FestivalArtistAmbiguity {
  selectionKey: string;
  lineupName: string;
  selectedId: string;
  candidates: FestivalArtistCandidate[];
}

export interface FestivalFormState {
  values: FestivalFormValues;
  message: string | null;
  ambiguities: FestivalArtistAmbiguity[];
}

export const INITIAL_FESTIVAL_FORM_STATE: FestivalFormState = {
  values: {
    name: "",
    date: "",
    venueName: "",
    city: "",
    state: "",
    countryCode: "US",
    lineup: "",
  },
  message: null,
  ambiguities: [],
};
