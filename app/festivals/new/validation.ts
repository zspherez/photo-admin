import {
  easternTodayStoredDate,
  parseDateOnly,
} from "@/lib/calendarDate";
import {
  parseFestivalLineupEntries,
  type FestivalLineupEntry,
} from "@/lib/festivalLineup";
import {
  countryNameForCode,
  normalizeCountryCode,
} from "@/lib/country";
import { classifyVenueNycGeography } from "@/lib/edmtrainVenue";
import {
  festivalLeadTimeError,
  festivalLeadTimeExclusion,
} from "@/lib/festivalEligibility";
import type { FestivalFormValues } from "./form-state";

export type FestivalCreationValidation =
  | {
      ok: true;
      date: Date;
      entries: FestivalLineupEntry[];
      countryCode: string;
      countryName: string;
    }
  | {
      ok: false;
      message: string;
    };

export function validateFestivalCreation(
  values: FestivalFormValues,
  now: Date = new Date()
): FestivalCreationValidation {
  if (!values.name || !values.date || !values.venueName || !values.city) {
    return {
      ok: false,
      message: "Name, date, venue, and city are required.",
    };
  }

  const countryCode = normalizeCountryCode(values.countryCode);
  const countryName = countryNameForCode(countryCode);
  if (!countryCode || !countryName) {
    return {
      ok: false,
      message: "Country must be a valid two-letter ISO country code.",
    };
  }

  let date: Date;
  try {
    date = parseDateOnly(values.date);
  } catch {
    return {
      ok: false,
      message: "Invalid date — use YYYY-MM-DD.",
    };
  }

  const today = easternTodayStoredDate(now);
  if (date < today) {
    return {
      ok: false,
      message:
        "Festival date cannot be before the current America/New_York calendar day.",
    };
  }

  const geography = classifyVenueNycGeography({
    location: [values.city, values.state].filter(Boolean).join(", "),
    state: values.state || null,
    country: countryCode,
  });
  const leadTimeExclusion = festivalLeadTimeExclusion(
    {
      isFestival: true,
      date,
      venueNycStatus: geography.status,
    },
    now
  );
  if (leadTimeExclusion) {
    return {
      ok: false,
      message: festivalLeadTimeError(leadTimeExclusion),
    };
  }

  const lineup = parseFestivalLineupEntries(values.lineup);
  if (lineup.error) {
    return { ok: false, message: lineup.error };
  }
  if (lineup.entries.length === 0) {
    return {
      ok: false,
      message: "Lineup must include at least one artist.",
    };
  }

  return {
    ok: true,
    date,
    entries: lineup.entries,
    countryCode,
    countryName,
  };
}
