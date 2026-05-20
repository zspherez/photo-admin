import Link from "next/link";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { syncEdmtrainShows } from "@/lib/edmtrain";

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
      where: { date: { gte: new Date() } },
      orderBy: { date: "asc" },
      include: { artists: { include: { artist: true } } },
      take: 200,
    }),
    db.setting.findUnique({ where: { key: "edmtrain_last_sync" } }),
    db.artist.count(),
  ]);

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <Link href="/" className="text-sm text-blue-600 hover:underline">← Home</Link>
      <div className="mt-4 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Upcoming NYC shows</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {shows.length} upcoming · {totalArtists} artists known ·{" "}
            {lastSync ? `last sync ${new Date(lastSync.value).toLocaleString()}` : "never synced"}
          </p>
        </div>
        <form action={refreshShows}>
          <button
            type="submit"
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
          >
            Refresh from EDMTrain
          </button>
        </form>
      </div>

      {shows.length === 0 ? (
        <div className="mt-10 rounded-lg border border-dashed border-zinc-300 p-10 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No shows yet. Click <b>Refresh from EDMTrain</b> to pull the next 90 days.
        </div>
      ) : (
        <ul className="mt-6 divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {shows.map((show) => (
            <li key={show.id} className="px-4 py-3">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {show.artists.map((sa: { artist: { name: string } }) => sa.artist.name).join(", ") || "TBA"}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-zinc-500">
                    {show.venueName} · {show.city}
                    {show.state ? `, ${show.state}` : ""} ·{" "}
                    {show.date.toLocaleDateString(undefined, {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                    })}
                  </p>
                </div>
                {show.ticketUrl && (
                  <a
                    href={show.ticketUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 text-xs font-medium text-blue-600 hover:underline"
                  >
                    EDMTrain ↗
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
