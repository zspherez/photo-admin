import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/lib/db";
import { Card } from "@/components/ui/card";
import { LinkButton } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { easternTodayStoredDate } from "@/lib/calendarDate";
import { pickEmailContact } from "@/lib/contactSelection";
import { countryLabel } from "@/lib/country";
import {
  festivalCountryCategory,
  festivalGroupKey,
  festivalListPath,
  isFestivalVisible,
  parseFestivalListView,
  type FestivalListView,
} from "@/lib/festivalView";
import { formatShowDate } from "@/lib/formatDate";
import { pickTopListenSignal } from "@/lib/listenSignal";
import { festivalReturnPath } from "@/lib/dashboardReturnUrl";
import type { SearchParamValue } from "@/lib/searchParams";
import {
  dismissShowAction,
  restoreShowAction,
} from "@/app/dashboard/actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Festivals",
  description: "Upcoming festival outreach, filtered to the United States by default.",
};

type FestivalRow = Awaited<ReturnType<typeof loadFestivals>>[number];

async function loadFestivals(now: Date) {
  return db.show.findMany({
    where: {
      isFestival: true,
      syncStatus: "active",
      date: { gte: easternTodayStoredDate(now) },
    },
    orderBy: { date: "asc" },
    include: {
      artists: {
        include: {
          artist: {
            include: {
              listenSignals: {
                select: { source: true, rank: true, expiresAt: true },
              },
              contacts: {
                where: { state: "active" },
                select: {
                  email: true,
                  phone: true,
                  state: true,
                  isFullTeam: true,
                },
              },
            },
          },
        },
      },
    },
    take: 800,
  });
}

interface FestivalGroup {
  key: string;
  primary: FestivalRow;
  dates: Date[];
  showIds: string[];
}

function groupFestivals(rows: FestivalRow[]): FestivalGroup[] {
  const groups = new Map<string, FestivalGroup>();
  for (const festival of rows) {
    const key = festivalGroupKey(festival);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        key,
        primary: festival,
        dates: [festival.date],
        showIds: [festival.id],
      });
    } else {
      existing.dates.push(festival.date);
      existing.showIds.push(festival.id);
      if (festival.artists.length > existing.primary.artists.length) {
        existing.primary = festival;
      }
    }
  }
  return Array.from(groups.values()).sort(
    (a, b) =>
      Math.min(...a.dates.map((date) => date.getTime())) -
      Math.min(...b.dates.map((date) => date.getTime()))
  );
}

function dateRangeLabel(dates: Date[]): string {
  const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const fmt = (date: Date, withYear: boolean) =>
    formatShowDate(date, {
      weekday: "short",
      month: "short",
      day: "numeric",
      ...(withYear ? { year: "numeric" } : {}),
    });
  if (sorted.length === 1) return fmt(first, true);
  if (first.getUTCFullYear() === last.getUTCFullYear()) {
    return `${fmt(first, false)} – ${fmt(last, true)}`;
  }
  return `${fmt(first, true)} – ${fmt(last, true)}`;
}

function visibleGroups(
  festivals: FestivalRow[],
  view: FestivalListView
): FestivalGroup[] {
  return groupFestivals(
    festivals.filter((festival) => isFestivalVisible(festival, view))
  ).filter((group) => group.primary.artists.length > 0);
}

