import { Prisma } from "@prisma/client";
import {
  addDateOnlyDays,
  easternDateOnly,
  parseDateOnly,
} from "@/lib/calendarDate";
import type { VenueNycStatus } from "@/lib/edmtrainVenue";

export const FESTIVAL_MINIMUM_LEAD_DAYS = 7;

export type FestivalLeadTimeExclusion =
  | "festival_past"
  | "lead_time_outside_nyc"
  | "lead_time_geography_unknown";

export interface FestivalLeadTimeInput {
  isFestival: boolean;
  date: Date;
  festivalNycStatus: string | null;
}

export function festivalLeadTimeCutoff(now: Date = new Date()): Date {
  return parseDateOnly(
    addDateOnlyDays(easternDateOnly(now), FESTIVAL_MINIMUM_LEAD_DAYS)
  );
}

function validVenueNycStatus(value: string | null | undefined): VenueNycStatus | null {
  if (value === "inside_nyc" || value === "outside_nyc") return value;
  if (value === "unknown") return value;
  return null;
}

export function festivalNycStatus(
  show: FestivalLeadTimeInput
): VenueNycStatus {
  return validVenueNycStatus(show.festivalNycStatus) ?? "unknown";
}

export function festivalLeadTimeExclusion(
  show: FestivalLeadTimeInput,
  now: Date = new Date()
): FestivalLeadTimeExclusion | null {
  if (!show.isFestival) return null;
  if (show.date < parseDateOnly(easternDateOnly(now))) {
    return "festival_past";
  }
  const nycStatus = festivalNycStatus(show);
  if (nycStatus === "inside_nyc") return null;
  if (show.date >= festivalLeadTimeCutoff(now)) return null;
  return nycStatus === "outside_nyc"
    ? "lead_time_outside_nyc"
    : "lead_time_geography_unknown";
}

export function satisfiesFestivalLeadTime(
  show: FestivalLeadTimeInput,
  now: Date = new Date()
): boolean {
  return festivalLeadTimeExclusion(show, now) === null;
}

export function festivalLeadTimeWhere(
  now: Date = new Date()
): Prisma.ShowWhereInput {
  const today = parseDateOnly(easternDateOnly(now));
  return {
    OR: [
      { isFestival: false },
      {
        isFestival: true,
        date: { gte: today },
        OR: [
          { festivalNycStatus: "inside_nyc" },
          { date: { gte: festivalLeadTimeCutoff(now) } },
        ],
      },
    ],
  };
}

export function festivalLeadTimeSql(
  now: Date = new Date()
): Prisma.Sql {
  const today = parseDateOnly(easternDateOnly(now));
  const cutoff = festivalLeadTimeCutoff(now);
  return Prisma.sql`
    (
      show."isFestival" = false
      OR (
        show."isFestival" = true
        AND show."date" >= ${today}
        AND (
          show."festivalNycStatus" = 'inside_nyc'
          OR show."date" >= ${cutoff}
        )
      )
    )
  `;
}

export function activeFestivalWhere(
  now: Date = new Date()
): Prisma.ShowWhereInput {
  return {
    isFestival: true,
    syncStatus: "active",
    AND: [festivalLeadTimeWhere(now)],
  };
}

export function festivalLeadTimeError(
  exclusion: FestivalLeadTimeExclusion
): string {
  if (exclusion === "festival_past") {
    return "Past festivals are not actionable.";
  }
  return exclusion === "lead_time_geography_unknown"
    ? "Festival geography is unknown, so festivals fewer than 7 calendar days away are not actionable."
    : "Non-NYC festivals fewer than 7 calendar days away are not actionable.";
}
