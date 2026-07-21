import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  addDateOnlyDays,
  easternDateOnly,
  easternTodayStoredDate,
  parseDateOnly,
} from "@/lib/calendarDate";
import {
  activeListenSignalWhere,
  isListenSignalActive,
  pickTopListenSignal,
  type ListenSignalRank,
} from "@/lib/listenSignal";
import {
  canMarkOutreachManually,
  isActiveManualOutreachMarker,
} from "@/lib/manualOutreach";
import {
  DASHBOARD_BATCH_SIZE,
  type DashboardMode,
  type DashboardQuery,
  type MatchFilters,
  type RangeFilter,
  type SourceFilter,
} from "@/lib/dashboardQuery";
import {
  decodeDashboardCursor,
  encodeDashboardCursor,
  verifyDashboardCursor,
} from "@/lib/dashboardCursor";
import {
  DASHBOARD_SNAPSHOT_INSERT_CHUNK_SIZE,
  buildDashboardSnapshotMembers,
  dashboardQueryKey,
  dashboardSnapshotAccessStatus,
  dashboardSnapshotExpiresAt,
} from "@/lib/dashboardSnapshot";

export {
  DASHBOARD_PAGE_SIZE,
  DEFAULT_FILTERS,
  buildDashboardHref,
  firstSearchParam,
  getPagination,
  parseDashboardQuery,
} from "@/lib/dashboardQuery";
export type {
  ContactFilter,
  DashboardMode,
  DashboardPagination,
  DashboardQuery,
  MatchFilters,
  RangeFilter,
  SourceFilter,
  StatusFilter,
} from "@/lib/dashboardQuery";

export const UNKNOWN_BIG_MIN_POPULARITY = 60;

export interface MatchedShow {
  id: string;
  date: Date;
  venueName: string;
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
    playlists: { spotifyId: string; name: string }[];
    playlistCount: number;
    canMarkManually: boolean;
    contacts: {
      id: string;
      email: string | null;
      phone: string | null;
      directOutreachNote: string | null;
      name: string | null;
      customPrice: string | null;
      state: "active" | "quarantined";
      isFullTeam: boolean;
    }[];
  }[];
  otherArtists: { id: string; name: string }[];
  outreach: {
    id: string;
    kind: "original" | "follow_up";
    parentOutreachId: string | null;
    artistId: string;
    contactId: string | null;
    sentAt: Date | null;
    deliveredAt: Date | null;
    status: string;
    scheduledFor: Date | null;
    nextAttemptAt: Date | null;
    clickCount: number;
    openCount: number;
    isManualMarker: boolean;
  }[];
}

export interface DashboardData {
  shows: MatchedShow[];
  modeCounts: Record<DashboardMode, number>;
  resultCount: number;
  nextCursor: string | null;
  snapshotId: string;
  snapshotAt: Date;
  totalUpcoming: number;
  totalSignals: number;
}

export interface DashboardBatch {
  shows: MatchedShow[];
  nextCursor: string | null;
  snapshotId: string;
  snapshotAt: Date;
}

export type DashboardNextBatchResult =
  | { status: "ok"; batch: DashboardBatch }
  | { status: "invalid" | "expired" };

export function getDashboardDateRange(
  range: RangeFilter,
  now: Date = new Date()
): { start: Date; end: Date } {
  const today = easternDateOnly(now);
  const startOffset = range === "30-60d" ? 30 : 0;
  const endOffset =
    range === "7d" ? 7 : range === "30d" ? 30 : range === "30-60d" ? 60 : 90;
  return {
    start: parseDateOnly(addDateOnlyDays(today, startOffset)),
    end: parseDateOnly(addDateOnlyDays(today, endOffset)),
  };
}

export function isDashboardArtistMatch(
  artist: {
    popularity: number | null;
    listenSignals: readonly ListenSignalRank[];
  },
  mode: DashboardMode,
  now: Date = new Date(),
  minPopularity: number = UNKNOWN_BIG_MIN_POPULARITY,
  source: SourceFilter = "any"
): boolean {
  const hasActiveSignal = artist.listenSignals.some((signal) =>
    isListenSignalActive(signal, now)
  );
  const prefix = sourcePrefix(source);
  const hasSourceSignal = artist.listenSignals.some(
    (signal) =>
      isListenSignalActive(signal, now) &&
      (prefix === null || signal.source.startsWith(prefix))
  );
  const isUnknown =
    artist.popularity != null &&
    artist.popularity >= minPopularity &&
    !hasActiveSignal;

  if (mode === "unknown") return isUnknown;
  if (mode === "matched") return hasSourceSignal;
  return hasSourceSignal || isUnknown;
}

