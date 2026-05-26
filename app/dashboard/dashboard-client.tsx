"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useDeferredValue, useMemo, useState, useTransition } from "react";
import type { MatchedShow } from "@/lib/match";
import {
  DEFAULT_FILTERS,
  type ContactFilter,
  type MatchFilters,
  type RangeFilter,
  type SourceFilter,
  type StatusFilter,
} from "@/lib/match";
import { Card } from "@/components/ui/card";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button, LinkButton } from "@/components/ui/button";
import { ArtistLink } from "@/components/artist-modal";
import { SendButton } from "@/components/send-button";
import { cn } from "@/lib/cn";
import { formatShowDate } from "@/lib/formatDate";
import {
  sendNowAction,
  dismissShowAction,
  restoreShowAction,
  toggleInterestedAction,
  markSentAction,
  unmarkSentAction,
} from "./actions";

interface Props {
  shows: MatchedShow[];
  unknownBig: MatchedShow[];
  totalUpcoming: number;
  totalSignals: number;
}

type Mode = "matched" | "unknown" | "interested" | "dismissed";

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
  const niceSource = map[source] ?? source;
  return rank ? `${niceSource} #${rank}` : niceSource;
}

interface OutreachState {
  status: string;
  sentAt: Date | string | null;
  deliveredAt: Date | string | null;
  openCount: number;
  clickCount: number;
}

function statusLabels(o: OutreachState): string[] {
  if (o.status === "failed") return ["Failed"];
  if (o.status === "queued") return ["Queued"];
  const labels: string[] = [];
  if (o.status === "test") labels.push("Test sent");
  else if (o.sentAt) labels.push("Sent");
  if (o.deliveredAt) labels.push("Delivered");
  if (o.openCount > 0) labels.push(o.openCount > 1 ? `Opened (${o.openCount})` : "Opened");
  if (o.clickCount > 0) labels.push(o.clickCount > 1 ? `Clicked (${o.clickCount})` : "Clicked");
  return labels.length > 0 ? labels : [o.status];
}

function statusTone(o: OutreachState): BadgeTone {
  if (o.status === "failed") return "danger";
  if (o.clickCount > 0) return "info";
  if (o.openCount > 0) return "info";
  if (o.deliveredAt) return "success";
  if (o.status === "test") return "warning";
  return "default";
}

function parseSearchParams(sp: URLSearchParams): MatchFilters {
  const r = sp.get("range") as RangeFilter | null;
  const s = sp.get("src") as SourceFilter | null;
  const c = sp.get("contact") as ContactFilter | null;
  const st = sp.get("status") as StatusFilter | null;
  return {
    range: r === "7d" || r === "30d" || r === "30-60d" || r === "90d" ? r : DEFAULT_FILTERS.range,
    source: s === "statsfm" || s === "spotify" || s === "any" ? s : DEFAULT_FILTERS.source,
    contact: c === "has" || c === "needs" || c === "any" ? c : DEFAULT_FILTERS.contact,
    status:
      st === "unsent" || st === "sent" || st === "opened" || st === "clicked" || st === "any"
        ? st
        : DEFAULT_FILTERS.status,
    search: (sp.get("search") ?? "").trim(),
  };
}

function buildQueryString(filters: MatchFilters): string {
  const sp = new URLSearchParams();
  if (filters.range !== DEFAULT_FILTERS.range) sp.set("range", filters.range);
  if (filters.source !== DEFAULT_FILTERS.source) sp.set("src", filters.source);
  if (filters.contact !== DEFAULT_FILTERS.contact) sp.set("contact", filters.contact);
  if (filters.status !== DEFAULT_FILTERS.status) sp.set("status", filters.status);
  if (filters.search) sp.set("search", filters.search);
  return sp.toString();
}

function dateInRange(date: Date | string, range: RangeFilter): boolean {
  const d = typeof date === "string" ? new Date(date) : date;
  const now = Date.now();
  const start = range === "30-60d" ? now + 30 * 86400_000 : now;
  const days = range === "7d" ? 7 : range === "30d" ? 30 : range === "30-60d" ? 60 : 90;
  const end = now + days * 86400_000;
  return d.getTime() >= start && d.getTime() <= end;
}

