import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { Card, CardBody } from "@/components/ui/card";
import { formatShowDate } from "@/lib/formatDate";
import { loadNewYearRuns, newYearRunWindow } from "@/lib/newYearRuns";
import { getSessionAccess, SESSION_COOKIE } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "New Year's runs" };

export default async function NewYearRunsPage() {
  const now = new Date();
  const { year } = newYearRunWindow(now);
  const [runs, cookieStore] = await Promise.all([loadNewYearRuns(now), cookies()]);
  const access = await getSessionAccess(cookieStore.get(SESSION_COOKIE)?.value);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">New Year&apos;s runs</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Dec 27, {year}–Jan 3, {year + 1} · artists with shows in at least two US cities
          </p>
        </div>
        {access !== "read_only" && (
          <Link href="/new-years-runs/template" className="text-sm font-medium underline">
            Edit pitch template
          </Link>
        )}
      </div>
      {runs.length === 0 ? (
        <p className="mt-8 text-sm text-zinc-500">
          No multi-city runs found yet. The nationwide event sync updates this list.
        </p>
      ) : (
        <div className="mt-6 space-y-4">
          {runs.map((run) => (
            <Card key={run.artistId}>
              <CardBody>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-lg font-semibold">{run.artistName}</h2>
                  {access !== "read_only" && <Link
                    href={`/new-years-runs/${encodeURIComponent(run.artistId)}/compose`}
                    className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
                  >
                    Compose pitch
                  </Link>}
                </div>
                <ul className="mt-3 divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
                  {run.shows.map((show) => (
                    <li key={show.id} className="flex flex-wrap justify-between gap-2 py-2">
                      <span>
                        {formatShowDate(show.date)} · {show.eventName || show.venueName}
                        {show.isFestival && " · Festival"}
                      </span>
                      <span className="text-zinc-500">
                        {show.city}{show.state ? `, ${show.state}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </main>
  );
}
