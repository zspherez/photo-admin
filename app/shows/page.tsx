import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { syncEdmtrainShows } from "@/lib/edmtrain";
import { Card } from "@/components/ui/card";
import { formatShowDate } from "@/lib/formatDate";
import { easternTodayStoredDate } from "@/lib/calendarDate";
import { SyncForm } from "@/components/sync-form";
import { SyncBanner } from "@/components/sync-banner";
import { requireServerActionAuth } from "@/lib/auth";
import { firstSearchParam, type SearchParamValue } from "@/lib/searchParams";
import {
  createOperationDeadline,
  ROUTE_DEADLINE_SAFETY_MARGIN_MS,
} from "@/lib/integrationUtils";

export const dynamic = "force-dynamic";
export const maxDuration = 180;
export const metadata: Metadata = { title: "NYC shows" };

async function refreshShows() {
  "use server";
  await requireServerActionAuth("/shows");
  let redirectTo: string;
  try {
    const deadline = createOperationDeadline(maxDuration * 1_000, {
      safetyMarginMs: ROUTE_DEADLINE_SAFETY_MARGIN_MS,
    });
    const result = await syncEdmtrainShows(90, deadline);
    if (!result.ok) {
      const busy = "status" in result && result.status === "busy";
      const detail = busy
        ? `Another NYC EDMTrain sync owns ${result.leaseKey}; retry after it finishes.`
        : "error" in result
          ? result.error
          : "NYC EDMTrain sync could not start.";
      redirectTo = `/shows?synced=${busy ? "busy" : "error"}&detail=${encodeURIComponent(detail.slice(0, 200))}`;
    } else {
      const params = new URLSearchParams({
        synced: "ok",
        fetched: String(result.data.fetched),
        upserted: String(result.data.upserted),
        linked: String(result.data.artistsLinked),
        outside: String(result.data.outsideNyc),
        unknown: String(result.data.geographyUnknown),
        venues: String(result.data.venuesCached),
        reused: String(result.data.venuesReused),
      });
      redirectTo = `/shows?${params.toString()}`;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    redirectTo = `/shows?synced=error&detail=${encodeURIComponent(msg.slice(0, 200))}`;
  }
  revalidatePath("/shows");
  revalidatePath("/");
  redirect(redirectTo);
}

export default async function ShowsPage({
  searchParams,
}: {
  searchParams: Promise<{
    synced?: SearchParamValue;
    fetched?: SearchParamValue;
    upserted?: SearchParamValue;
    linked?: SearchParamValue;
    outside?: SearchParamValue;
    unknown?: SearchParamValue;
    venues?: SearchParamValue;
    reused?: SearchParamValue;
    detail?: SearchParamValue;
  }>;
}) {
  const rawSearchParams = await searchParams;
  const sp = {
    synced: firstSearchParam(rawSearchParams.synced),
    fetched: firstSearchParam(rawSearchParams.fetched),
    upserted: firstSearchParam(rawSearchParams.upserted),
    linked: firstSearchParam(rawSearchParams.linked),
    outside: firstSearchParam(rawSearchParams.outside),
    unknown: firstSearchParam(rawSearchParams.unknown),
    venues: firstSearchParam(rawSearchParams.venues),
    reused: firstSearchParam(rawSearchParams.reused),
    detail: firstSearchParam(rawSearchParams.detail),
  };
  const today = easternTodayStoredDate();
  const [shows, lastSync, totalArtists] = await Promise.all([
    db.show.findMany({
      where: {
        date: { gte: today },
        isFestival: false,
        syncStatus: "active",
      },
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
        <SyncForm action={refreshShows} label="Refresh from EDMTrain" pendingLabel="Refreshing…" />
      </div>

      {sp.synced === "ok" && (
        <SyncBanner
          tone="success"
          title="Shows refreshed."
          detail={`${sp.fetched ?? "?"} fetched · ${sp.upserted ?? "?"} upserted · ${sp.outside ?? "?"} outside NYC · ${sp.unknown ?? "?"} geography unknown · ${sp.venues ?? "?"} venues cached (${sp.reused ?? "?"} reused) · ${sp.linked ?? "?"} artists linked`}
        />
      )}
      {sp.synced === "error" && (
        <SyncBanner tone="error" title="Sync failed." detail={sp.detail ?? "unknown error"} />
      )}
      {sp.synced === "busy" && (
        <SyncBanner tone="error" title="Sync already running." detail={sp.detail ?? "Retry shortly."} />
      )}

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
