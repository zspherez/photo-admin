"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";

interface ArtistData {
  id: string;
  name: string;
  imageUrl: string | null;
  spotifyId: string | null;
  statsfmId: string | null;
  edmtrainId: number | null;
  popularity: number | null;
  genres: string[];
  listenSignals: { source: string; rank: number | null; playCount: number | null; lastSeenAt: string | null }[];
  playlists: { spotifyId: string; name: string; url: string }[];
  contacts: {
    id: string;
    name: string | null;
    email: string;
    role: string | null;
    customPrice: string | null;
    isFullTeam: boolean;
  }[];
  upcomingShows: {
    id: string;
    date: string;
    venueName: string;
    state: string | null;
    city: string;
    eventName: string | null;
    isFestival: boolean;
  }[];
}

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

export function ArtistLink({
  artistId,
  children,
  className,
}: {
  artistId: string;
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className={cn("hover:underline", className)}
      >
        {children}
      </button>
      {open && <ArtistModal artistId={artistId} onClose={() => setOpen(false)} />}
    </>
  );
}

function ArtistModal({ artistId, onClose }: { artistId: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<ArtistData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dlg = dialogRef.current;
    if (dlg && !dlg.open) dlg.showModal();
    let cancelled = false;
    fetch(`/api/artists/${artistId}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.error) setError(d.error);
        else setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [artistId]);

  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    const handleClose = () => onClose();
    dlg.addEventListener("close", handleClose);
    return () => dlg.removeEventListener("close", handleClose);
  }, [onClose]);

  const externalLinks = data ? buildExternalLinks(data) : [];

  return (
    <dialog
      ref={dialogRef}
      onClick={(e) => {
        // Backdrop click closes
        if (e.target === dialogRef.current) dialogRef.current?.close();
      }}
      className="m-auto w-full max-w-2xl rounded-xl border border-zinc-200 bg-white p-0 text-zinc-900 shadow-2xl backdrop:bg-black/40 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
    >
      <div className="flex items-start justify-between gap-2 border-b border-zinc-100 px-5 py-3 dark:border-zinc-900">
        <div className="flex min-w-0 items-center gap-3">
          {data?.imageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={data.imageUrl} alt="" className="h-10 w-10 rounded-md object-cover" />
          )}
          <div className="min-w-0">
            <p className="truncate font-semibold">{data?.name ?? "Loading…"}</p>
            {data && (
              <div className="mt-1 flex flex-wrap items-center gap-1">
                {data.genres.slice(0, 4).map((g) => (
                  <Badge key={g} tone="muted" size="xs">{g}</Badge>
                ))}
              </div>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => dialogRef.current?.close()}
          className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-900 dark:hover:text-zinc-300"
          aria-label="Close"
        >
          ×
        </button>
      </div>

      <div className="max-h-[70vh] space-y-5 overflow-y-auto px-5 py-4">
        {error && (
          <p className="text-sm text-red-700 dark:text-red-400">Error: {error}</p>
        )}
        {!data && !error && (
          <p className="text-sm text-zinc-500">Loading…</p>
        )}
        {data && (
          <>
            <section>
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Open in</h3>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {externalLinks.map((l) => (
                  <a
                    key={l.label}
                    href={l.href}
                    target={l.external ? "_blank" : undefined}
                    rel={l.external ? "noopener noreferrer" : undefined}
                    className="inline-flex items-center rounded-full border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-700 transition hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:border-zinc-700 dark:hover:bg-zinc-900"
                  >
                    {l.label} {l.external ? "↗" : ""}
                  </a>
                ))}
              </div>
            </section>

            {data.listenSignals.length > 0 && (
              <section>
                <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Listen signals</h3>
                <ul className="mt-2 divide-y divide-zinc-100 rounded-md border border-zinc-100 dark:divide-zinc-900 dark:border-zinc-900">
                  {data.listenSignals.map((s, i) => (
                    <li key={`${s.source}-${i}`} className="flex items-center justify-between px-3 py-1.5 text-sm">
                      <span>{formatRankLabel(s.source, s.rank)}</span>
                      <span className="text-xs text-zinc-500">
                        {s.playCount != null && `${s.playCount.toLocaleString()} plays`}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {data.playlists.length > 0 && (
              <section>
                <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  In your playlists ({data.playlists.length})
                </h3>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {data.playlists.map((pl) => (
                    <a
                      key={pl.spotifyId}
                      href={`spotify:playlist:${pl.spotifyId}`}
                      className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900"
                    >
                      ♪ {pl.name}
                    </a>
                  ))}
                </div>
              </section>
            )}

            {data.contacts.length > 0 ? (
              <section>
                <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Contacts</h3>
                <ul className="mt-2 divide-y divide-zinc-100 rounded-md border border-zinc-100 dark:divide-zinc-900 dark:border-zinc-900">
                  {data.contacts.map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
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
                      <div className="flex shrink-0 gap-1">
                        {c.customPrice && <Badge tone="default" size="xs">{c.customPrice}</Badge>}
                        {c.isFullTeam && <Badge tone="accent" size="xs">Full team</Badge>}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ) : (
              <p className="text-xs text-zinc-500">
                No contact yet.{" "}
                <Link href={`/dashboard/add-contact/${data.id}`} className="underline">Add one</Link>.
              </p>
            )}

            {data.upcomingShows.length > 0 && (
              <section>
                <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  Upcoming ({data.upcomingShows.length})
                </h3>
                <ul className="mt-2 divide-y divide-zinc-100 rounded-md border border-zinc-100 dark:divide-zinc-900 dark:border-zinc-900">
                  {data.upcomingShows.map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                      <p className="min-w-0 truncate">
                        <span className="font-medium">{s.eventName || s.venueName}</span>
                        <span className="ml-2 text-xs text-zinc-500">
                          {new Date(s.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                          {" · "}{s.venueName}{s.state ? `, ${s.state}` : ""}
                        </span>
                      </p>
                      {s.isFestival && <Badge tone="accent" size="xs">Festival</Badge>}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <div className="pt-2">
              <Link href={`/artists/${data.id}`} className="text-xs text-zinc-500 hover:underline">
                Open full page →
              </Link>
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}

function buildExternalLinks(d: ArtistData): { label: string; href: string; external?: boolean }[] {
  const links: { label: string; href: string; external?: boolean }[] = [];
  if (d.spotifyId) links.push({ label: "Spotify", href: `spotify:artist:${d.spotifyId}` });
  if (d.statsfmId) links.push({ label: "Stats.fm", href: `https://stats.fm/artist/${d.statsfmId}`, external: true });
  links.push({
    label: "SoundCloud (search)",
    href: `https://soundcloud.com/search/people?q=${encodeURIComponent(d.name)}`,
    external: true,
  });
  if (d.edmtrainId) {
    links.push({
      label: "EDMTrain",
      href: `https://edmtrain.com/${d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      external: true,
    });
  }
  return links;
}
