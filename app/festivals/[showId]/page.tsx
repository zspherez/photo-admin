import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { sendOutreach } from "@/lib/sendOutreach";
import { getTestOverride } from "@/lib/resend";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button, LinkButton } from "@/components/ui/button";
import { ArtistLink } from "@/components/artist-modal";
import { cn } from "@/lib/cn";

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

  const filterOptions: { key: string; label: string }[] = [
    { key: "all", label: "All" },
    { key: "matched", label: "Matched" },
    { key: "matched_with_contact", label: "Matched + contact" },
    { key: "needs_contact", label: "Needs contact" },
    { key: "unsent", label: "Unsent" },
  ];

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <Link href="/festivals" className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">← All festivals</Link>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{festival.eventName || festival.venueName}</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {festival.date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
            {" · "}{festival.venueName}{festival.state ? `, ${festival.state}` : ""}
            {festival.ticketUrl && (
              <> · <a href={festival.ticketUrl} target="_blank" rel="noopener noreferrer" className="text-zinc-700 hover:underline dark:text-zinc-300">EDMTrain ↗</a></>
            )}
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {testOverride && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            Test override active — sends route to <b>{testOverride}</b>. Outreach rows stored as <code>status=test</code>.
          </div>
        )}
        {(sp.sent || sp.failed || sp.skipped) && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
            Bulk send: {sp.sent || 0} sent, {sp.failed || 0} failed, {sp.skipped || 0} skipped.
            {sp.errors && <span className="ml-2 text-red-700 dark:text-red-300">{sp.errors}</span>}
          </div>
        )}
      </div>

      <Card className="mt-6 p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Filter</span>
          {filterOptions.map((opt) => (
            <Link
              key={opt.key}
              href={`/festivals/${showId}${opt.key === "all" ? "" : `?filter=${opt.key}`}`}
              className={cn(
                "rounded-full px-2.5 py-0.5 text-xs font-medium transition",
                filter === opt.key
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "border border-zinc-200 text-zinc-600 hover:border-zinc-300 hover:text-zinc-900 dark:border-zinc-800 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-zinc-100"
              )}
            >
              {opt.label}
            </Link>
          ))}
        </div>
      </Card>

      <form action={bulkSend} className="mt-6">
        <input type="hidden" name="showId" value={showId} />

        <div className="sticky top-12 z-20 -mx-1 mb-3 flex items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-white/95 px-4 py-2 shadow-sm backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95">
          <span className="text-sm text-zinc-600 dark:text-zinc-400">
            {filtered.length} shown · <b>{eligibleSendCount}</b> sendable
          </span>
          <Button type="submit" variant="primary" size="md" disabled={eligibleSendCount === 0}>
            Send to selected
          </Button>
        </div>

        <Card>
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
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
                    className="h-4 w-4 accent-zinc-900 disabled:cursor-not-allowed disabled:opacity-30 dark:accent-zinc-100"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <ArtistLink artistId={r.artist.id} className="text-sm font-medium">
                        {r.artist.name}
                      </ArtistLink>
                      {r.topSignal && (
                        <Badge tone="success">{rankLabel(r.topSignal.source, r.topSignal.rank)}</Badge>
                      )}
                      {r.genres.slice(0, 2).map((g) => (
                        <Badge key={g} tone="muted" size="xs">{g}</Badge>
                      ))}
                      {r.contact?.isFullTeam && <Badge tone="accent">Full team</Badge>}
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
                        No contact ·{" "}
                        <Link href={`/dashboard/add-contact/${r.artist.id}`} className="underline">add one</Link>
                      </p>
                    )}
                  </div>
                  {r.contact && (
                    <LinkButton href={`/dashboard/customize/${showId}/${r.contact.id}`} variant="secondary" size="sm">
                      Customize
                    </LinkButton>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      </form>
    </main>
  );
}
