import { easternDateOnly, parseDateOnly } from "@/lib/calendarDate";
import { db } from "@/lib/db";

export function festivalRunWindow(now: Date = new Date()): {
  start: Date;
  end: Date;
} {
  const start = parseDateOnly(easternDateOnly(now));
  const end = new Date(Date.UTC(
    start.getUTCFullYear() + 1,
    start.getUTCMonth(),
    start.getUTCDate(),
  ));
  return { start, end };
}

export function festivalRunDaysAhead(now: Date = new Date()): number {
  const { start, end } = festivalRunWindow(now);
  return Math.round((end.getTime() - start.getTime()) / 86_400_000) - 1;
}

export function festivalRunName(name: string): string {
  return name.normalize("NFKC").trim().toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ").replace(/\s+(festival|fest)$/, "");
}

export function groupFestivalRuns<
  T extends {
    id: string;
    date: Date;
    eventName: string | null;
    venueName: string;
    artists: Array<{
      artistId: string;
      rejectedAt: Date | null;
      artist: { name: string };
    }>;
  },
>(shows: T[]): Array<{ artistId: string; artistName: string; shows: T[] }> {
  const groups = new Map<string, { artistId: string; artistName: string; shows: T[] }>();
  for (const show of shows) {
    const name = festivalRunName(show.eventName || show.venueName);
    if (!name || name === "unknown") continue;
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
    .filter((group) => new Set(group.shows.map((show) =>
      festivalRunName(show.eventName || show.venueName),
    )).size >= 2)
    .sort((a, b) => a.shows[0].date.getTime() - b.shows[0].date.getTime() ||
      a.artistName.localeCompare(b.artistName));
}

export async function loadFestivalRuns(now: Date = new Date()) {
  const { start, end } = festivalRunWindow(now);
  const shows = await db.show.findMany({
    where: {
      isFestival: true,
      syncStatus: "active",
      dismissedAt: null,
      date: { gte: start, lt: end },
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
  return groupFestivalRuns(shows);
}
