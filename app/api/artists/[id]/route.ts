import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const artist = await db.artist.findUnique({
    where: { id },
    include: {
      listenSignals: { orderBy: { rank: "asc" } },
      contacts: { orderBy: { updatedAt: "desc" } },
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
    .filter((s) => s.date >= new Date())
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
