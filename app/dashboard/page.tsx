import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  DEFAULT_FILTERS,
  getMatchedUpcomingShows,
  type ContactFilter,
  type MatchFilters,
  type MatchedShow,
  type RangeFilter,
  type SourceFilter,
  type StatusFilter,
} from "@/lib/match";
import { db } from "@/lib/db";
import { sendOutreach } from "@/lib/sendOutreach";
import { getTestOverride, getRateCardInfo } from "@/lib/resend";

export const dynamic = "force-dynamic";

async function sendNow(formData: FormData) {
  "use server";
  const showId = formData.get("showId") as string;
  const contactId = formData.get("contactId") as string;
  const result = await sendOutreach({ showId, contactId });
  revalidatePath("/dashboard");
  if (result.ok) {
    redirect(`/dashboard?sent=${encodeURIComponent(contactId)}`);
  } else {
    redirect(`/dashboard?error=${encodeURIComponent(result.error ?? "unknown")}`);
  }
}

function formatRankLabel(source: string, rank: number | null): string {
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
  const niceSource = map[source] ?? source;
  return rank ? `${niceSource} #${rank}` : niceSource;
}

function statusBadge(status: string, opened: boolean, clicked: boolean): string {
  if (clicked) return "Clicked";
  if (opened) return "Opened";
  if (status === "sent") return "Sent";
  if (status === "failed") return "Failed";
  return status;
}

function parseFilters(sp: Record<string, string | undefined>): MatchFilters {
  const r = sp.range as RangeFilter | undefined;
  const s = sp.src as SourceFilter | undefined;
  const c = sp.contact as ContactFilter | undefined;
  const st = sp.status as StatusFilter | undefined;
  return {
    range: r === "7d" || r === "30d" || r === "90d" ? r : DEFAULT_FILTERS.range,
    source: s === "statsfm" || s === "spotify" || s === "any" ? s : DEFAULT_FILTERS.source,
    contact: c === "has" || c === "needs" || c === "any" ? c : DEFAULT_FILTERS.contact,
    status:
      st === "unsent" || st === "sent" || st === "opened" || st === "clicked" || st === "any"
        ? st
        : DEFAULT_FILTERS.status,
    search: (sp.search ?? "").trim(),
  };
}

function buildHref(filters: MatchFilters, override: Partial<MatchFilters>): string {
  const merged = { ...filters, ...override };
  const sp = new URLSearchParams();
  if (merged.range !== DEFAULT_FILTERS.range) sp.set("range", merged.range);
  if (merged.source !== DEFAULT_FILTERS.source) sp.set("src", merged.source);
  if (merged.contact !== DEFAULT_FILTERS.contact) sp.set("contact", merged.contact);
  if (merged.status !== DEFAULT_FILTERS.status) sp.set("status", merged.status);
  if (merged.search) sp.set("search", merged.search);
  const qs = sp.toString();
  return qs ? `/dashboard?${qs}` : "/dashboard";
}

