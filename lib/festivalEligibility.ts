import { Prisma } from "@prisma/client";
import {
  addDateOnlyDays,
  easternDateOnly,
  parseDateOnly,
} from "@/lib/calendarDate";
import {
  classifyVenueNycGeography,
  NYC_LOCALITY_NAMES,
  type VenueNycStatus,
} from "@/lib/edmtrainVenue";

export const FESTIVAL_MINIMUM_LEAD_DAYS = 7;

export type FestivalLeadTimeExclusion =
  | "lead_time_outside_nyc"
  | "lead_time_geography_unknown";

export interface FestivalLeadTimeInput {
  isFestival: boolean;
  date: Date;
  city?: string | null;
  state?: string | null;
  countryCode?: string | null;
  edmtrainVenue?: { nycStatus: string } | null;
  venueNycStatus?: string | null;
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
  const venueStatus = validVenueNycStatus(
    show.edmtrainVenue?.nycStatus ?? show.venueNycStatus
  );
  if (venueStatus) return venueStatus;
  return classifyVenueNycGeography({
    location: show.city ?? null,
    state: show.state ?? null,
    country: show.countryCode ?? null,
  }).status;
}

export function festivalLeadTimeExclusion(
  show: FestivalLeadTimeInput,
  now: Date = new Date()
): FestivalLeadTimeExclusion | null {
  if (!show.isFestival) return null;
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
  return {
    OR: [
      { isFestival: false },
      { date: { gte: festivalLeadTimeCutoff(now) } },
      {
        edmtrainVenue: {
          is: { nycStatus: "inside_nyc" },
        },
      },
      {
        AND: [
          { edmtrainVenueId: null },
          {
            countryCode: {
              equals: "US",
              mode: "insensitive",
            },
          },
          {
            state: {
              in: ["NY", "New York"],
              mode: "insensitive",
            },
          },
          {
            city: {
              in: [...NYC_LOCALITY_NAMES],
              mode: "insensitive",
            },
          },
        ],
      },
    ],
  };
}

export function festivalLeadTimeSql(
  now: Date = new Date()
): Prisma.Sql {
  const cutoff = festivalLeadTimeCutoff(now);
  return Prisma.sql`
    (
      show."isFestival" = false
      OR show."date" >= ${cutoff}
      OR EXISTS (
        SELECT 1
        FROM "EdmtrainVenue" festival_venue
        WHERE festival_venue."id" = show."edmtrainVenueId"
          AND festival_venue."nycStatus" = 'inside_nyc'
      )
      OR (
        show."edmtrainVenueId" IS NULL
        AND upper(trim(COALESCE(show."countryCode", ''))) = 'US'
        AND lower(trim(COALESCE(show."state", ''))) IN ('ny', 'new york')
        AND lower(trim(show."city")) IN (${Prisma.join(NYC_LOCALITY_NAMES)})
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
    date: { gte: parseDateOnly(easternDateOnly(now)) },
    AND: [festivalLeadTimeWhere(now)],
  };
}

export function festivalLeadTimeError(
  exclusion: FestivalLeadTimeExclusion
): string {
  return exclusion === "lead_time_geography_unknown"
    ? "Festival geography is unknown, so festivals fewer than 7 calendar days away are not actionable."
    : "Non-NYC festivals fewer than 7 calendar days away are not actionable.";
}
