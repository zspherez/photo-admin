import { easternDateOnly, parseDateOnly } from "@/lib/calendarDate";
import { db } from "@/lib/db";

export function newYearRunWindow(now: Date = new Date()): {
  year: number;
  start: Date;
  end: Date;
} {
  const today = easternDateOnly(now);
  const year = Number(today.slice(0, 4));
  const season = today.slice(5) <= "01-03" ? year - 1 : year;
  return {
    year: season,
    start: parseDateOnly(`${season}-12-27`),
    end: parseDateOnly(`${season + 1}-01-03`),
  };
}

export function isNewYearRunDate(date: string): boolean {
  return /^\d{4}-(12-(2[7-9]|3[01])|01-0[1-3])$/.test(date);
}

export function newYearRunWindowsWithin(
  range: { start: Date; end: Date }
): Array<{ gte: Date; lte: Date }> {
  const windows: Array<{ gte: Date; lte: Date }> = [];
  for (
    let year = range.start.getUTCFullYear() - 1;
    year <= range.end.getUTCFullYear();
    year++
  ) {
    const start = parseDateOnly(`${year}-12-27`);
    const end = parseDateOnly(`${year + 1}-01-03`);
    if (start <= range.end && end >= range.start) {
      windows.push({
        gte: start > range.start ? start : range.start,
        lte: end < range.end ? end : range.end,
      });
    }
  }
  return windows;
}

function cityKey(show: { city: string; state: string | null }): string {
  return `${show.city.trim().toLocaleLowerCase("en-US")},${show.state?.trim().toLocaleLowerCase("en-US") ?? ""}`;
}

export function groupNewYearRuns<
  T extends {
    id: string;
    date: Date;
    city: string;
    state: string | null;
    artists: Array<{
      artistId: string;
      rejectedAt: Date | null;
      artist: { name: string };
    }>;
  },
>(shows: T[]): Array<{
  artistId: string;
  artistName: string;
  shows: T[];
}> {
  const groups = new Map<string, { artistId: string; artistName: string; shows: T[] }>();
  for (const show of shows) {
    if (!show.city.trim() || show.city.trim().toLowerCase() === "unknown") continue;
    for (const membership of show.artists) {
      if (membership.rejectedAt) continue;
      const group = groups.get(membership.artistId) ?? {
        artistId: membership.artistId,
        artistName: membership.artist.name,
        shows: [],
      };
      group.shows.push(show);
      groups.set(membership.artistId, group);
    }
  }
  return [...groups.values()]
    .filter((group) => new Set(group.shows.map(cityKey)).size >= 2)
    .sort((a, b) => a.shows[0].date.getTime() - b.shows[0].date.getTime() ||
      a.artistName.localeCompare(b.artistName));
}

export async function loadNewYearRuns(now: Date = new Date()) {
  const { start, end } = newYearRunWindow(now);
  const shows = await db.show.findMany({
    where: {
      date: { gte: start, lte: end },
      countryCode: "US",
      dismissedAt: null,
      OR: [
        { isFestival: true, syncStatus: "active" },
        { isFestival: false, syncStatus: { in: ["active", "outside_nyc"] } },
      ],
    },
    include: {
      artists: {
        include: {
          artist: {
            include: {
              contacts: {
                where: { state: "active", email: { not: null } },
                orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
              },
            },
          },
        },
      },
    },
    orderBy: [{ date: "asc" }, { id: "asc" }],
  });
  return groupNewYearRuns(shows);
}
