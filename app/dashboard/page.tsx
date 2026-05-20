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
import { Card } from "@/components/ui/card";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button, LinkButton } from "@/components/ui/button";
import { cn } from "@/lib/cn";

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

interface OutreachState {
  status: string;
  sentAt: Date | null;
  deliveredAt: Date | null;
  openCount: number;
  clickCount: number;
}

function statusLabels(o: OutreachState): string[] {
  if (o.status === "failed") return ["Failed"];
  if (o.status === "queued") return ["Queued"];
  const labels: string[] = [];
  if (o.status === "test") labels.push("Test sent");
  else if (o.sentAt) labels.push("Sent");
  if (o.deliveredAt) labels.push("Delivered");
  if (o.openCount > 0) labels.push(o.openCount > 1 ? `Opened (${o.openCount})` : "Opened");
  if (o.clickCount > 0) labels.push(o.clickCount > 1 ? `Clicked (${o.clickCount})` : "Clicked");
  return labels.length > 0 ? labels : [o.status];
}

function statusTone(o: OutreachState): BadgeTone {
  if (o.status === "failed") return "danger";
  if (o.clickCount > 0) return "info";
  if (o.openCount > 0) return "info";
  if (o.deliveredAt) return "success";
  if (o.status === "test") return "warning";
  return "default";
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
      className={cn(
        "rounded-full px-2.5 py-0.5 text-xs font-medium transition",
        active
          ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
          : "border border-zinc-200 text-zinc-600 hover:border-zinc-300 hover:text-zinc-900 dark:border-zinc-800 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-zinc-100"
      )}
    >
      {label}
    </Link>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: "info" | "success" | "warning" | "danger";
  children: React.ReactNode;
}) {
  const toneClass: Record<typeof tone, string> = {
    info: "border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200",
    success: "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200",
    warning: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
    danger: "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200",
  };
  return (
    <div className={cn("rounded-lg border px-4 py-2 text-sm", toneClass[tone])}>{children}</div>
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

  const filtersDirty =
    filters.search ||
    filters.range !== DEFAULT_FILTERS.range ||
    filters.source !== DEFAULT_FILTERS.source ||
    filters.contact !== DEFAULT_FILTERS.contact ||
    filters.status !== DEFAULT_FILTERS.status;

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Matched shows</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {matched.length} matched · {totalShows} total upcoming · {totalSignals.toLocaleString()} listen signals
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {testOverride && (
          <Banner tone="warning">
            Test override active — all sends go to <b>{testOverride}</b>. Subject prefixed with <code>[TEST → original]</code>.
          </Banner>
        )}
        {rateCard && !rateCard.exists && (
          <Banner tone="danger">
            <code>RATE_CARD_PATH</code> set to <code>{rateCard.source}</code> but the file doesn&apos;t exist. Sends will go without the attachment.
          </Banner>
        )}
        {rateCard && rateCard.exists && (
          <p className="text-xs text-zinc-500">
            Attaching <code>{rateCard.filename}</code> ({rateCard.kind === "url" ? "fetched per send" : "local file"}) to every send.
          </p>
        )}
        {sp.sent && <Banner tone="success">Email sent.</Banner>}
        {sp.added && <Banner tone="success">Contact saved.</Banner>}
        {sp.error && <Banner tone="danger">Send failed: {sp.error}</Banner>}
      </div>

      <Card className="mt-6 p-4">
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
            className="h-9 flex-1 rounded-md border border-zinc-200 bg-white px-3 text-sm placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
          />
          <Button type="submit" variant="secondary" size="md">Search</Button>
          {filtersDirty && <LinkButton href="/dashboard" variant="ghost" size="md">Clear</LinkButton>}
        </form>
        <div className="mt-3 space-y-2">
          {filterGroups.map((group) => (
            <div key={group.label} className="flex flex-wrap items-center gap-1.5">
              <span className="w-16 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{group.label}</span>
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
        </div>
      </Card>

      {matched.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-zinc-300 p-12 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No matched shows for this filter. Try widening the range or clearing the search.
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {matched.map((show: MatchedShow) => (
            <Card key={show.id} className="p-5">
                <p className="text-sm text-zinc-500">
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">
                    {show.date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
                  </span>
                  {" · "}{show.venueName}{show.state ? `, ${show.state}` : ""}
                  {show.ticketUrl && (
                    <> · <a href={show.ticketUrl} target="_blank" rel="noopener noreferrer" className="text-zinc-700 hover:underline dark:text-zinc-300">EDMTrain ↗</a></>
                  )}
                </p>
                <div className="mt-3 space-y-2">
                  {show.matchedArtists.map((a) => {
                    const contact = a.contacts[0] ?? null;
                    const outreach = contact ? show.outreach.find((o) => o.contactId === contact.id) : undefined;
                    const alreadySent = outreach?.status === "sent";
                    return (
                      <div
                        key={a.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-100 bg-zinc-50/50 px-3 py-2 dark:border-zinc-900 dark:bg-zinc-900/40"
                      >
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <span className="text-sm font-medium">{a.name}</span>
                          {a.topSignal && (
                            <Badge tone="success">
                              {formatRankLabel(a.topSignal.source, a.topSignal.rank)}
                            </Badge>
                          )}
                          {a.playlists.slice(0, 3).map((pl) => (
                            <a
                              key={pl.spotifyId}
                              href={pl.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={`In your Spotify playlist "${pl.name}"`}
                              className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200 transition hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900 dark:hover:bg-emerald-950"
                            >
                              ♪ {pl.name} ↗
                            </a>
                          ))}
                          {a.playlists.length > 3 && (
                            <span className="text-[10px] text-zinc-500">+{a.playlists.length - 3} more</span>
                          )}
                          {a.genres.slice(0, 2).map((g) => (
                            <Badge key={g} tone="muted" size="xs">{g}</Badge>
                          ))}
                          {contact && (
                            <>
                              <Link
                                href={`/dashboard/contact/${contact.id}`}
                                className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                                title={`${contact.name ?? ""} <${contact.email}>${contact.role ? ` · ${contact.role}` : ""}`}
                              >
                                {contact.customPrice ?? "edit"}
                              </Link>
                              {contact.isFullTeam && (
                                <Badge tone="accent" title="Email goes to the artist's full management team">Full team</Badge>
                              )}
                            </>
                          )}
                          {!contact && (
                            <Link
                              href={`/dashboard/add-contact/${a.id}`}
                              className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-200 transition hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900 dark:hover:bg-amber-950"
                            >
                              + Add contact
                            </Link>
                          )}
                          {outreach && (
                            <Badge tone={statusTone(outreach)}>
                              {statusLabels(outreach).join(" · ")}
                            </Badge>
                          )}
                        </div>
                        {contact && (
                          <div className="flex shrink-0 gap-1.5">
                            <form action={sendNow}>
                              <input type="hidden" name="showId" value={show.id} />
                              <input type="hidden" name="contactId" value={contact.id} />
                              <Button type="submit" variant="primary" size="sm" disabled={alreadySent}>
                                {alreadySent ? "Sent" : "Send"}
                              </Button>
                            </form>
                            <LinkButton href={`/dashboard/customize/${show.id}/${contact.id}`} variant="secondary" size="sm">
                              Customize
                            </LinkButton>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                {show.otherArtists.length > 0 && (
                  <p className="mt-3 truncate text-xs text-zinc-400">
                    + {show.otherArtists.map((a) => a.name).join(", ")}
                  </p>
                )}
            </Card>
          ))}
        </div>
      )}
    </main>
  );
}
