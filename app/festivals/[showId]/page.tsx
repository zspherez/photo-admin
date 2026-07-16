import type { Metadata } from "next";
import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cache } from "react";
import { db } from "@/lib/db";
import {
  getOutreachSendabilityBatch,
  sendOutreach,
  scheduleOutreach,
  type OutreachSendability,
} from "@/lib/sendOutreach";
import { getTestOverride } from "@/lib/resend";
import { isWeekendET, getNextMondaySlot } from "@/lib/schedule";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { ArtistLink } from "@/components/artist-modal";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { cn } from "@/lib/cn";
import { pickEmailContact } from "@/lib/contactSelection";
import { formatShowDate } from "@/lib/formatDate";
import { mapWithConcurrency } from "@/lib/integrationUtils";
import {
  appendWorkflowResult,
  festivalReturnPath,
  parseFestivalFilter,
  parseFestivalGenre,
  type FestivalFilter,
} from "@/lib/dashboardReturnUrl";
import { withWorkflowReturnTo } from "@/lib/workflowLinks";
import {
  firstSearchParam,
  type SearchParamValue,
} from "@/lib/searchParams";
import { isCancellableOutreachStatus } from "@/lib/outreachStatus";
import {
  formatRankLabel,
  pickTopListenSignal,
} from "@/lib/listenSignal";
import { cancelScheduledAction } from "@/app/dashboard/actions";
import { requireServerActionAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BULK_SEND_CONCURRENCY = 4;

const getFestivalDetails = cache(async (showId: string) =>
  db.show.findUnique({
    where: { id: showId },
    select: {
      id: true,
      date: true,
      venueName: true,
      state: true,
      ticketUrl: true,
      isFestival: true,
      eventName: true,
      syncStatus: true,
      artists: {
        select: {
          artist: {
            select: {
              id: true,
              name: true,
              genres: true,
              listenSignals: {
                select: {
                  source: true,
                  rank: true,
                  expiresAt: true,
                },
              },
              contacts: {
                where: { state: "active" },
                orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
                select: {
                  id: true,
                  email: true,
                  phone: true,
                  name: true,
                  customPrice: true,
                  state: true,
                  isFullTeam: true,
                },
              },
            },
          },
        },
      },
    },
  }),
);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ showId: string }>;
}): Promise<Metadata> {
  const { showId } = await params;
  const festival = await getFestivalDetails(showId);
  return {
    title:
      festival?.isFestival
        ? festival.eventName || festival.venueName
        : "Festival",
  };
}

function bulkResultHref(
  showId: string,
  filter: FestivalFilter,
  genre: string,
  results: Record<string, string>
): string {
  return appendWorkflowResult(
    festivalReturnPath(showId, filter, genre),
    results
  );
}

function sendabilityLabel(
  sendability: OutreachSendability | null,
  hasTestSend: boolean
): string | null {
  if (!sendability) return null;
  if (sendability.sendable) {
    if (sendability.mode === "retry") return "retry ready";
    return hasTestSend ? "test sent (sendable)" : null;
  }
  if (sendability.blockingStatus === "sent") return "already sent";
  if (sendability.blockingStatus === "scheduled") return "already scheduled";
  if (sendability.blockingStatus === "retry_scheduled") {
    return sendability.blockingNextAttemptAt
      ? `retry scheduled · ${sendability.blockingNextAttemptAt.toLocaleString(
          "en-US",
          {
            timeZone: "America/New_York",
            weekday: "short",
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          },
        )}`
      : "retry scheduled";
  }
  if (sendability.blockingStatus === "queued") return "send in progress";
  if (sendability.blockingStatus === "manual_review") {
    return "manual review required";
  }
  return sendability.reason;
}

async function festivalBulkCandidates(
  showId: string,
  now: Date
): Promise<{ active: boolean; contactIds: Set<string> } | null> {
  const festival = await db.show.findUnique({
    where: { id: showId },
    select: {
      isFestival: true,
      syncStatus: true,
      artists: {
        select: {
          artist: {
            select: {
              listenSignals: {
                select: { source: true, rank: true, expiresAt: true },
              },
              contacts: {
                where: { state: "active" },
                orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
                select: {
                  id: true,
                  email: true,
                  phone: true,
                  state: true,
                  isFullTeam: true,
                },
              },
            },
          },
        },
      },
    },
  });
  if (!festival?.isFestival) return null;

  const contactIds = new Set<string>();
  if (festival.syncStatus === "active") {
    for (const { artist } of festival.artists) {
      if (!pickTopListenSignal(artist.listenSignals, now)) continue;
      const contact = pickEmailContact(artist.contacts);
      if (contact) contactIds.add(contact.id);
    }
  }
  return {
    active: festival.syncStatus === "active",
    contactIds,
  };
}

