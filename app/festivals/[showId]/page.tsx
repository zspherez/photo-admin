import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { sendOutreach } from "@/lib/sendOutreach";
import { getTestOverride } from "@/lib/resend";

export const dynamic = "force-dynamic";

async function bulkSend(formData: FormData) {
  "use server";
  const showId = formData.get("showId") as string;
  const contactIds = formData.getAll("contactIds").map((v) => String(v));
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const errors: string[] = [];
  for (const contactId of contactIds) {
    const result = await sendOutreach({ showId, contactId });
    if (result.ok) sent++;
    else if (result.error?.includes("Already sent")) skipped++;
    else {
      failed++;
      if (result.error) errors.push(`${contactId.slice(-6)}: ${result.error}`);
    }
  }
  revalidatePath(`/festivals/${showId}`);
  const params = new URLSearchParams({ sent: String(sent), failed: String(failed), skipped: String(skipped) });
  if (errors.length) params.set("errors", errors.slice(0, 3).join(" | "));
  redirect(`/festivals/${showId}?${params.toString()}`);
}

function rankLabel(source: string, rank: number | null): string {
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
  const nice = map[source] ?? source;
  return rank ? `${nice} #${rank}` : nice;
}

export default async function FestivalDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ showId: string }>;
  searchParams: Promise<{ sent?: string; failed?: string; skipped?: string; errors?: string; filter?: string }>;
}) {
  const { showId } = await params;
  const sp = await searchParams;
  const filter = sp.filter ?? "all";
  const testOverride = getTestOverride();

  const festival = await db.show.findUnique({
    where: { id: showId },
    include: {
      artists: {
        include: {
          artist: {
            include: {
              listenSignals: { orderBy: { rank: "asc" } },
              contacts: true,
            },
          },
        },
      },
      outreaches: true,
    },
  });
  if (!festival || !festival.isFestival) return notFound();

  const rows = festival.artists.map((sa) => {
    const a = sa.artist;
    const topSignal = a.listenSignals[0] ?? null;
    const matched = a.listenSignals.length > 0;
    const contact = a.contacts[0] ?? null;
    const outreach = contact ? festival.outreaches.find((o) => o.contactId === contact.id) : undefined;
    const genres: string[] = (() => {
      try {
        return a.genres ? (JSON.parse(a.genres) as string[]).filter((g) => typeof g === "string") : [];
      } catch {
        return [];
      }
    })();
    return { artist: a, topSignal, matched, contact, outreach, genres };
  });

  const filtered = rows.filter((r) => {
    if (filter === "matched") return r.matched;
    if (filter === "matched_with_contact") return r.matched && !!r.contact;
    if (filter === "needs_contact") return r.matched && !r.contact;
    if (filter === "unsent") return r.matched && !!r.contact && r.outreach?.status !== "sent";
    return true;
  });

  const eligibleSendCount = filtered.filter((r) => r.contact && r.outreach?.status !== "sent").length;

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <Link href="/festivals" className="text-sm text-blue-600 hover:underline">← Festivals</Link>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{festival.eventName || festival.venueName}</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {festival.date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
            {" · "}{festival.venueName}{festival.state ? `, ${festival.state}` : ""}
            {festival.ticketUrl && (
              <> · <a href={festival.ticketUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">EDMTrain ↗</a></>
            )}
          </p>
        </div>
      </div>

      {testOverride && (
        <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          Test override active — sends route to <b>{testOverride}</b>. Outreach rows stored as <code>status=test</code>.
        </div>
      )}
      {(sp.sent || sp.failed || sp.skipped) && (
        <div className="mt-4 rounded-md border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-200">
          Bulk send: {sp.sent || 0} sent, {sp.failed || 0} failed, {sp.skipped || 0} skipped.
          {sp.errors && <span className="ml-2 text-red-700 dark:text-red-300">{sp.errors}</span>}
        </div>
      )}

      <section className="mt-6 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-zinc-500">Filter:</span>
        {([
          ["all", "All"],
          ["matched", "Matched"],
          ["matched_with_contact", "Matched + contact"],
          ["needs_contact", "Needs contact"],
          ["unsent", "Unsent (sendable)"],
        ] as const).map(([key, label]) => (
          <Link
            key={key}
            href={`/festivals/${showId}${key === "all" ? "" : `?filter=${key}`}`}
            className={`rounded-full px-2.5 py-0.5 font-medium ${
              filter === key
                ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "border border-zinc-300 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            }`}
          >
            {label}
          </Link>
        ))}
      </section>

      <form action={bulkSend} className="mt-6">
        <input type="hidden" name="showId" value={showId} />

        <div className="sticky top-0 z-10 -mx-4 mb-3 flex items-center justify-between gap-2 rounded-md border border-zinc-200 bg-white px-4 py-2 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <span className="text-sm text-zinc-600 dark:text-zinc-400">
            {filtered.length} shown · {eligibleSendCount} sendable
          </span>
          <button
            type="submit"
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={eligibleSendCount === 0}
          >
            Send to selected
          </button>
        </div>

        <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {filtered.map((r) => {
            const canSend = !!r.contact && r.outreach?.status !== "sent";
            return (
              <li key={r.artist.id} className="flex items-center gap-3 px-4 py-3">
                <input
                  type="checkbox"
                  name="contactIds"
                  value={r.contact?.id ?? ""}
                  disabled={!canSend}
                  defaultChecked={canSend && filter === "unsent"}
                  className="h-4 w-4 accent-emerald-600 disabled:cursor-not-allowed disabled:opacity-30"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{r.artist.name}</span>
                    {r.topSignal && (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200">
                        {rankLabel(r.topSignal.source, r.topSignal.rank)}
                      </span>
                    )}
                    {r.genres.slice(0, 2).map((g) => (
                      <span key={g} className="rounded-full border border-zinc-200 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
                        {g}
                      </span>
                    ))}
                  </div>
                  {r.contact ? (
                    <p className="mt-0.5 truncate text-xs text-zinc-500">
                      {r.contact.name ? `${r.contact.name} · ` : ""}{r.contact.email}
                      {r.contact.customPrice ? ` · ${r.contact.customPrice}` : ""}
                      {r.outreach?.status === "sent" && " · already sent"}
                      {r.outreach?.status === "test" && " · test sent (sendable)"}
                    </p>
                  ) : (
                    <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-400">
                      No contact · <Link href={`/dashboard/add-contact/${r.artist.id}`} className="underline">add one</Link>
                    </p>
                  )}
                </div>
                {r.contact && (
                  <Link href={`/dashboard/customize/${showId}/${r.contact.id}`} className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900">
                    Customize
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      </form>
    </main>
  );
}
