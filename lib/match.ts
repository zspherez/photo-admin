import { db } from "@/lib/db";

export interface MatchedShow {
  id: string;
  date: Date;
  venueName: string;
  city: string;
  state: string | null;
  ticketUrl: string | null;
  dismissedAt: Date | null;
  interestedAt: Date | null;
  matchedArtists: {
    id: string;
    name: string;
    genres: string[];
    popularity: number | null;
    topSignal: { source: string; rank: number | null } | null;
    playlists: { spotifyId: string; name: string; url: string }[];
    contacts: {
      id: string;
      email: string;
      name: string | null;
      role: string | null;
      customPrice: string | null;
      isFullTeam: boolean;
    }[];
  }[];
  otherArtists: { id: string; name: string }[];
  outreach: {
    contactId: string;
    sentAt: Date | null;
    deliveredAt: Date | null;
    status: string;
    firstClickedAt: Date | null;
    clickCount: number;
    firstOpenedAt: Date | null;
    openCount: number;
  }[];
}

export type RangeFilter = "7d" | "30d" | "90d";
export type SourceFilter = "any" | "statsfm" | "spotify";
export type ContactFilter = "any" | "has" | "needs";
export type StatusFilter = "any" | "unsent" | "sent" | "opened" | "clicked";

export interface MatchFilters {
  range: RangeFilter;
  source: SourceFilter;
  contact: ContactFilter;
  status: StatusFilter;
  search: string;
  includeDismissed?: boolean;
}

export const DEFAULT_FILTERS: MatchFilters = {
  range: "90d",
  source: "any",
  contact: "any",
  status: "any",
  search: "",
  includeDismissed: false,
};

function rangeEndDate(range: RangeFilter): Date {
  const now = new Date();
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  return new Date(now.getTime() + days * 86400_000);
}

// Loads the maximum useful window once; client-side filtering handles
// range/source/contact/status/search. The widest range we offer is 90d, so
// load 90d and let the client narrow. Pass includeDismissed to surface
// dismissed shows in the same payload (client toggles visibility).
export async function getMatchedShowsForClient(includeDismissed = true): Promise<MatchedShow[]> {
  return getMatchedUpcomingShows({ ...DEFAULT_FILTERS, range: "90d", includeDismissed });
}

export async function getMatchedUpcomingShows(
  filters: MatchFilters = DEFAULT_FILTERS
): Promise<MatchedShow[]> {
  const sourcePrefix =
    filters.source === "statsfm" ? "statsfm_" : filters.source === "spotify" ? "spotify_" : null;

  const shows = await db.show.findMany({
    where: {
      date: { gte: new Date(), lte: rangeEndDate(filters.range) },
      isFestival: false,
      dismissedAt: filters.includeDismissed ? undefined : null,
      artists: {
        some: {
          artist: {
            listenSignals: sourcePrefix
              ? { some: { source: { startsWith: sourcePrefix } } }
              : { some: {} },
            ...(filters.search
              ? { name: { contains: filters.search } }
              : {}),
          },
        },
      },
    },
    orderBy: { date: "asc" },
    include: {
      artists: {
        include: {
          artist: {
            include: {
              listenSignals: { orderBy: { rank: "asc" } },
              contacts: true,
              playlists: { include: { playlist: true } },
            },
          },
        },
      },
      outreaches: true,
    },
    take: 500,
  });

  type ShowArtist = (typeof shows)[number]["artists"][number];

  const sourceMatches = (sa: ShowArtist) =>
    sourcePrefix
      ? sa.artist.listenSignals.some((s) => s.source.startsWith(sourcePrefix))
      : sa.artist.listenSignals.length > 0;

  const mapped = shows.map((show) => {
    const matched: MatchedShow["matchedArtists"] = [];
    const others: MatchedShow["otherArtists"] = [];
    for (const sa of show.artists as ShowArtist[]) {
      if (sourceMatches(sa)) {
        const top = sa.artist.listenSignals[0];
        let genres: string[] = [];
        if (sa.artist.genres) {
          try {
            const parsed = JSON.parse(sa.artist.genres) as unknown;
            if (Array.isArray(parsed)) genres = parsed.filter((g): g is string => typeof g === "string");
          } catch {
            // ignore malformed
          }
        }
        matched.push({
          id: sa.artist.id,
          name: sa.artist.name,
          genres,
          popularity: sa.artist.popularity,
          topSignal: top ? { source: top.source, rank: top.rank } : null,
          playlists: sa.artist.playlists.map((ap) => ({
            spotifyId: ap.playlist.spotifyId,
            name: ap.playlist.name,
            url: ap.playlist.url,
          })),
          contacts: sa.artist.contacts.map((c) => ({
            id: c.id,
            email: c.email,
            name: c.name,
            role: c.role,
            customPrice: c.customPrice,
            isFullTeam: c.isFullTeam,
          })),
        });
      } else {
        others.push({ id: sa.artist.id, name: sa.artist.name });
      }
    }
    return {
      id: show.id,
      date: show.date,
      venueName: show.venueName,
      city: show.city,
      state: show.state,
      ticketUrl: show.ticketUrl,
      dismissedAt: show.dismissedAt,
      interestedAt: show.interestedAt,
      matchedArtists: matched,
      otherArtists: others,
      outreach: show.outreaches.map((o) => ({
        contactId: o.contactId,
        sentAt: o.sentAt,
        deliveredAt: o.deliveredAt,
        status: o.status,
        firstClickedAt: o.firstClickedAt,
        clickCount: o.clickCount,
        firstOpenedAt: o.firstOpenedAt,
        openCount: o.openCount,
      })),
    };
  });

  const filtered = mapped.filter((show) => {
    if (show.matchedArtists.length === 0) return false;

    if (filters.contact === "has" && !show.matchedArtists.some((a) => a.contacts.length > 0))
      return false;
    if (filters.contact === "needs" && !show.matchedArtists.some((a) => a.contacts.length === 0))
      return false;

    if (filters.status !== "any") {
      const anySent = show.outreach.some((o) => o.status === "sent");
      const anyOpened = show.outreach.some((o) => o.openCount > 0);
      const anyClicked = show.outreach.some((o) => o.clickCount > 0);
      if (filters.status === "sent" && !anySent) return false;
      if (filters.status === "unsent" && anySent) return false;
      if (filters.status === "opened" && !anyOpened) return false;
      if (filters.status === "clicked" && !anyClicked) return false;
    }
    return true;
  });

  return filtered.slice(0, 200);
}