function sourcePrefix(source: SourceFilter): string | null {
  return source === "statsfm" ? "statsfm_" : source === "spotify" ? "spotify_" : null;
}

function matchingArtistWhere(
  source: SourceFilter,
  mode: DashboardMode,
  now: Date
): Prisma.ArtistWhereInput {
  const matched: Prisma.ArtistWhereInput = {
    listenSignals: {
      some: activeListenSignalWhere(now, sourcePrefix(source)),
    },
  };
  const unknown: Prisma.ArtistWhereInput = {
    popularity: { gte: UNKNOWN_BIG_MIN_POPULARITY },
    listenSignals: { none: activeListenSignalWhere(now) },
  };

  if (mode === "matched") return matched;
  if (mode === "unknown") return unknown;
  return { OR: [matched, unknown] };
}

function dashboardShowWhere(
  mode: DashboardMode,
  filters: MatchFilters,
  now: Date
): Prisma.ShowWhereInput {
  const artist = matchingArtistWhere(filters.source, mode, now);
  const dates = getDashboardDateRange(filters.range, now);
  const artistFilters: Prisma.ArtistWhereInput[] = [artist];
  if (filters.search) {
    artistFilters.push({
      name: {
        contains: filters.search,
        mode: "insensitive",
      },
    });
  }
  if (filters.contact !== "any") {
    artistFilters.push({
      contacts:
        filters.contact === "has"
          ? { some: { state: "active" } }
          : { none: { state: "active" } },
    });
  }

  const where: Prisma.ShowWhereInput = {
    date: { gte: dates.start, lte: dates.end },
    isFestival: false,
    syncStatus: "active",
    dismissedAt: mode === "dismissed" ? { not: null } : null,
    ...(mode === "interested" ? { interestedAt: { not: null } } : {}),
    artists: {
      some: {
        artist: {
          AND: artistFilters,
        },
      },
    },
  };

  if (filters.status === "sent") {
    where.outreaches = {
      some: {
        kind: "original",
        status: { in: ["sent", "scheduled", "retry_scheduled"] },
      },
    };
  } else if (filters.status === "unsent") {
    where.outreaches = {
      none: {
        kind: "original",
        status: { in: ["sent", "scheduled", "retry_scheduled"] },
      },
    };
  } else if (filters.status === "opened") {
    where.outreaches = {
      some: { kind: "original", openCount: { gt: 0 } },
    };
  } else if (filters.status === "clicked") {
    where.outreaches = {
      some: { kind: "original", clickCount: { gt: 0 } },
    };
  }
  return where;
}

function dashboardShowSelect(
  now: Date
) {
  return {
    id: true,
    date: true,
    venueName: true,
    state: true,
    ticketUrl: true,
    dismissedAt: true,
    interestedAt: true,
    artists: {
      orderBy: [{ artist: { name: "asc" } }, { artistId: "asc" }],
      select: {
        artist: {
          select: {
            id: true,
            name: true,
            genres: true,
            popularity: true,
            listenSignals: {
              where: activeListenSignalWhere(now),
              select: {
                source: true,
                rank: true,
                expiresAt: true,
              },
            },
          },
        },
      },
    },
    outreaches: {
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      select: {
        id: true,
        kind: true,
        parentOutreachId: true,
        artistId: true,
        contactId: true,
        sentAt: true,
        deliveredAt: true,
        status: true,
        scheduledFor: true,
        nextAttemptAt: true,
        clickCount: true,
        openCount: true,
        providerMessageId: true,
        attemptCount: true,
        finalSubject: true,
        finalHtml: true,
        _count: { select: { sendAttempts: true } },
      },
    },
  } satisfies Prisma.ShowSelect;
}

