import Link from "next/link";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function FestivalsPage() {
  const festivals = await db.show.findMany({
    where: { isFestival: true, date: { gte: new Date() } },
    orderBy: { date: "asc" },
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
    take: 200,
  });

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/" className="text-sm text-blue-600 hover:underline">← Home</Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Festivals</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {festivals.length} upcoming · EDMTrain + manual
          </p>
        </div>
        <div className="flex gap-2 text-sm">
          <Link href="/festivals/new" className="rounded-md bg-emerald-600 px-3 py-1.5 font-medium text-white hover:bg-emerald-700">
            + Add festival
          </Link>
          <Link href="/dashboard" className="rounded-md border border-zinc-300 px-3 py-1.5 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900">
            Dashboard
          </Link>
        </div>
      </div>

      {festivals.length === 0 ? (
        <div className="mt-10 rounded-lg border border-dashed border-zinc-300 p-10 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No festivals yet. The next EDMTrain sync will populate this, or click <b>+ Add festival</b> to add one manually.
        </div>
      ) : (
        <ul className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {festivals.map((f) => {
            const matched = f.artists.filter((sa) => sa.artist.listenSignals.length > 0).length;
            const withContact = f.artists.filter((sa) => sa.artist.contacts.length > 0).length;
            const headliners = f.artists.slice(0, 4).map((sa) => sa.artist.name);
            return (
              <Link
                key={f.id}
                href={`/festivals/${f.id}`}
                className="rounded-lg border border-zinc-200 p-4 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
              >
                <p className="font-medium">{f.eventName || f.venueName}</p>
                <p className="mt-1 text-xs text-zinc-500">
                  {f.date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
                  {" · "}{f.venueName}{f.state ? `, ${f.state}` : ""}
                  {f.source === "manual" && <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">manual</span>}
                </p>
                <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
                  {f.artists.length} artists · <span className="text-emerald-700 dark:text-emerald-400">{matched} matched</span> · <span className="text-blue-700 dark:text-blue-400">{withContact} with contact</span>
                </p>
                {headliners.length > 0 && (
                  <p className="mt-2 truncate text-xs text-zinc-500">
                    {headliners.join(", ")}{f.artists.length > 4 ? ` +${f.artists.length - 4}` : ""}
                  </p>
                )}
              </Link>
            );
          })}
        </ul>
      )}
    </main>
  );
}
