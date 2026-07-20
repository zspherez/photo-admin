import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { easternTodayStoredDate } from "@/lib/calendarDate";
import { activeListenSignalWhere } from "@/lib/listenSignal";
import { satisfiesFestivalLeadTime } from "@/lib/festivalEligibility";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const now = new Date();
  const today = easternTodayStoredDate(now);
  const artist = await db.artist.findUnique({
    where: { id },
    include: {
      listenSignals: {
        where: activeListenSignalWhere(now),
        orderBy: { rank: "asc" },
      },
      contacts: {
        where: { state: "active" },
        orderBy: { updatedAt: "desc" },
      },
      playlists: { include: { playlist: true } },
      shows: {
        include: { show: true },
        orderBy: { show: { date: "asc" } },
      },
    },
  });
  if (!artist) return NextResponse.json({ error: "not found" }, { status: 404 });

  const genres: string[] = (() => {
    try {
      return artist.genres
        ? (JSON.parse(artist.genres) as string[]).filter((g) => typeof g === "string")
        : [];
    } catch {
      return [];
    }
  })();

  const upcoming = artist.shows
    .map((sa) => sa.show)
    .filter(
      (s) =>
        s.date >= today &&
        s.syncStatus === "active" &&
        satisfiesFestivalLeadTime(s, now)
    )
    .slice(0, 20);

  return NextResponse.json({
    id: artist.id,
    name: artist.name,
    imageUrl: artist.imageUrl,
    spotifyId: artist.spotifyId,
    statsfmId: artist.statsfmId,
    edmtrainId: artist.edmtrainId,
    popularity: artist.popularity,
    genres,
    listenSignals: artist.listenSignals.map((s) => ({
      source: s.source,
      rank: s.rank,
      playCount: s.playCount,
      lastSeenAt: s.lastSeenAt,
    })),
    playlists: artist.playlists.map((ap) => ({
      spotifyId: ap.playlist.spotifyId,
      name: ap.playlist.name,
      url: ap.playlist.url,
    })),
    contacts: artist.contacts.map((c) => ({
      id: c.id,
      name: c.name,
      email: c.email,
      phone: c.phone,
      directOutreachNote: c.directOutreachNote,
      role: c.role,
      customPrice: c.customPrice,
      isFullTeam: c.isFullTeam,
    })),
    upcomingShows: upcoming.map((s) => ({
      id: s.id,
      date: s.date,
      venueName: s.venueName,
      state: s.state,
      city: s.city,
      eventName: s.eventName,
      isFestival: s.isFestival,
    })),
  });
}
