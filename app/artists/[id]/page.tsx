import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatShowDate } from "@/lib/formatDate";

export const dynamic = "force-dynamic";

function formatRankLabel(source: string, rank: number | null): string {
  const map: Record<string, string> = {
    statsfm_lifetime: "Stats.fm lifetime",
    statsfm_months: "Stats.fm 6mo",
    statsfm_weeks: "Stats.fm 4wk",
    spotify_top_long: "Spotify all-time",
    spotify_top_medium: "Spotify 6mo",
    spotify_top_short: "Spotify 4wk",
    spotify_recent: "Spotify recent",
    spotify_followed: "Spotify follow",
    spotify_playlist: "Spotify playlist",
  };
  const nice = map[source] ?? source;
  return rank ? `${nice} #${rank}` : nice;
}

interface ExternalLink {
  label: string;
  href: string;
  type: "spotify" | "soundcloud" | "statsfm" | "edmtrain";
}

function getExternalLinks(artist: {
  name: string;
  spotifyId: string | null;
  statsfmId: string | null;
  edmtrainId: number | null;
}): ExternalLink[] {
  const links: ExternalLink[] = [];
  if (artist.spotifyId) {
    // spotify: URI opens directly in the desktop app on macOS/Windows;
    // browser falls back to open.spotify.com if app not installed.
    links.push({
      label: "Spotify",
      href: `spotify:artist:${artist.spotifyId}`,
      type: "spotify",
    });
  }
  if (artist.statsfmId) {
    links.push({
      label: "Stats.fm",
      href: `https://stats.fm/artist/${artist.statsfmId}`,
      type: "statsfm",
    });
  }
  // SoundCloud doesn't expose an open API; search-by-name is the practical fallback
  links.push({
    label: "SoundCloud (search)",
    href: `https://soundcloud.com/search/people?q=${encodeURIComponent(artist.name)}`,
    type: "soundcloud",
  });
  if (artist.edmtrainId) {
    links.push({
      label: "EDMTrain",
      href: `https://edmtrain.com/${artist.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      type: "edmtrain",
    });
  }
  return links;
}

export default async function ArtistPage({ params }: { params: Promise<{ id: string }> }) {
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
  if (!artist) return notFound();

  const genres: string[] = (() => {
    try {
      return artist.genres ? (JSON.parse(artist.genres) as string[]).filter((g) => typeof g === "string") : [];
    } catch {
      return [];
    }
  })();

  const links = getExternalLinks(artist);
  const upcomingShows = artist.shows
    .map((sa) => sa.show)
    .filter((s) => s.date >= new Date())
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Link href="/dashboard" className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">← Dashboard</Link>

      <div className="mt-2 flex items-start gap-4">
        {artist.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={artist.imageUrl}
            alt=""
            className="h-16 w-16 rounded-lg object-cover"
          />
        )}
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{artist.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {genres.slice(0, 6).map((g) => (
              <Badge key={g} tone="muted" size="xs">{g}</Badge>
            ))}
            {artist.popularity != null && (
              <Badge tone="default" size="xs">popularity {artist.popularity}</Badge>
            )}
          </div>
        </div>
      </div>

      <section className="mt-6">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">External</h2>
        <div className="mt-2 flex flex-wrap gap-2">
          {links.map((l) => (
            <a
              key={l.label}
              href={l.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center rounded-full border border-zinc-200 px-3 py-1 text-xs font-medium text-zinc-700 transition hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:border-zinc-700 dark:hover:bg-zinc-900"
            >
              {l.label} ↗
            </a>
          ))}
        </div>
      </section>

      {artist.listenSignals.length > 0 && (
        <section className="mt-6">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Listen signals</h2>
          <Card className="mt-2">
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {artist.listenSignals.map((s) => (
                <li key={s.id} className="flex items-center justify-between px-4 py-2 text-sm">
                  <span>{formatRankLabel(s.source, s.rank)}</span>
                  <span className="text-xs text-zinc-500">
                    {s.playCount != null && `${s.playCount.toLocaleString()} plays`}
                    {s.lastSeenAt && ` · ${new Date(s.lastSeenAt).toLocaleDateString()}`}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      {artist.playlists.length > 0 && (
        <section className="mt-6">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            In your playlists ({artist.playlists.length})
          </h2>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {artist.playlists.map((ap) => (
              <a
                key={ap.playlist.spotifyId}
                href={`spotify:playlist:${ap.playlist.spotifyId}`}
                className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200 transition hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900 dark:hover:bg-emerald-950"
              >
                ♪ {ap.playlist.name}
              </a>
            ))}
          </div>
        </section>
      )}

      {artist.contacts.length > 0 && (
        <section className="mt-6">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Contacts</h2>
          <Card className="mt-2">
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {artist.contacts.map((c) => (
                <li key={c.id} className="px-4 py-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate">
                        {c.name && <b>{c.name}</b>}
                        {c.name ? " · " : ""}
                        <Link href={`/dashboard/contact/${c.id}`} className="text-zinc-700 hover:underline dark:text-zinc-300">
                          {c.email}
                        </Link>
                        {c.role && <span className="text-zinc-500"> · {c.role}</span>}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      {c.customPrice && <Badge tone="default" size="xs">{c.customPrice}</Badge>}
                      {c.isFullTeam && <Badge tone="accent" size="xs">Full team</Badge>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      {upcomingShows.length > 0 && (
        <section className="mt-6">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Upcoming shows</h2>
          <Card className="mt-2">
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {upcomingShows.map((s) => (
                <li key={s.id} className="px-4 py-3 text-sm">
                  <Link
                    href={s.isFestival ? `/festivals/${s.id}` : "/dashboard"}
                    className="flex items-center justify-between gap-2 hover:opacity-80"
                  >
                    <div className="min-w-0">
                      <p className="truncate">
                        <span className="font-medium">{s.eventName || s.venueName}</span>
                        <span className="ml-2 text-xs text-zinc-500">
                          {formatShowDate(s.date, { weekday: "short", month: "short", day: "numeric" })}
                          {" · "}{s.venueName}{s.state ? `, ${s.state}` : ""}
                        </span>
                      </p>
                    </div>
                    {s.isFestival && <Badge tone="accent" size="xs">Festival</Badge>}
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      {artist.contacts.length === 0 && (
        <p className="mt-6 text-xs text-zinc-500">
          No contact yet.{" "}
          <Link href={`/dashboard/add-contact/${artist.id}`} className="underline">Add one</Link>.
        </p>
      )}
    </main>
  );
}