// Shows where I have NO listen signal but the artist is otherwise notable —
// high Spotify popularity. Helps surface gigs I'd want despite the artist
// not being in my listening graph. Loads 90d, client narrows further.
export async function getUnknownBigShowsForClient(
  minPopularity = 60
): Promise<MatchedShow[]> {
  const shows = await db.show.findMany({
    where: {
      date: { gte: new Date(), lte: rangeEndDate("90d") },
      isFestival: false,
      dismissedAt: null,
      artists: {
        some: {
          artist: {
            popularity: { gte: minPopularity },
            listenSignals: { none: {} },
          },
        },
      },
    },
    orderBy: { date: "asc" },
    include: {
      artists: {
        include: {
          artist: {
            include: {
              listenSignals: { orderBy: { rank: "asc" } },
              contacts: true,
              playlists: { include: { playlist: true } },
            },
          },
        },
      },
      outreaches: true,
    },
    take: 200,
  });

  type ShowArtist = (typeof shows)[number]["artists"][number];

  return shows.map((show) => {
    const featured: MatchedShow["matchedArtists"] = [];
    const others: MatchedShow["otherArtists"] = [];
    for (const sa of show.artists as ShowArtist[]) {
      const isFeatured =
        sa.artist.popularity != null &&
        sa.artist.popularity >= minPopularity &&
        sa.artist.listenSignals.length === 0;
      if (isFeatured) {
        let genres: string[] = [];
        if (sa.artist.genres) {
          try {
            const parsed = JSON.parse(sa.artist.genres) as unknown;
            if (Array.isArray(parsed)) genres = parsed.filter((g): g is string => typeof g === "string");
          } catch {
            // ignore
          }
        }
        featured.push({
          id: sa.artist.id,
          name: sa.artist.name,
          genres,
          popularity: sa.artist.popularity,
          topSignal: null,
          playlists: sa.artist.playlists.map((ap) => ({
            spotifyId: ap.playlist.spotifyId,
            name: ap.playlist.name,
            url: ap.playlist.url,
          })),
          contacts: sa.artist.contacts.map((c) => ({
            id: c.id,
            email: c.email,
            name: c.name,
            role: c.role,
            customPrice: c.customPrice,
            isFullTeam: c.isFullTeam,
          })),
        });
      } else {
        others.push({ id: sa.artist.id, name: sa.artist.name });
      }
    }
    return {
      id: show.id,
      date: show.date,
      venueName: show.venueName,
      city: show.city,
      state: show.state,
      ticketUrl: show.ticketUrl,
      dismissedAt: show.dismissedAt,
      interestedAt: show.interestedAt,
      matchedArtists: featured,
      otherArtists: others,
      outreach: show.outreaches.map((o) => ({
        contactId: o.contactId,
        sentAt: o.sentAt,
        deliveredAt: o.deliveredAt,
        status: o.status,
        firstClickedAt: o.firstClickedAt,
        clickCount: o.clickCount,
        firstOpenedAt: o.firstOpenedAt,
        openCount: o.openCount,
      })),
    };
  }).filter((s) => s.matchedArtists.length > 0);
}
