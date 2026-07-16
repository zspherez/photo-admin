import {
  easternTodayStoredDate,
  parseDateOnly,
} from "@/lib/calendarDate";
import {
  parseFestivalLineupEntries,
  type FestivalLineupEntry,
} from "@/lib/festivalLineup";
import type { FestivalFormValues } from "./form-state";

export type FestivalCreationValidation =
  | {
      ok: true;
      date: Date;
      entries: FestivalLineupEntry[];
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

  return { ok: true, date, entries: lineup.entries };
}