export default async function FestivalsPage({
  searchParams,
}: {
  searchParams: Promise<{
    includeInternational?: SearchParamValue;
    dismissed?: SearchParamValue;
  }>;
}) {
  const view = parseFestivalListView(await searchParams);
  const now = new Date();
  const festivals = await loadFestivals(now);
  const returnTo = festivalListPath(view);
  const stateRows = festivals.filter(
    (festival) => (festival.dismissedAt !== null) === view.dismissed
  );
  const stateGroups = groupFestivals(stateRows).filter(
    (group) => group.primary.artists.length > 0
  );
  const internationalCount = stateGroups.filter(
    (group) =>
      festivalCountryCategory(group.primary) === "international"
  ).length;
  const unknownCount = stateGroups.filter(
    (group) => festivalCountryCategory(group.primary) === "unknown"
  ).length;
  const groups = visibleGroups(festivals, view);
  const hiddenEmpty =
    groupFestivals(
      festivals.filter((festival) => isFestivalVisible(festival, view))
    ).length - groups.length;
  const activeCount = visibleGroups(festivals, {
    ...view,
    dismissed: false,
  }).length;
  const dismissedCount = visibleGroups(festivals, {
    ...view,
    dismissed: true,
  }).length;
  const hiddenCountryCount = internationalCount + unknownCount;

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Festivals</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {groups.length} {view.dismissed ? "dismissed" : "upcoming"}
            {hiddenEmpty > 0 && ` · ${hiddenEmpty} empty-lineup hidden`}
            {!view.includeInternational &&
              hiddenCountryCount > 0 &&
              ` · ${hiddenCountryCount} international or unknown hidden`}
          </p>
        </div>
        <LinkButton
          href={`/festivals/new?returnTo=${encodeURIComponent(returnTo)}`}
          variant="primary"
          size="sm"
        >
          + Add festival
        </LinkButton>
      </div>

      <nav
        aria-label="Festival visibility"
        className="mt-5 flex flex-wrap items-center gap-2"
      >
        <Link
          href={festivalListPath({ ...view, dismissed: false })}
          aria-current={!view.dismissed ? "page" : undefined}
          className={`rounded-full px-3 py-1 text-xs font-medium ${
            !view.dismissed
              ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
              : "border border-zinc-200 text-zinc-600 dark:border-zinc-800 dark:text-zinc-400"
          }`}
        >
          Upcoming {activeCount}
        </Link>
        <Link
          href={festivalListPath({ ...view, dismissed: true })}
          aria-current={view.dismissed ? "page" : undefined}
          className={`rounded-full px-3 py-1 text-xs font-medium ${
            view.dismissed
              ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
              : "border border-zinc-200 text-zinc-600 dark:border-zinc-800 dark:text-zinc-400"
          }`}
        >
          Dismissed {dismissedCount}
        </Link>
        <Link
          href={festivalListPath({
            ...view,
            includeInternational: !view.includeInternational,
          })}
          role="switch"
          aria-checked={view.includeInternational}
          aria-label={
            view.includeInternational
              ? "Show United States festivals only"
              : `Include ${internationalCount} international and ${unknownCount} unknown-country festivals`
          }
          className="rounded-full border border-zinc-200 px-3 py-1 text-xs font-medium text-zinc-600 dark:border-zinc-800 dark:text-zinc-400"
        >
          {view.includeInternational
            ? "✓ International + unknown included"
            : `Include international + unknown (${hiddenCountryCount})`}
        </Link>
      </nav>

      {unknownCount > 0 && (
        <p className="mt-2 text-xs text-zinc-500">
          {unknownCount} festival{unknownCount === 1 ? " has" : "s have"} no
          verified country code and {unknownCount === 1 ? "is" : "are"} treated
          as non-US until reviewed.
        </p>
      )}

      {groups.length === 0 ? (
        <div className="mt-10 rounded-xl border border-dashed border-zinc-300 p-12 text-center text-sm text-zinc-500 dark:border-zinc-700">
          {view.dismissed
            ? "No dismissed festivals match this country view."
            : "No upcoming US festivals yet. Include international and unknown-country festivals, refresh EDMTrain, or add one manually."}
        </div>
      ) : (
        <ul className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map(({ key, primary: festival, dates, showIds }) => {
            const matched = festival.artists.filter(
              (showArtist) =>
                pickTopListenSignal(showArtist.artist.listenSignals, now) !==
                null
            ).length;
            const withContact = festival.artists.filter(
              (showArtist) =>
                pickEmailContact(showArtist.artist.contacts) !== null
            ).length;
            const headliners = festival.artists
              .slice(0, 3)
              .map((showArtist) => showArtist.artist.name);
            const countryCategory = festivalCountryCategory(festival);
            return (
              <li key={key}>
                <Card className="relative h-full transition hover:border-zinc-300 hover:shadow-md dark:hover:border-zinc-700">
                  <Link
                    href={festivalReturnPath(
                      festival.id,
                      "all",
                      "all",
                      view
                    )}
                    className="block h-full p-5 pr-24"
                  >
                    <div className="flex items-start gap-2">
                      <p className="font-medium leading-tight">
                        {festival.eventName || festival.venueName}
                      </p>
                      {festival.source === "manual" && (
                        <Badge tone="muted" size="xs">
                          manual
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1.5 text-xs text-zinc-500">
                      {dateRangeLabel(dates)}
                      {dates.length > 1 && (
                        <span className="ml-1 text-zinc-400">
                          ({dates.length}d)
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 text-xs text-zinc-500">
                      {festival.venueName}
                      {festival.city ? ` · ${festival.city}` : ""}
                      {festival.state ? `, ${festival.state}` : ""}
                    </p>
                    <div className="mt-2">
                      <Badge
                        tone={
                          countryCategory === "unknown"
                            ? "warning"
                            : countryCategory === "international"
                              ? "info"
                              : "muted"
                        }
                        size="xs"
                      >
                        {countryLabel(festival)}
                      </Badge>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-1.5">
                      <Badge tone="default" size="xs">
                        {festival.artists.length} artists
                      </Badge>
                      {matched > 0 && (
                        <Badge tone="success" size="xs">
                          {matched} matched
                        </Badge>
                      )}
                      {withContact > 0 && (
                        <Badge tone="info" size="xs">
                          {withContact} contact
                        </Badge>
                      )}
                    </div>
                    {headliners.length > 0 && (
                      <p className="mt-3 truncate text-xs text-zinc-500">
                        {headliners.join(", ")}
                        {festival.artists.length > 3
                          ? ` +${festival.artists.length - 3}`
                          : ""}
                      </p>
                    )}
                  </Link>
                  <form
                    action={
                      view.dismissed ? restoreShowAction : dismissShowAction
                    }
                    className="absolute right-3 top-3"
                  >
                    <input type="hidden" name="returnTo" value={returnTo} />
                    {showIds.map((showId) => (
                      <input
                        key={showId}
                        type="hidden"
                        name="showId"
                        value={showId}
                      />
                    ))}
                    <PendingSubmitButton
                      variant={view.dismissed ? "secondary" : "ghost"}
                      size="sm"
                      pendingLabel="…"
                      aria-label={`${
                        view.dismissed ? "Restore" : "Dismiss"
                      } ${festival.eventName || festival.venueName}`}
                    >
                      {view.dismissed ? "Restore" : "Dismiss"}
                    </PendingSubmitButton>
                  </form>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