function FilterChip({
  active,
  href,
  label,
}: {
  active: boolean;
  href: string;
  label: string;
}) {
  return (
    <Link
      href={href}
      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
        active
          ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
          : "border border-zinc-300 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
      }`}
    >
      {label}
    </Link>
  );
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{
    sent?: string;
    error?: string;
    added?: string;
    range?: string;
    src?: string;
    contact?: string;
    status?: string;
    search?: string;
  }>;
}) {
  const sp = await searchParams;
  const testOverride = getTestOverride();
  const rateCard = getRateCardInfo();
  const filters = parseFilters(sp);

  const [matched, totalShows, totalSignals] = await Promise.all([
    getMatchedUpcomingShows(filters),
    db.show.count({ where: { date: { gte: new Date() } } }),
    db.listenSignal.count(),
  ]);

  const filterGroups: { label: string; options: { key: keyof MatchFilters; value: string; label: string }[] }[] = [
    {
      label: "Range",
      options: [
        { key: "range", value: "7d", label: "7d" },
        { key: "range", value: "30d", label: "30d" },
        { key: "range", value: "90d", label: "90d" },
      ],
    },
    {
      label: "Source",
      options: [
        { key: "source", value: "any", label: "Any" },
        { key: "source", value: "statsfm", label: "Stats.fm" },
        { key: "source", value: "spotify", label: "Spotify" },
      ],
    },
    {
      label: "Contact",
      options: [
        { key: "contact", value: "any", label: "Any" },
        { key: "contact", value: "has", label: "Has contact" },
        { key: "contact", value: "needs", label: "Needs contact" },
      ],
    },
    {
      label: "Status",
      options: [
        { key: "status", value: "any", label: "Any" },
        { key: "status", value: "unsent", label: "Unsent" },
        { key: "status", value: "sent", label: "Sent" },
        { key: "status", value: "opened", label: "Opened" },
        { key: "status", value: "clicked", label: "Clicked" },
      ],
    },
  ];

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/" className="text-sm text-blue-600 hover:underline">← Home</Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Matched upcoming shows</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {matched.length} matched · {totalShows} total upcoming · {totalSignals} listen signals
          </p>
        </div>
        <div className="flex gap-2 text-sm">
          <Link href="/shows" className="rounded-md border border-zinc-300 px-3 py-1.5 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900">All shows</Link>
          <Link href="/settings" className="rounded-md border border-zinc-300 px-3 py-1.5 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900">Settings</Link>
        </div>
      </div>

      {testOverride && (
        <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          Test override active — all sends go to <b>{testOverride}</b> (subject prefixed with <code>[TEST → original]</code>). Unset <code>SEND_TEST_OVERRIDE</code> in <code>.env</code> to send to real contacts.
        </div>
      )}
      {rateCard && !rateCard.exists && (
        <div className="mt-4 rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-200">
          <code>RATE_CARD_PATH</code> set to <code>{rateCard.source}</code> but the file doesn&apos;t exist. Sends will go without the attachment.
        </div>
      )}
      {rateCard && rateCard.exists && (
        <p className="mt-2 text-xs text-zinc-500">
          Attaching <code>{rateCard.filename}</code> ({rateCard.kind === "url" ? "fetched per send from your site" : "local file"}) to every send.
        </p>
      )}
      {sp.sent && (
        <div className="mt-4 rounded-md border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-200">
          Email sent.
        </div>
      )}
      {sp.added && (
        <div className="mt-4 rounded-md border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-200">
          Contact saved.
        </div>
      )}
      {sp.error && (
        <div className="mt-4 rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-200">
          Send failed: {sp.error}
        </div>
      )}

      <section className="mt-6 space-y-2">
        <form className="flex gap-2" action="/dashboard" method="get">
          {filters.range !== DEFAULT_FILTERS.range && <input type="hidden" name="range" value={filters.range} />}
          {filters.source !== DEFAULT_FILTERS.source && <input type="hidden" name="src" value={filters.source} />}
          {filters.contact !== DEFAULT_FILTERS.contact && <input type="hidden" name="contact" value={filters.contact} />}
          {filters.status !== DEFAULT_FILTERS.status && <input type="hidden" name="status" value={filters.status} />}
          <input
            type="text"
            name="search"
            defaultValue={filters.search}
            placeholder="Search artist name…"
            className="w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <button type="submit" className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900">
            Search
          </button>
          {(filters.search ||
            filters.range !== DEFAULT_FILTERS.range ||
            filters.source !== DEFAULT_FILTERS.source ||
            filters.contact !== DEFAULT_FILTERS.contact ||
            filters.status !== DEFAULT_FILTERS.status) && (
            <Link
              href="/dashboard"
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              Clear
            </Link>
          )}
        </form>
        {filterGroups.map((group) => (
          <div key={group.label} className="flex flex-wrap items-center gap-2">
            <span className="w-16 text-xs font-medium uppercase tracking-wide text-zinc-500">{group.label}</span>
            {group.options.map((opt) => (
              <FilterChip
                key={opt.value}
                active={filters[opt.key] === opt.value}
                href={buildHref(filters, { [opt.key]: opt.value } as Partial<MatchFilters>)}
                label={opt.label}
              />
            ))}
          </div>
        ))}
      </section>

      {matched.length === 0 ? (
        <div className="mt-10 rounded-lg border border-dashed border-zinc-300 p-10 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No matched shows for this filter. Try widening the range or clearing the search.
        </div>
      ) : (
        <ul className="mt-6 space-y-3">
          {matched.map((show: MatchedShow) => (
            <li key={show.id} className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
              <p className="text-sm font-medium text-zinc-500">
                {show.date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
                {" · "}{show.venueName}{show.state ? `, ${show.state}` : ""}
                {show.ticketUrl && (
                  <> · <a href={show.ticketUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">EDMTrain ↗</a></>
                )}
              </p>
              <div className="mt-3 space-y-2.5">
                {show.matchedArtists.map((a) => {
                  const contact = a.contacts[0] ?? null;
                  const outreach = contact ? show.outreach.find((o) => o.contactId === contact.id) : undefined;
                  const alreadySent = outreach?.status === "sent";
                  return (
                    <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-100 px-3 py-2 dark:border-zinc-800">
                      <div className="flex flex-wrap items-center gap-2 min-w-0">
                        <span className="font-medium">{a.name}</span>
                        {a.topSignal && (
                          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200">
                            {formatRankLabel(a.topSignal.source, a.topSignal.rank)}
                          </span>
                        )}
                        {a.playlists.slice(0, 3).map((pl) => (
                          <a
                            key={pl.spotifyId}
                            href={pl.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={`In your Spotify playlist "${pl.name}"`}
                            className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 hover:bg-green-200 dark:bg-green-950 dark:text-green-300 dark:hover:bg-green-900"
                          >
                            ♪ {pl.name} ↗
                          </a>
                        ))}
                        {a.playlists.length > 3 && (
                          <span className="text-[10px] text-zinc-500">+{a.playlists.length - 3} more</span>
                        )}
                        {a.genres.slice(0, 2).map((g) => (
                          <span
                            key={g}
                            className="rounded-full border border-zinc-200 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
                          >
                            {g}
                          </span>
                        ))}
                        {contact && (
                          <Link
                            href={`/dashboard/contact/${contact.id}`}
                            className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                            title={`${contact.name ?? ""} <${contact.email}>${contact.role ? ` · ${contact.role}` : ""}`}
                          >
                            {contact.customPrice ?? "edit contact"}
                          </Link>
                        )}
                        {!contact && (
                          <Link
                            href={`/dashboard/add-contact/${a.id}`}
                            className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-200 dark:bg-amber-900 dark:text-amber-200 dark:hover:bg-amber-800"
                          >
                            + Add contact
                          </Link>
                        )}
                        {outreach && (
                          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                            outreach.clickCount > 0 ? "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"
                            : outreach.openCount > 0 ? "bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200"
                            : outreach.status === "failed" ? "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
                            : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                          }`}>
                            {statusBadge(outreach.status, outreach.openCount > 0, outreach.clickCount > 0)}
                          </span>
                        )}
                      </div>
                      {contact && (
                        <div className="flex shrink-0 gap-2">
                          <form action={sendNow}>
                            <input type="hidden" name="showId" value={show.id} />
                            <input type="hidden" name="contactId" value={contact.id} />
                            <button
                              type="submit"
                              disabled={alreadySent}
                              className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {alreadySent ? "Sent" : "Send"}
                            </button>
                          </form>
                          <Link
                            href={`/dashboard/customize/${show.id}/${contact.id}`}
                            className="rounded-md border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                          >
                            Customize
                          </Link>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {show.otherArtists.length > 0 && (
                <p className="mt-2 text-xs text-zinc-400">
                  + {show.otherArtists.map((a) => a.name).join(", ")}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