const CONTACT_SELECT = {
  artistId: true,
  id: true,
  email: true,
  phone: true,
  directOutreachNote: true,
  name: true,
  customPrice: true,
  state: true,
  isFullTeam: true,
} satisfies Prisma.ContactSelect;

const PLAYLIST_SELECT = {
  artistId: true,
  playlist: {
    select: {
      spotifyId: true,
      name: true,
    },
  },
} satisfies Prisma.ArtistPlaylistSelect;

type DashboardShowRow = Prisma.ShowGetPayload<{
  select: ReturnType<typeof dashboardShowSelect>;
}>;
type DashboardContactRow = Prisma.ContactGetPayload<{ select: typeof CONTACT_SELECT }>;
type DashboardPlaylistRow = Prisma.ArtistPlaylistGetPayload<{
  select: typeof PLAYLIST_SELECT;
}>;

function countShows(where: Prisma.ShowWhereInput): Promise<number> {
  return db.show.count({ where });
}

function parseGenres(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((genre): genre is string => typeof genre === "string").slice(0, 2)
      : [];
  } catch {
    return [];
  }
}

async function hydrateDashboardShowRows(
  showRows: DashboardShowRow[],
  query: DashboardQuery,
  now: Date
): Promise<MatchedShow[]> {
  const featuredArtistIds = new Set<string>();
  for (const show of showRows) {
    for (const showArtist of show.artists) {
      if (
        isDashboardArtistMatch(
          showArtist.artist,
          query.mode,
          now,
          UNKNOWN_BIG_MIN_POPULARITY,
          query.filters.source
        )
      ) {
        featuredArtistIds.add(showArtist.artist.id);
      }
    }
  }
  const artistIds = [...featuredArtistIds];
  const contactsPromise: Promise<DashboardContactRow[]> =
    artistIds.length === 0
      ? Promise.resolve([])
      : db.contact.findMany({
          where: { artistId: { in: artistIds }, state: "active" },
          orderBy: [{ artistId: "asc" }, { updatedAt: "desc" }, { id: "asc" }],
          select: CONTACT_SELECT,
        });
  const playlistsPromise: Promise<DashboardPlaylistRow[]> =
    artistIds.length === 0
      ? Promise.resolve([])
      : db.artistPlaylist.findMany({
          where: { artistId: { in: artistIds } },
          orderBy: [{ artistId: "asc" }, { playlist: { name: "asc" } }],
          select: PLAYLIST_SELECT,
        });
  const [contacts, playlistRows] = await Promise.all([
    contactsPromise,
    playlistsPromise,
  ]);

  const contactsByArtist = new Map<
    string,
    MatchedShow["matchedArtists"][number]["contacts"]
  >();
  for (const contact of contacts) {
    const rows = contactsByArtist.get(contact.artistId) ?? [];
    rows.push({
      id: contact.id,
      email: contact.email,
      phone: contact.phone,
      directOutreachNote: contact.directOutreachNote,
      name: contact.name,
      customPrice: contact.customPrice,
      state: contact.state,
      isFullTeam: contact.isFullTeam,
    });
    contactsByArtist.set(contact.artistId, rows);
  }

  const playlistsByArtist = new Map<
    string,
    MatchedShow["matchedArtists"][number]["playlists"]
  >();
  for (const row of playlistRows) {
    const rows = playlistsByArtist.get(row.artistId) ?? [];
    rows.push({
      spotifyId: row.playlist.spotifyId,
      name: row.playlist.name,
    });
    playlistsByArtist.set(row.artistId, rows);
  }

  return showRows.map((show): MatchedShow => {
    const matchedArtists: MatchedShow["matchedArtists"] = [];
    const otherArtists: MatchedShow["otherArtists"] = [];

    for (const showArtist of show.artists) {
      const artist = showArtist.artist;
      if (
        !isDashboardArtistMatch(
          artist,
          query.mode,
          now,
          UNKNOWN_BIG_MIN_POPULARITY,
          query.filters.source
        )
      ) {
        otherArtists.push({ id: artist.id, name: artist.name });
        continue;
      }

      const prefix = sourcePrefix(query.filters.source);
      const topSignal = pickTopListenSignal(
        artist.listenSignals.filter(
          (signal) => prefix === null || signal.source.startsWith(prefix)
        ),
        now
      );
      const playlists = playlistsByArtist.get(artist.id) ?? [];
      const artistOutreaches = show.outreaches.filter(
        (outreach) =>
          outreach.artistId === artist.id && outreach.kind === "original"
      );
      matchedArtists.push({
        id: artist.id,
        name: artist.name,
        genres: parseGenres(artist.genres),
        popularity: artist.popularity,
        topSignal: topSignal
          ? { source: topSignal.source, rank: topSignal.rank }
          : null,
        playlists: playlists.slice(0, 3),
        playlistCount: playlists.length,
        canMarkManually: canMarkOutreachManually(
          artistOutreaches.map((outreach) => ({
            status: outreach.status,
            providerMessageId: outreach.providerMessageId,
            attemptCount: outreach.attemptCount,
            sendAttemptCount: outreach._count.sendAttempts,
          }))
        ),
        contacts: contactsByArtist.get(artist.id) ?? [],
      });
    }

    return {
      id: show.id,
      date: show.date,
      venueName: show.venueName,
      state: show.state,
      ticketUrl: show.ticketUrl,
      dismissedAt: show.dismissedAt,
      interestedAt: show.interestedAt,
      matchedArtists,
      otherArtists,
      outreach: show.outreaches.map((outreach) => ({
        id: outreach.id,
        kind: outreach.kind,
        parentOutreachId: outreach.parentOutreachId,
        artistId: outreach.artistId,
        contactId: outreach.contactId,
        sentAt: outreach.sentAt,
        deliveredAt: outreach.deliveredAt,
        status: outreach.status,
        scheduledFor: outreach.scheduledFor,
        nextAttemptAt: outreach.nextAttemptAt,
        clickCount: outreach.clickCount,
        openCount: outreach.openCount,
        isManualMarker: isActiveManualOutreachMarker({
          id: outreach.id,
          kind: outreach.kind,
          showId: show.id,
          artistId: outreach.artistId,
          status: outreach.status,
          providerMessageId: outreach.providerMessageId,
          attemptCount: outreach.attemptCount,
          sendAttemptCount: outreach._count.sendAttempts,
          finalSubject: outreach.finalSubject,
          finalHtml: outreach.finalHtml,
        }),
      })),
    };
  });
}

