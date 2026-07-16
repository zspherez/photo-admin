import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/lib/db";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  activeListenSignalWhere,
  formatRankLabel,
} from "@/lib/listenSignal";
import {
  addDateOnlyDays,
  easternDateOnly,
  easternTodayStoredDate,
  parseDateOnly,
} from "@/lib/calendarDate";
import { formatShowDate } from "@/lib/formatDate";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Demo" };

interface DemoArtist {
  id: string;
  name: string;
  genres: string[];
  popularity: number | null;
  topSignal: { source: string; rank: number | null } | null;
  playlists: { spotifyId: string; name: string }[];
}

interface DemoShow {
  id: string;
  date: Date;
  venueName: string;
  city: string;
  state: string | null;
  ticketUrl: string | null;
  matchedArtists: DemoArtist[];
  otherArtists: { id: string; name: string }[];
}

async function getDemoShows(): Promise<DemoShow[]> {
  const now = new Date();
  const end = parseDateOnly(addDateOnlyDays(easternDateOnly(now), 60));
  const shows = await db.show.findMany({
    where: {
      date: { gte: easternTodayStoredDate(now), lte: end },
      isFestival: false,
      syncStatus: "active",
      dismissedAt: null,
      artists: {
        some: {
          artist: {
            listenSignals: { some: activeListenSignalWhere(now) },
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
              listenSignals: {
                where: activeListenSignalWhere(now),
                orderBy: { rank: "asc" },
              },
              playlists: { include: { playlist: true } },
            },
          },
        },
      },
    },
    take: 80,
  });

  return shows
    .map((show): DemoShow => {
      const matched: DemoArtist[] = [];
      const others: { id: string; name: string }[] = [];
      for (const sa of show.artists) {
        if (sa.artist.listenSignals.length > 0) {
          let genres: string[] = [];
          if (sa.artist.genres) {
            try {
              const parsed = JSON.parse(sa.artist.genres) as unknown;
              if (Array.isArray(parsed)) {
                genres = parsed.filter((g): g is string => typeof g === "string");
              }
            } catch {
              // ignore malformed
            }
          }
          const top = sa.artist.listenSignals[0];
          matched.push({
            id: sa.artist.id,
            name: sa.artist.name,
            genres,
            popularity: sa.artist.popularity,
            topSignal: top ? { source: top.source, rank: top.rank } : null,
            playlists: sa.artist.playlists.map((ap) => ({
              spotifyId: ap.playlist.spotifyId,
              name: ap.playlist.name,
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
        matchedArtists: matched,
        otherArtists: others,
      };
    })
    .filter((s) => s.matchedArtists.length > 0);
}

export default async function TestPage() {
  const shows = await getDemoShows();
  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header className="border-b border-zinc-200 pb-5 dark:border-zinc-800">
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="" className="h-8 w-auto dark:brightness-200" />
          <h1 className="text-2xl font-semibold tracking-tight">Rehders Photos Admin — demo</h1>
          <Badge tone="muted" size="xs">read-only</Badge>
        </div>
        <p className="mt-2 text-sm text-zinc-500">
          Live preview of the matched-shows view. Real upcoming concerts pulled from EDMTrain, scored
          against my own listening history (Stats.fm + Spotify). Contacts and send actions are hidden
          here — this is just the matching layer.
        </p>
      </header>

      {shows.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-zinc-300 p-12 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No upcoming matched shows in the next 60 days.
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {shows.map((show) => {
            return (
              <Card key={show.id} className="p-5">
                <p className="text-sm text-zinc-500">
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">
                    {formatShowDate(show.date, {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </span>
                  {" · "}
                  {show.venueName}
                  {show.state ? `, ${show.state}` : ""}
                  {show.ticketUrl && (
                    <>
                      {" · "}
                      <a
                        href={show.ticketUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-zinc-700 hover:underline dark:text-zinc-300"
                      >
                        EDMTrain ↗
                      </a>
                    </>
                  )}
                </p>
                <div className="mt-3 space-y-2">
                  {show.matchedArtists.map((a) => (
                    <div
                      key={a.id}
                      className="flex flex-wrap items-center gap-1.5 rounded-lg border border-zinc-100 bg-zinc-50/50 px-3 py-2 dark:border-zinc-900 dark:bg-zinc-900/40"
                    >
                      <span className="text-sm font-medium">{a.name}</span>
                      {a.topSignal && (
                        <Badge tone="success">
                          {formatRankLabel(a.topSignal.source, a.topSignal.rank)}
                        </Badge>
                      )}
                      {!a.topSignal && a.popularity != null && (
                        <Badge tone="info" title="Spotify popularity (0-100)">
                          Popularity {a.popularity}
                        </Badge>
                      )}
                      {a.playlists.slice(0, 3).map((pl) => (
                        <a
                          key={pl.spotifyId}
                          href={`https://open.spotify.com/playlist/${pl.spotifyId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={`Open "${pl.name}" on Spotify`}
                          className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200 transition hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900 dark:hover:bg-emerald-950"
                        >
                          ♪ {pl.name}
                        </a>
                      ))}
                      {a.playlists.length > 3 && (
                        <span className="text-[10px] text-zinc-500">
                          +{a.playlists.length - 3} more
                        </span>
                      )}
                      {a.genres.slice(0, 2).map((g) => (
                        <Badge key={g} tone="muted" size="xs">
                          {g}
                        </Badge>
                      ))}
                    </div>
                  ))}
                </div>
                {show.otherArtists.length > 0 && (
                  <p className="mt-3 truncate text-xs text-zinc-400">
                    + {show.otherArtists.map((a) => a.name).join(", ")}
                  </p>
                )}
              </Card>
            );
          })}
        </div>
      )}

      <p className="mt-10 text-center text-xs text-zinc-400">
        <Link href="https://github.com/zspherez/photo-admin" className="hover:underline">
          github.com/zspherez/photo-admin
        </Link>
      </p>
    </main>
  );
}
