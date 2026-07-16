import type { Metadata } from "next";
import type { Prisma } from "@prisma/client";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button, LinkButton } from "@/components/ui/button";
import { formatShowDate } from "@/lib/formatDate";
import { easternTodayStoredDate } from "@/lib/calendarDate";
import { activeListenSignalWhere } from "@/lib/listenSignal";
import { requireServerActionAuth } from "@/lib/auth";
import type { SearchParamValue } from "@/lib/searchParams";
import {
  NEW_SHOWS_PAGE_SIZE,
  parseSnapshotCursor,
  parseSnapshotCutoff,
  snapshotPageHref,
  traverseNewShowSnapshot,
  type NewShowSnapshotCursor,
} from "./new-shows-snapshot";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Newly announced" };
const LAST_SEEN_KEY = "last_seen_new_shows";

function storedCheckpoint(value: string | undefined): Date {
  if (!value) return new Date(0);
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
    ? parsed
    : new Date(0);
}

function snapshotWhere(
  lastSeen: Date,
  cutoff: Date,
  today: Date,
  cursor: NewShowSnapshotCursor | null,
): Prisma.ShowWhereInput {
  return {
    createdAt: { gt: lastSeen, lte: cutoff },
    date: { gte: today },
    syncStatus: "active",
    ...(cursor
      ? {
          AND: [
            {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                {
                  createdAt: cursor.createdAt,
                  id: { lt: cursor.id },
                },
              ],
            },
          ],
        }
      : {}),
  };
}