export function DashboardClient({ shows, unknownBig, totalUpcoming, totalSignals }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const initial = parseSearchParams(new URLSearchParams(searchParams?.toString() ?? ""));
  const [filters, setFilters] = useState<MatchFilters>(initial);
  const deferredFilters = useDeferredValue(filters);

  const update = (patch: Partial<MatchFilters>) => {
    const next = { ...filters, ...patch };
    setFilters(next);
    const qs = buildQueryString(next);
    startTransition(() => {
      router.replace(qs ? `/dashboard?${qs}` : "/dashboard", { scroll: false });
    });
  };

  const [mode, setMode] = useState<Mode>("matched");

  const sourceList: MatchedShow[] = mode === "unknown" ? unknownBig : shows;

  const filtered = useMemo(() => {
    const f = deferredFilters;
    const sourcePrefix =
      f.source === "statsfm" ? "statsfm_" : f.source === "spotify" ? "spotify_" : null;
    const search = f.search.toLowerCase();

    return sourceList.filter((show) => {
      if (mode === "dismissed") {
        if (!show.dismissedAt) return false;
      } else {
        if (show.dismissedAt) return false;
      }
      if (mode === "interested" && !show.interestedAt) return false;
      if (!dateInRange(show.date, f.range)) return false;

      const matchedArtists = sourcePrefix
        ? show.matchedArtists.filter((a) =>
            a.topSignal ? a.topSignal.source.startsWith(sourcePrefix) : false
          )
        : show.matchedArtists;
      if (matchedArtists.length === 0) return false;

      if (search) {
        const hit = matchedArtists.some((a) => a.name.toLowerCase().includes(search));
        if (!hit) return false;
      }

      if (f.contact === "has" && !matchedArtists.some((a) => a.contacts.length > 0)) return false;
      if (f.contact === "needs" && !matchedArtists.some((a) => a.contacts.length === 0)) return false;

      if (f.status !== "any") {
        const anySent = show.outreach.some((o) => o.status === "sent");
        const anyOpened = show.outreach.some((o) => o.openCount > 0);
        const anyClicked = show.outreach.some((o) => o.clickCount > 0);
        if (f.status === "sent" && !anySent) return false;
        if (f.status === "unsent" && anySent) return false;
        if (f.status === "opened" && !anyOpened) return false;
        if (f.status === "clicked" && !anyClicked) return false;
      }
      return true;
    });
  }, [sourceList, deferredFilters, mode]);

  const dismissedCount = shows.filter((s) => !!s.dismissedAt).length;
  const interestedCount = shows.filter((s) => !!s.interestedAt && !s.dismissedAt).length;
  const matchedCount = shows.filter((s) => !s.dismissedAt).length;
  const unknownCount = unknownBig.length;

  const filtersDirty =
    filters.search ||
    filters.range !== DEFAULT_FILTERS.range ||
    filters.source !== DEFAULT_FILTERS.source ||
    filters.contact !== DEFAULT_FILTERS.contact ||
    filters.status !== DEFAULT_FILTERS.status;

  const filterGroups: { label: string; options: { key: keyof MatchFilters; value: string; label: string }[] }[] = [
    {
      label: "Range",
      options: [
        { key: "range", value: "7d", label: "7d" },
        { key: "range", value: "30d", label: "30d" },
        { key: "range", value: "30-60d", label: "30–60d" },
        { key: "range", value: "90d", label: "90d" },
      ],
    },
    {
      label: "Source",
      options: [
        { key: "source", value: "any", label: "Any" },
        { key: "source", value: "statsfm", label: "Stats.fm" },
        { key: "source", value: "spotify", label: "Spotify" },
      ],
    },
    {
      label: "Contact",
      options: [
        { key: "contact", value: "any", label: "Any" },
        { key: "contact", value: "has", label: "Has contact" },
        { key: "contact", value: "needs", label: "Needs contact" },
      ],
    },
    {
      label: "Status",
      options: [
        { key: "status", value: "any", label: "Any" },
        { key: "status", value: "unsent", label: "Unsent" },
        { key: "status", value: "sent", label: "Sent" },
        { key: "status", value: "opened", label: "Opened" },
        { key: "status", value: "clicked", label: "Clicked" },
      ],
    },
  ];

  const tabs: { key: Mode; label: string; count: number; tone?: string }[] = [
    { key: "matched", label: "Matched", count: matchedCount },
    { key: "unknown", label: "Unknown but big", count: unknownCount },
    { key: "interested", label: "★ Interested", count: interestedCount, tone: "amber" },
    { key: "dismissed", label: "Dismissed", count: dismissedCount },
  ];

  return (
    <>
      <div className="mt-1 text-sm text-zinc-500">
        {totalUpcoming} total upcoming · {totalSignals.toLocaleString()} listen signals
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-1 border-b border-zinc-200 dark:border-zinc-800">
        {tabs.map((t) => {
          const active = mode === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setMode(t.key)}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition",
                active
                  ? t.tone === "amber"
                    ? "border-amber-500 text-amber-700 dark:text-amber-400"
                    : "border-zinc-900 text-zinc-900 dark:border-zinc-100 dark:text-zinc-100"
                  : "border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
              )}
            >
              {t.label}
              {t.count > 0 && (
                <span className="ml-1.5 text-xs text-zinc-400">{t.count}</span>
              )}
            </button>
          );
        })}
      </div>

      <Card className="mt-6 p-4">
        <div className="flex gap-2">
          <input
            type="text"
            value={filters.search}
            onChange={(e) => update({ search: e.target.value })}
            placeholder="Search artist name…"
            className="h-9 flex-1 rounded-md border border-zinc-200 bg-white px-3 text-sm placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
          />
          {filtersDirty && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setFilters(DEFAULT_FILTERS);
                startTransition(() => router.replace("/dashboard", { scroll: false }));
              }}
            >
              Clear
            </Button>
          )}
        </div>
        <div className="mt-3 space-y-2">
          {filterGroups.map((group) => (
            <div key={group.label} className="flex flex-wrap items-center gap-1.5">
              <span className="w-16 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{group.label}</span>
              {group.options.map((opt) => {
                const active = filters[opt.key] === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => update({ [opt.key]: opt.value } as Partial<MatchFilters>)}
                    className={cn(
                      "rounded-full px-2.5 py-0.5 text-xs font-medium transition",
                      active
                        ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                        : "border border-zinc-200 text-zinc-600 hover:border-zinc-300 hover:text-zinc-900 dark:border-zinc-800 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-zinc-100"
                    )}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </Card>

      {filtered.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-zinc-300 p-12 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No matched shows for this filter. Try widening the range or clearing the search.
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {filtered.map((show: MatchedShow) => {
            const date = typeof show.date === "string" ? new Date(show.date) : show.date;
            return (
              <Card key={show.id} className="p-5">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm text-zinc-500">
                    <span className="font-medium text-zinc-900 dark:text-zinc-100">
                      {formatShowDate(date)}
                    </span>
                    {" · "}{show.venueName}{show.state ? `, ${show.state}` : ""}
                    {show.ticketUrl && (
                      <> · <a href={show.ticketUrl} target="_blank" rel="noopener noreferrer" className="text-zinc-700 hover:underline dark:text-zinc-300">EDMTrain ↗</a></>
                    )}
                    {show.interestedAt && (
                      <> · <span className="text-amber-600 dark:text-amber-400">★ Interested</span></>
                    )}
                  </p>
                  <div className="flex shrink-0 items-center gap-1">
                    <form action={toggleInterestedAction}>
                      <input type="hidden" name="showId" value={show.id} />
                      <button
                        type="submit"
                        title={show.interestedAt ? "Unmark interested" : "Mark interested"}
                        className={cn(
                          "inline-flex h-8 w-8 items-center justify-center rounded-md border text-base transition",
                          show.interestedAt
                            ? "border-amber-300 bg-amber-50 text-amber-600 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-400 dark:hover:bg-amber-950"
                            : "border-zinc-200 text-zinc-500 hover:border-amber-300 hover:text-amber-500 dark:border-zinc-800 dark:text-zinc-500 dark:hover:border-amber-800 dark:hover:text-amber-400"
                        )}
                      >
                        {show.interestedAt ? "★" : "☆"}
                      </button>
                    </form>
                    <form action={show.dismissedAt ? restoreShowAction : dismissShowAction}>
                      <input type="hidden" name="showId" value={show.id} />
                      <button
                        type="submit"
                        title={show.dismissedAt ? "Restore" : "Dismiss"}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-200 text-base text-zinc-500 transition hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-900 dark:border-zinc-800 dark:hover:border-zinc-700 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
                      >
                        {show.dismissedAt ? "↺" : "×"}
                      </button>
                    </form>
                  </div>
                </div>
                <div className="mt-3 space-y-2">
                  {show.matchedArtists.map((a) => {
                    const contact = a.contacts[0] ?? null;
                    const artistOutreach = show.outreach.find(
                      (o) => o.artistId === a.id && (o.status === "sent" || o.status === "test")
                    );
                    const outreach = artistOutreach ?? (contact ? show.outreach.find((o) => o.contactId === contact.id) : undefined);
                    const alreadySent = artistOutreach?.status === "sent";
                    return (
                      <div
                        key={a.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-100 bg-zinc-50/50 px-3 py-2 dark:border-zinc-900 dark:bg-zinc-900/40"
                      >
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <ArtistLink artistId={a.id} className="text-sm font-medium">
                            {a.name}
                          </ArtistLink>
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
                              href={`spotify:playlist:${pl.spotifyId}`}
                              title={`Open "${pl.name}" in Spotify`}
                              className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200 transition hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900 dark:hover:bg-emerald-950"
                            >
                              ♪ {pl.name}
                            </a>
                          ))}
                          {a.playlists.length > 3 && (
                            <span className="text-[10px] text-zinc-500">+{a.playlists.length - 3} more</span>
                          )}
                          {a.genres.slice(0, 2).map((g) => (
                            <Badge key={g} tone="muted" size="xs">{g}</Badge>
                          ))}
                          {contact && (
                            <>
                              <Link
                                href={a.contacts.length > 1 ? `/artists/${a.id}` : `/dashboard/contact/${contact.id}`}
                                className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                                title={a.contacts.map((c) => `${c.name ?? ""} ${c.email ? `<${c.email}>` : c.phone ?? ""}`.trim()).join("\n")}
                              >
                                {contact.customPrice ?? (a.contacts.length > 1 ? `${a.contacts.length} contacts` : "edit")}
                              </Link>
                              {contact.isFullTeam && (
                                <Badge tone="accent" title="Email goes to the artist's full management team">Full team</Badge>
                              )}
                            </>
                          )}
                          {!contact && (
                            <Link
                              href={`/dashboard/add-contact/${a.id}`}
                              className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-200 transition hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900 dark:hover:bg-amber-950"
                            >
                              + Add contact
                            </Link>
                          )}
                          {outreach && (
                            <Badge tone={statusTone(outreach)}>
                              {statusLabels(outreach).join(" · ")}
                            </Badge>
                          )}
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          {contact && (
                            <div className="flex gap-1.5">
                              <SendButton
                                showId={show.id}
                                contactId={contact.id}
                                contactName={contact.name}
                                phone={contact.phone}
                                alreadySent={alreadySent}
                                action={sendNowAction}
                              />
                              {contact.email && (
                                <LinkButton href={`/dashboard/customize/${show.id}/${contact.id}`} variant="secondary" size="sm">
                                  Customize
                                </LinkButton>
                              )}
                            </div>
                          )}
                          {!alreadySent && (
                            <form action={markSentAction}>
                              <input type="hidden" name="showId" value={show.id} />
                              {contact ? (
                                <input type="hidden" name="contactId" value={contact.id} />
                              ) : (
                                <input type="hidden" name="artistId" value={a.id} />
                              )}
                              <button
                                type="submit"
                                title="Record as sent without actually emailing (use if you reached out via DM, personal email, etc.)"
                                className="text-[10px] text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                              >
                                Mark sent (manual)
                              </button>
                            </form>
                          )}
                          {alreadySent && artistOutreach && (
                            <form action={unmarkSentAction}>
                              <input type="hidden" name="outreachId" value={artistOutreach.id} />
                              <button
                                type="submit"
                                title="Only deletes manual marks (rows with no Resend message ID)"
                                className="text-[10px] text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                              >
                                Unmark
                              </button>
                            </form>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {show.otherArtists.length > 0 && (
                  <p className="mt-3 truncate text-xs text-zinc-400">
                    +{" "}
                    {show.otherArtists.map((a, i) => (
                      <span key={a.id}>
                        {i > 0 && ", "}
                        <ArtistLink artistId={a.id} className="hover:text-zinc-600 dark:hover:text-zinc-300">
                          {a.name}
                        </ArtistLink>
                      </span>
                    ))}
                  </p>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