async function cleanupExpiredDashboardSnapshots(now: Date): Promise<void> {
  await db.dashboardShowSnapshot.deleteMany({
    where: { expiresAt: { lte: now } },
  });
}

async function createDashboardSnapshot(
  query: DashboardQuery,
  ownerKey: string,
  snapshotAt: Date
): Promise<{
  id: string;
  total: number;
  createdAt: Date;
  expiresAt: Date;
}> {
  await cleanupExpiredDashboardSnapshots(snapshotAt);
  const queryKey = dashboardQueryKey(query);
  const expiresAt = dashboardSnapshotExpiresAt(snapshotAt);

  return db.$transaction(
    async (transaction) => {
      const orderedShows = await transaction.show.findMany({
        where: dashboardShowWhere(query.mode, query.filters, snapshotAt),
        orderBy: [{ date: "asc" }, { id: "asc" }],
        select: { id: true, date: true },
      });
      const snapshot = await transaction.dashboardShowSnapshot.create({
        data: {
          ownerKey,
          queryKey,
          total: orderedShows.length,
          expiresAt,
          createdAt: snapshotAt,
        },
        select: {
          id: true,
          total: true,
          createdAt: true,
          expiresAt: true,
        },
      });
      const members = buildDashboardSnapshotMembers(orderedShows);
      for (
        let start = 0;
        start < members.length;
        start += DASHBOARD_SNAPSHOT_INSERT_CHUNK_SIZE
      ) {
        await transaction.dashboardShowSnapshotMember.createMany({
          data: members
            .slice(start, start + DASHBOARD_SNAPSHOT_INSERT_CHUNK_SIZE)
            .map((member) => ({
              snapshotId: snapshot.id,
              ...member,
            })),
        });
      }
      return snapshot;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
  );
}

async function loadDashboardSnapshotBatch(
  query: DashboardQuery,
  snapshot: {
    id: string;
    total: number;
    createdAt: Date;
  },
  afterPosition: number,
  ownerKey: string
): Promise<DashboardBatch> {
  const members = await db.dashboardShowSnapshotMember.findMany({
    where: {
      snapshotId: snapshot.id,
      position: { gt: afterPosition },
    },
    orderBy: { position: "asc" },
    take: DASHBOARD_BATCH_SIZE + 1,
    select: {
      position: true,
      sortDate: true,
      show: { select: dashboardShowSelect(snapshot.createdAt) },
    },
  });
  const hasMore = members.length > DASHBOARD_BATCH_SIZE;
  const pageMembers = members.slice(0, DASHBOARD_BATCH_SIZE);
  const shows = await hydrateDashboardShowRows(
    pageMembers.map((member) => ({
      ...member.show,
      date: member.sortDate,
    })),
    query,
    snapshot.createdAt
  );
  const last = pageMembers.at(-1);
  return {
    shows,
    nextCursor:
      hasMore && last
        ? encodeDashboardCursor(
            { snapshotId: snapshot.id, position: last.position },
            query,
            ownerKey
          )
        : null,
    snapshotId: snapshot.id,
    snapshotAt: snapshot.createdAt,
  };
}

export async function getDashboardNextBatch(
  query: DashboardQuery,
  cursorValue: unknown,
  ownerKey: string,
  requestNow: Date = new Date()
): Promise<DashboardNextBatchResult> {
  const cursor = decodeDashboardCursor(cursorValue, query);
  if (!cursor) return { status: "invalid" };
  if (!verifyDashboardCursor(cursor, query, ownerKey)) {
    return { status: "invalid" };
  }
  const snapshot = await db.dashboardShowSnapshot.findUnique({
    where: { id: cursor.snapshotId },
    select: {
      id: true,
      ownerKey: true,
      queryKey: true,
      total: true,
      expiresAt: true,
      createdAt: true,
    },
  });
  const accessStatus = dashboardSnapshotAccessStatus(
    snapshot,
    query,
    ownerKey,
    cursor.position,
    requestNow
  );
  if (accessStatus === "invalid") {
    return { status: "invalid" };
  }
  if (accessStatus === "expired") {
    if (!snapshot) return { status: "expired" };
    await db.dashboardShowSnapshot.deleteMany({
      where: { id: snapshot.id, ownerKey },
    });
    return { status: "expired" };
  }
  if (!snapshot) return { status: "expired" };
  return {
    status: "ok",
    batch: await loadDashboardSnapshotBatch(
      query,
      snapshot,
      cursor.position,
      ownerKey
    ),
  };
}

export async function getDashboardData(
  query: DashboardQuery,
  ownerKey: string,
  now: Date = new Date()
): Promise<DashboardData> {
  const [
    snapshot,
    matchedCount,
    unknownCount,
    interestedCount,
    dismissedCount,
    totalUpcoming,
    totalSignals,
  ] = await Promise.all([
    createDashboardSnapshot(query, ownerKey, now),
    countShows(dashboardShowWhere("matched", query.filters, now)),
    countShows(dashboardShowWhere("unknown", query.filters, now)),
    countShows(dashboardShowWhere("interested", query.filters, now)),
    countShows(dashboardShowWhere("dismissed", query.filters, now)),
    db.show.count({
      where: {
        date: { gte: easternTodayStoredDate(now) },
        isFestival: false,
        syncStatus: "active",
      },
    }),
    db.listenSignal.count({ where: activeListenSignalWhere(now) }),
  ]);

  const modeCounts: Record<DashboardMode, number> = {
    matched: matchedCount,
    unknown: unknownCount,
    interested: interestedCount,
    dismissed: dismissedCount,
  };
  modeCounts[query.mode] = snapshot.total;
  const batch = await loadDashboardSnapshotBatch(
    query,
    snapshot,
    -1,
    ownerKey
  );

  return {
    shows: batch.shows,
    modeCounts,
    resultCount: snapshot.total,
    nextCursor: batch.nextCursor,
    snapshotId: batch.snapshotId,
    snapshotAt: batch.snapshotAt,
    totalUpcoming,
    totalSignals,
  };
}