async function bulkSend(formData: FormData) {
  "use server";
  await requireServerActionAuth(formData.get("returnTo") ?? "/festivals");
  const showId = String(formData.get("showId") ?? "").trim();
  const filter = parseFestivalFilter(formData.get("filter"));
  const genre = parseFestivalGenre(formData.get("genre"));
  if (!showId) {
    redirect("/festivals");
  }

  const requestedContactIds = Array.from(
    new Set(
      formData
        .getAll("contactIds")
        .map((value) => String(value).trim())
        .filter(Boolean)
    )
  );
  const now = new Date();
  const candidates = await festivalBulkCandidates(showId, now);
  if (!candidates) {
    redirect("/festivals");
  }
  if (!candidates.active) {
    redirect(
      bulkResultHref(showId, filter, genre, { error: "inactive_show" })
    );
  }

  const candidateIds = requestedContactIds.filter((contactId) =>
    candidates.contactIds.has(contactId)
  );
  const sendability = await getOutreachSendabilityBatch(
    candidateIds.map((contactId) => ({ showId, contactId })),
    now
  );
  const contactIds = sendability
    .filter((result) => result.sendable)
    .map((result) => result.contactId);
  const weekend = isWeekendET();
  const scheduledFor = weekend ? getNextMondaySlot() : null;
  let sent = 0;
  let scheduled = 0;
  let failed = 0;
  let skipped = requestedContactIds.length - contactIds.length;
  const errors: string[] = [];
  if (requestedContactIds.length === 0) {
    errors.push("Select at least one eligible artist");
  } else if (skipped > 0) {
    const rejectedIds = new Set(contactIds);
    for (const contactId of requestedContactIds) {
      if (rejectedIds.has(contactId)) continue;
      const result = sendability.find((row) => row.contactId === contactId);
      errors.push(
        `${contactId.slice(-6)}: ${
          result?.reason ?? "Selected contact is no longer eligible"
        }`
      );
    }
  }

  const results = await mapWithConcurrency(
    contactIds,
    BULK_SEND_CONCURRENCY,
    async (contactId) => {
      try {
        const result = scheduledFor
          ? await scheduleOutreach({ showId, contactId }, scheduledFor)
          : await sendOutreach({ showId, contactId });
        return { contactId, result };
      } catch (error) {
        return {
          contactId,
          result: {
            ok: false,
            error: error instanceof Error ? error.message : "Unexpected send error",
          },
        };
      }
    }
  );

  for (const { contactId, result } of results) {
    if (result.ok) {
      if (result.scheduled === true) scheduled++;
      else sent++;
    } else if (result.error?.includes("Already sent") || result.error?.includes("Already scheduled")) {
      skipped++;
    } else {
      failed++;
      errors.push(`${contactId.slice(-6)}: ${result.error ?? "Unknown send failure"}`);
    }
  }
  revalidatePath(`/festivals/${showId}`);
  const resultParams: Record<string, string> = {
    bulk: "1",
    sent: String(sent),
    scheduled: String(scheduled),
    failed: String(failed),
    skipped: String(skipped),
  };
  if (errors.length) {
    resultParams.errors = errors.slice(0, 5).join(" | ");
    if (errors.length > 5) {
      resultParams.moreErrors = String(errors.length - 5);
    }
  }
  redirect(bulkResultHref(showId, filter, genre, resultParams));
}

