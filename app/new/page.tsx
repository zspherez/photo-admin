import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatShowDate } from "@/lib/formatDate";

export const dynamic = "force-dynamic";
const LAST_SEEN_KEY = "last_seen_new_shows";

async function markAllSeen() {
  "use server";
  await db.setting.upsert({
    where: { key: LAST_SEEN_KEY },
    create: { key: LAST_SEEN_KEY, value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  });
  revalidatePath("/new");
  revalidatePath("/");
  redirect("/new");
}

export default async function NewlyAnnouncedPage() {
  const lastSeenSetting = await db.setting.findUnique({ where: { key: LAST_SEEN_KEY } });
  const lastSeen = lastSeenSetting ? new Date(lastSeenSetting.value) : new Date(0);

  const shows = await db.show.findMany({
    where: {
      createdAt: { gt: lastSeen },
      date: { gte: new Date() },
    },
    orderBy: { createdAt: "desc" },
    include: {
      artists: {
        include: {
          artist: {
            include: {
              listenSignals: { take: 1, orderBy: { rank: "asc" } },
              contacts: { take: 1 },
            },
          },
        },
      },
    },
    take: 300,
  });

  // Roll up festivals: show only one row per festival (the one we just created).
  // Regular shows pass through. Plus dedupe same-festival names for cleanliness.
  const seenFestivalKeys = new Set<string>();
  const items = shows.filter((s) => {
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
        {items.length > 0 && (
          <form action={markAllSeen}>
            <Button type="submit" variant="primary" size="md">Mark all seen</Button>
          </form>
        )}
      </div>

      {items.length === 0 ? (
        <div className="mt-10 rounded-xl border border-dashed border-zinc-300 p-12 text-center text-sm text-zinc-500 dark:border-zinc-700">
          Caught up. Come back after the next sync (daily at 11am UTC).
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
