import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { syncEdmtrainShows } from "@/lib/edmtrain";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatShowDate } from "@/lib/formatDate";

export const dynamic = "force-dynamic";

async function refreshShows() {
  "use server";
  await syncEdmtrainShows(90);
  revalidatePath("/shows");
  revalidatePath("/");
}

export default async function ShowsPage() {
  const [shows, lastSync, totalArtists] = await Promise.all([
    db.show.findMany({
      where: { date: { gte: new Date() }, isFestival: false },
      orderBy: { date: "asc" },
      include: { artists: { include: { artist: true } } },
      take: 200,
    }),
    db.setting.findUnique({ where: { key: "edmtrain_last_sync" } }),
    db.artist.count(),
  ]);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">All NYC shows</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {shows.length} upcoming · {totalArtists.toLocaleString()} artists tracked
            {lastSync && ` · last sync ${new Date(lastSync.value).toLocaleString()}`}
          </p>
        </div>
        <form action={refreshShows}>
          <Button type="submit" variant="primary" size="md">Refresh from EDMTrain</Button>
        </form>
      </div>

      {shows.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-zinc-300 p-12 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No shows yet. Click <b>Refresh from EDMTrain</b> to pull the next 90 days.
        </div>
      ) : (
        <Card className="mt-6">
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {shows.map((show) => (
              <li key={show.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {show.artists.map((sa: { artist: { name: string } }) => sa.artist.name).join(", ") || "TBA"}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-zinc-500">
                    {show.venueName} · {show.city}
                    {show.state ? `, ${show.state}` : ""} ·{" "}
                    {formatShowDate(show.date, { weekday: "short", month: "short", day: "numeric" })}
                  </p>
                </div>
                {show.ticketUrl && (
                  <a
                    href={show.ticketUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                  >
                    EDMTrain ↗
                  </a>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </main>
  );
}
