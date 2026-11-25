import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { Card, CardBody } from "@/components/ui/card";
import { formatShowDate } from "@/lib/formatDate";
import { festivalRunWindow, loadFestivalRuns } from "@/lib/festivalRuns";
import { getSessionAccess, SESSION_COOKIE } from "@/lib/auth";
import { db } from "@/lib/db";
import { validatedTrimmedSearchParam, type SearchParamValue } from "@/lib/searchParams";
import {
  dismissFestivalRunSuggestionAction,
  reviewFestivalRunSuggestionAction,
  startFestivalRunSearchAction,
} from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Festival runs" };

export default async function FestivalRunsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: SearchParamValue }>;
}) {
  const now = new Date();
  const { start, end } = festivalRunWindow(now);
  const [runs, cookieStore, batch, suggestions] = await Promise.all([
    loadFestivalRuns(now),
    cookies(),
    db.festivalRunSearchBatch.findFirst({
      orderBy: { createdAt: "desc" },
      include: { jobs: { select: { status: true } } },
    }),
    db.festivalRunSearchSuggestion.findMany({
      where: { date: { gte: start, lt: end }, status: { in: ["pending", "reviewed"] } },
      include: { job: { select: { artistId: true, artist: { select: { name: true } } } } },
      orderBy: [{ date: "asc" }, { createdAt: "desc" }],
    }),
  ]);
  const access = await getSessionAccess(cookieStore.get(SESSION_COOKIE)?.value);
  const error = validatedTrimmedSearchParam((await searchParams).error, { maxLength: 180 });
  const suggestionsByArtist = Map.groupBy(suggestions, (suggestion) => suggestion.job.artistId);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Festival runs</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Next 12 months · artists at two or more distinct confirmed festivals
          </p>
        </div>
        {access !== "read_only" && (
          <Link href="/festival-runs/template" className="text-sm font-medium underline">
            Edit pitch template
          </Link>
        )}
      </div>
      <section className="mt-6 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="font-semibold">Search beyond imported festivals</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Manually search up to 100 unique artists per service by best active rank,
          then deduplicate the Spotify and Stats.fm lists.
          Evidence is saved as review-only suggestions; no shows are imported and no email is sent.
        </p>
        {access !== "read_only" && (
          <form action={startFestivalRunSearchAction} className="mt-3">
            <button type="submit"
              disabled={!!batch && ["queued", "running"].includes(batch.status) &&
                batch.updatedAt.getTime() > now.getTime() - 4 * 60 * 60_000}
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900">
              Search for festival runs
            </button>
          </form>
        )}
        {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
        {batch && <p className="mt-2 text-sm text-zinc-500">
          Latest search: {batch.status.replaceAll("_", " ")} · {batch.jobs.filter((job) => job.status === "complete").length}/{batch.jobs.length} artists processed
          {batch.jobs.some((job) => job.status === "failed") &&
            ` · ${batch.jobs.filter((job) => job.status === "failed").length} failed`}
        </p>}
        {batch?.status === "dispatch_failed" && <p className="mt-2 text-sm text-red-600">
          Workflow could not start. Check the GitHub dispatch token and retry.
        </p>}
      </section>
      {suggestionsByArtist.size > 0 && (
        <section className="mt-8">
          <h2 className="text-xl font-semibold">Web-sourced suggestions (not confirmed shows)</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Verify the artist, festival, date and location on each linked source before manually adding a show.
            Reviewed suggestions never enter the confirmed runs or outreach queue.
          </p>
          <div className="mt-4 space-y-4">
            {[...suggestionsByArtist].map(([artistId, artistSuggestions]) => (
              <Card key={artistId}>
                <CardBody>
                  <h3 className="font-semibold">{artistSuggestions[0].job.artist.name}</h3>
                  <ul className="mt-2 space-y-3">
                    {artistSuggestions.map((suggestion) => (
                      <li key={suggestion.id} className="border-t border-zinc-200 pt-2 text-sm dark:border-zinc-800">
                        <div>
                          {formatShowDate(suggestion.date)} · {suggestion.festivalName} · {suggestion.city}{suggestion.region ? `, ${suggestion.region}` : ""} ({suggestion.countryCode}) · {suggestion.status}
                        </div>
                        <a href={suggestion.sourceUrl} target="_blank" rel="noopener noreferrer" className="break-all underline">View source</a>
                        <p className="mt-1 whitespace-pre-wrap text-zinc-500">{suggestion.evidence}</p>
                        {access !== "read_only" && suggestion.status === "pending" && (
                          <div className="mt-2 flex gap-3">
                            <form action={reviewFestivalRunSuggestionAction}>
                              <input type="hidden" name="id" value={suggestion.id} />
                              <button type="submit" className="underline">Mark reviewed</button>
                            </form>
                            <form action={dismissFestivalRunSuggestionAction}>
                              <input type="hidden" name="id" value={suggestion.id} />
                              <button type="submit" className="underline">Dismiss</button>
                            </form>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </CardBody>
              </Card>
            ))}
          </div>
        </section>
      )}
      {runs.length === 0 ? (
        <p className="mt-8 text-sm text-zinc-500">
          No confirmed multi-festival runs found yet. The nationwide festival sync updates this list.
        </p>
      ) : (
        <div className="mt-6 space-y-4">
          {runs.map((run) => (
            <Card key={run.artistId}>
              <CardBody>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-lg font-semibold">{run.artistName}</h2>
                  {access !== "read_only" && <Link
                    href={`/festival-runs/${encodeURIComponent(run.artistId)}/compose`}
                    className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900">
                    Compose pitch
                  </Link>}
                </div>
                <ul className="mt-3 divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
                  {run.shows.map((show) => (
                    <li key={show.id} className="flex flex-wrap justify-between gap-2 py-2">
                      <span>{formatShowDate(show.date)} · {show.eventName || show.venueName}</span>
                      <span className="text-zinc-500">
                        {show.city}{show.state ? `, ${show.state}` : ""}{show.countryCode ? ` (${show.countryCode})` : ""}
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