export default async function FestivalDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ showId: string }>;
  searchParams: Promise<{
    sent?: SearchParamValue;
    scheduled?: SearchParamValue;
    failed?: SearchParamValue;
    skipped?: SearchParamValue;
    errors?: SearchParamValue;
    moreErrors?: SearchParamValue;
    error?: SearchParamValue;
    added?: SearchParamValue;
    updated?: SearchParamValue;
    deleted?: SearchParamValue;
    sheet_errors?: SearchParamValue;
    cancelled?: SearchParamValue;
    bulk?: SearchParamValue;
    filter?: SearchParamValue;
    genre?: SearchParamValue;
  }>;
}) {
  const { showId } = await params;
  const sp = await searchParams;
  const filter = parseFestivalFilter(sp.filter);
  const genreFilter = parseFestivalGenre(sp.genre);
  const notices = {
    sent: firstSearchParam(sp.sent),
    scheduled: firstSearchParam(sp.scheduled),
    failed: firstSearchParam(sp.failed),
    skipped: firstSearchParam(sp.skipped),
    errors: firstSearchParam(sp.errors),
    moreErrors: firstSearchParam(sp.moreErrors),
    error: firstSearchParam(sp.error),
    added: firstSearchParam(sp.added),
    updated: firstSearchParam(sp.updated),
    deleted: firstSearchParam(sp.deleted),
    sheetErrors: firstSearchParam(sp.sheet_errors),
    cancelled: firstSearchParam(sp.cancelled),
    bulk: firstSearchParam(sp.bulk),
  };
  const now = new Date();
  const weekend = isWeekendET();
  const returnTo = festivalReturnPath(showId, filter, genreFilter);
  const [testOverride, festival] = await Promise.all([
    getTestOverride(),
    getFestivalDetails(showId),
  ]);
  if (!festival || !festival.isFestival) return notFound();
  const festivalActive = festival.syncStatus === "active";

  const baseRows = festival.artists.map((sa) => {
    const a = sa.artist;
    const topSignal = pickTopListenSignal(a.listenSignals, now);
    const matched = topSignal !== null;
    const contact = pickEmailContact(a.contacts);
    const genres: string[] = (() => {
      try {
        return a.genres ? (JSON.parse(a.genres) as string[]).filter((g) => typeof g === "string") : [];
      } catch {
        return [];
      }
    })();
    return {
      artist: a,
      topSignal,
      matched,
      contact,
      hasAnyContact: a.contacts.length > 0,
      genres,
    };
  });
  const contactIds = baseRows.flatMap((row) =>
    row.contact ? [row.contact.id] : []
  );
  const [sendabilityResults, testOutreaches] = await Promise.all([
    getOutreachSendabilityBatch(
      contactIds.map((contactId) => ({ showId, contactId })),
      now
    ),
    contactIds.length === 0
      ? Promise.resolve([])
      : db.outreach.findMany({
          where: {
            showId,
            contactId: { in: contactIds },
            status: "test",
          },
          select: { contactId: true },
        }),
  ]);
  const sendabilityByContact = new Map(
    sendabilityResults.map((result) => [result.contactId, result])
  );
  const testContactIds = new Set(
    testOutreaches.flatMap((outreach) =>
      outreach.contactId ? [outreach.contactId] : []
    )
  );
  const rows = baseRows.map((row) => ({
    ...row,
    sendability: row.contact
      ? (sendabilityByContact.get(row.contact.id) ?? null)
      : null,
    hasTestSend: row.contact ? testContactIds.has(row.contact.id) : false,
  }));

  const allGenres = Array.from(
    new Set(rows.flatMap((r) => r.genres.map((g) => g.toLowerCase())))
  ).sort();

  const filtered = rows.filter((r) => {
    if (filter === "matched" && !r.matched) return false;
    if (filter === "matched_with_contact" && !(r.matched && !!r.contact)) return false;
    if (filter === "needs_contact" && !(r.matched && !r.contact)) return false;
    if (
      filter === "unsent" &&
      !(r.matched && r.sendability?.sendable)
    ) {
      return false;
    }
    if (genreFilter !== "all" && !r.genres.some((g) => g.toLowerCase() === genreFilter)) return false;
    return true;
  });

  const eligibleSendCount = filtered.filter(
    (r) =>
      r.matched &&
      r.sendability?.sendable
  ).length;
  const bulkFormId = "festival-bulk-outreach";

  const filterOptions: { key: FestivalFilter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "matched", label: "Matched" },
    { key: "matched_with_contact", label: "Matched + email" },
    { key: "needs_contact", label: "Needs email" },
    { key: "unsent", label: "Unsent" },
  ];

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <Link href="/festivals" className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">← All festivals</Link>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{festival.eventName || festival.venueName}</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {formatShowDate(festival.date, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
            {" · "}{festival.venueName}{festival.state ? `, ${festival.state}` : ""}
            {festival.ticketUrl && (
              <> · <a href={festival.ticketUrl} target="_blank" rel="noopener noreferrer" className="text-zinc-700 hover:underline dark:text-zinc-300">EDMTrain ↗</a></>
            )}
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {!festivalActive && (
          <div
            role="alert"
            className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
          >
            This festival is inactive. Outreach controls are disabled.
          </div>
        )}
        {notices.error === "inactive_show" && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
          >
            This festival became inactive before outreach started. Nothing was
            sent.
          </div>
        )}
        {notices.error && notices.error !== "inactive_show" && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
          >
            Action failed: {notices.error}
          </div>
        )}
        {testOverride && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            Test override active — sends route to <b>{testOverride}</b>. Outreach rows stored as <code>status=test</code>.
          </div>
        )}
        {notices.bulk &&
          (notices.sent ||
            notices.scheduled ||
            notices.failed ||
            notices.skipped) && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
            Bulk send: {notices.sent || 0} sent, {notices.scheduled || 0} scheduled, {notices.failed || 0} failed, {notices.skipped || 0} skipped.
          </div>
        )}
        {!notices.bulk && notices.sent && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
            Email sent.
          </div>
        )}
        {!notices.bulk && notices.scheduled && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
            Email scheduled for Monday morning.
          </div>
        )}
        {notices.errors && (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
            {notices.errors}
            {notices.moreErrors && ` | ${notices.moreErrors} more error${notices.moreErrors === "1" ? "" : "s"}`}
          </div>
        )}
        {(notices.added || notices.updated || notices.deleted) && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
            {notices.deleted
              ? "Contact deleted."
              : `${notices.added ?? 0} contact${notices.added === "1" ? "" : "s"} added${
                  notices.updated
                    ? `, ${notices.updated} updated`
                    : ""
                }.`}
          </div>
        )}
        {notices.sheetErrors && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            Contact saved; Sheet sync had errors: {notices.sheetErrors}
          </div>
        )}
        {notices.cancelled && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
            Scheduled send or retry cancelled.
          </div>
        )}
      </div>

      <Card className="mt-6 space-y-2 p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 w-12 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Filter</span>
          {filterOptions.map((opt) => {
            return (
              <Link
                key={opt.key}
                href={festivalReturnPath(showId, opt.key, genreFilter)}
                className={cn(
                  "rounded-full px-2.5 py-0.5 text-xs font-medium transition",
                  filter === opt.key
                    ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                    : "border border-zinc-200 text-zinc-600 hover:border-zinc-300 hover:text-zinc-900 dark:border-zinc-800 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-zinc-100"
                )}
              >
                {opt.label}
              </Link>
            );
          })}
        </div>
        {allGenres.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 w-12 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Genre</span>
            {(["all", ...allGenres] as const).map((g) => {
              return (
                <Link
                  key={g}
                  href={festivalReturnPath(showId, filter, g)}
                  className={cn(
                    "rounded-full px-2.5 py-0.5 text-xs font-medium transition",
                    genreFilter === g
                      ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                      : "border border-zinc-200 text-zinc-600 hover:border-zinc-300 hover:text-zinc-900 dark:border-zinc-800 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-zinc-100"
                  )}
                >
                  {g === "all" ? "Any" : g}
                </Link>
              );
            })}
          </div>
        )}
      </Card>

      <form
        id={bulkFormId}
        action={bulkSend}
        className="mt-6"
        aria-label="Bulk festival outreach"
      >
        <input type="hidden" name="showId" value={showId} />
        <input type="hidden" name="filter" value={filter} />
        <input type="hidden" name="genre" value={genreFilter} />
        <input type="hidden" name="returnTo" value={returnTo} />

        <div className="z-20 -mx-1 mb-3 flex items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-white/95 px-4 py-2 shadow-sm backdrop-blur sm:sticky sm:top-12 dark:border-zinc-800 dark:bg-zinc-950/95">
          <span className="text-sm text-zinc-600 dark:text-zinc-400">
            {filtered.length} shown · <b>{eligibleSendCount}</b> sendable
          </span>
          {festivalActive ? (
            <PendingSubmitButton
              variant="primary"
              size="md"
              disabled={eligibleSendCount === 0}
              pendingLabel={weekend ? "Scheduling selected…" : "Sending selected…"}
            >
              Send to selected
            </PendingSubmitButton>
          ) : (
            <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
              Outreach disabled
            </span>
          )}
        </div>
      </form>

      <Card>
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
          {filtered.map((r) => {
              const canSend =
                r.matched &&
                r.sendability?.sendable === true;
              const checkboxId = `festival-outreach-${r.artist.id}`;
              const reasonId = `${checkboxId}-reason`;
              const disabledReason = !r.matched
                ? "No active listen signal"
                : !r.contact
                  ? "No email contact"
                  : r.sendability?.reason ?? "Outreach is unavailable";
              const statusLabel = sendabilityLabel(
                r.sendability,
                r.hasTestSend
              );
              const displayStatus =
                statusLabel ?? (!canSend ? disabledReason : null);
              return (
                <li key={r.artist.id} className="flex items-center gap-3 px-4 py-3">
                  <input
                    id={checkboxId}
                    type="checkbox"
                    name="contactIds"
                    form={bulkFormId}
                    value={r.contact?.id ?? ""}
                    disabled={!canSend}
                    defaultChecked={canSend && filter === "unsent"}
                    aria-describedby={!canSend ? reasonId : undefined}
                    className="h-4 w-4 accent-zinc-900 disabled:cursor-not-allowed disabled:opacity-30 dark:accent-zinc-100"
                  />
                  <label htmlFor={checkboxId} className="sr-only">
                    Select {r.artist.name} for outreach
                  </label>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <ArtistLink
                        artistId={r.artist.id}
                        returnTo={returnTo}
                        className="text-sm font-medium"
                      >
                        {r.artist.name}
                      </ArtistLink>
                      {r.topSignal && (
                        <Badge tone="success">
                          {formatRankLabel(
                            r.topSignal.source,
                            r.topSignal.rank
                          )}
                        </Badge>
                      )}
                      {r.genres.slice(0, 2).map((g) => (
                        <Badge key={g} tone="muted" size="xs">{g}</Badge>
                      ))}
                      {r.contact?.isFullTeam && <Badge tone="accent">Full team</Badge>}
                    </div>
                    {r.contact ? (
                      <p
                        id={!canSend ? reasonId : undefined}
                        className="mt-0.5 truncate text-xs text-zinc-500"
                        title={!canSend ? disabledReason : undefined}
                      >
                        {r.contact.name ? `${r.contact.name} · ` : ""}{r.contact.email}
                        {r.contact.customPrice ? ` · ${r.contact.customPrice}` : ""}
                        {displayStatus && ` · ${displayStatus}`}
                      </p>
                    ) : (
                      <p
                        id={reasonId}
                        className="mt-0.5 text-xs text-amber-700 dark:text-amber-400"
                      >
                        No email contact ·{" "}
                        <Link
                          href={
                            r.hasAnyContact
                              ? withWorkflowReturnTo(
                                  `/artists/${r.artist.id}`,
                                  returnTo
                                )
                              : withWorkflowReturnTo(
                                  `/dashboard/add-contact/${r.artist.id}`,
                                  returnTo
                                )
                          }
                          className="underline"
                        >
                          {r.hasAnyContact ? "review contacts" : "add one"}
                        </Link>
                      </p>
                    )}
                  </div>
                  {canSend &&
                    r.contact &&
                    r.sendability?.mode !== "retry" && (
                    <LinkButton
                      href={withWorkflowReturnTo(
                        `/dashboard/customize/${showId}/${r.contact.id}`,
                        returnTo
                      )}
                      variant="secondary"
                      size="sm"
                    >
                      Customize
                    </LinkButton>
                  )}
                  {isCancellableOutreachStatus(
                    r.sendability?.blockingStatus
                  ) &&
                    r.sendability.blockingOutreachId && (
                      <form action={cancelScheduledAction}>
                        <input
                          type="hidden"
                          name="outreachId"
                          value={r.sendability.blockingOutreachId}
                        />
                        <input
                          type="hidden"
                          name="returnTo"
                          value={returnTo}
                        />
                        <PendingSubmitButton
                          variant="danger"
                          size="sm"
                          pendingLabel="Cancelling…"
                          aria-label={`Cancel scheduled outreach for ${r.artist.name}`}
                        >
                          Cancel
                        </PendingSubmitButton>
                      </form>
                    )}
                </li>
              );
            })}
        </ul>
      </Card>
    </main>
  );
}