async function advanceCheckpoint(cutoff: Date): Promise<void> {
  const value = cutoff.toISOString();
  await db.setting.upsert({
    where: { key: LAST_SEEN_KEY },
    create: { key: LAST_SEEN_KEY, value },
    update: {},
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await db.setting.findUnique({
      where: { key: LAST_SEEN_KEY },
    });
    if (!current || storedCheckpoint(current.value) >= cutoff) return;
    const updated = await db.setting.updateMany({
      where: { key: LAST_SEEN_KEY, value: current.value },
      data: { value },
    });
    if (updated.count === 1) return;
  }

  throw new Error("Could not advance the new-shows checkpoint");
}

async function markAllSeen(formData: FormData) {
  "use server";
  await requireServerActionAuth("/new");
  const actionNow = new Date();
  const cutoff = parseSnapshotCutoff(formData.get("cutoff"), actionNow);
  if (!cutoff) redirect("/new");

  const current = await db.setting.findUnique({
    where: { key: LAST_SEEN_KEY },
  });
  const lastSeen = storedCheckpoint(current?.value);
  if (lastSeen < cutoff) {
    const today = easternTodayStoredDate(actionNow);
    await traverseNewShowSnapshot({
      cutoff,
      fetchPage: ({ cursor, take }) =>
        db.show.findMany({
          where: snapshotWhere(lastSeen, cutoff, today, cursor),
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take,
          select: { id: true, createdAt: true },
        }),
    });
    await advanceCheckpoint(cutoff);
  }

  revalidatePath("/new");
  revalidatePath("/");
  redirect("/new");
}

export default async function NewlyAnnouncedPage({
  searchParams,
}: {
  searchParams: Promise<{
    cutoff?: SearchParamValue;
    beforeCreatedAt?: SearchParamValue;
    beforeId?: SearchParamValue;
  }>;
}) {
  const rawSearchParams = await searchParams;
  const now = new Date();
  const cutoff = parseSnapshotCutoff(rawSearchParams.cutoff, now) ?? now;
  const cursor = parseSnapshotCursor(
    rawSearchParams.beforeCreatedAt,
    rawSearchParams.beforeId,
    cutoff,
  );
  const lastSeenSetting = await db.setting.findUnique({ where: { key: LAST_SEEN_KEY } });
  const lastSeen = storedCheckpoint(lastSeenSetting?.value);

  const shows = await db.show.findMany({
    where: snapshotWhere(
      lastSeen,
      cutoff,
      easternTodayStoredDate(now),
      cursor,
    ),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: {
      artists: {
        include: {
          artist: {
            include: {
              listenSignals: {
                where: activeListenSignalWhere(now),
                take: 1,
                orderBy: { rank: "asc" },
              },
              contacts: { where: { state: "active" }, take: 1 },
            },
          },
        },
      },
    },
    take: NEW_SHOWS_PAGE_SIZE + 1,
  });
  const hasNextPage = shows.length > NEW_SHOWS_PAGE_SIZE;
  const pageShows = shows.slice(0, NEW_SHOWS_PAGE_SIZE);
  const nextCursor = hasNextPage
    ? {
        createdAt: pageShows[pageShows.length - 1].createdAt,
        id: pageShows[pageShows.length - 1].id,
      }
    : null;

  // Roll up festivals: show only one row per festival (the one we just created).
  // Regular shows pass through. Plus dedupe same-festival names for cleanliness.
  const seenFestivalKeys = new Set<string>();
  const items = pageShows.filter((s) => {
    if (!s.isFestival) return true;
    const key = `${(s.eventName ?? s.venueName).toLowerCase()}|${s.venueName.toLowerCase()}|${s.city.toLowerCase()}`;
    if (seenFestivalKeys.has(key)) return false;
    seenFestivalKeys.add(key);
    return true;
  });

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Newly announced</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {items.length === 0
              ? "Nothing new since you last checked."
              : `${items.length} new since ${lastSeen.toLocaleString()}`}
          </p>
        </div>
        {pageShows.length > 0 && (
          <form action={markAllSeen}>
            <input type="hidden" name="cutoff" value={cutoff.toISOString()} />
            <Button type="submit" variant="primary" size="md">Mark all seen</Button>
          </form>
        )}
      </div>

      {items.length === 0 ? (
        <div className="mt-10 rounded-xl border border-dashed border-zinc-300 p-12 text-center text-sm text-zinc-500 dark:border-zinc-700">
          Caught up. Come back after the next sync (daily at 09:00 UTC).
        </div>
      ) : (
        <Card className="mt-6">
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {items.map((show) => {
              const matched = show.artists.filter((sa) => sa.artist.listenSignals.length > 0).length;
              const withContact = show.artists.filter((sa) => sa.artist.contacts.length > 0).length;
              const detailHref = show.isFestival ? `/festivals/${show.id}` : `/dashboard`;
              const headliners = show.artists.slice(0, 4).map((sa) => sa.artist.name).join(", ");
              return (
                <li key={show.id} className="px-4 py-3">
                  <Link href={detailHref} className="block transition hover:opacity-80">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">
                            {show.eventName || headliners || "TBA"}
                          </span>
                          {show.isFestival && <Badge tone="accent" size="xs">Festival</Badge>}
                          {matched > 0 && <Badge tone="success" size="xs">{matched} matched</Badge>}
                          {withContact > 0 && <Badge tone="info" size="xs">{withContact} contact</Badge>}
                        </div>
                        <p className="mt-0.5 truncate text-xs text-zinc-500">
                          {formatShowDate(show.date)}
                          {" · "}{show.venueName}
                          {show.state ? `, ${show.state}` : show.city ? `, ${show.city}` : ""}
                          {show.eventName && headliners && ` · ${headliners}`}
                          {show.artists.length > 4 ? ` +${show.artists.length - 4}` : ""}
                        </p>
                      </div>
                      <span className="shrink-0 text-[10px] text-zinc-400">
                        added {timeAgo(show.createdAt)}
                      </span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {(cursor || nextCursor) && (
        <nav className="mt-4 flex items-center justify-between gap-3" aria-label="New show pages">
          <div>
            {cursor && (
              <LinkButton href={snapshotPageHref(cutoff)} variant="secondary" size="sm">
                First page
              </LinkButton>
            )}
          </div>
          {nextCursor && (
            <LinkButton
              href={snapshotPageHref(cutoff, nextCursor)}
              variant="secondary"
              size="sm"
            >
              Next page
            </LinkButton>
          )}
        </nav>
      )}
    </main>
  );
}

function timeAgo(d: Date): string {
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return d.toLocaleDateString();
}
