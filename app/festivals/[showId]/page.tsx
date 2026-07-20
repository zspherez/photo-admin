import type { Metadata } from "next";
import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { cache } from "react";
import { db } from "@/lib/db";
import {
  getOutreachSendabilityBatch,
  getFollowUpEligibilityBatch,
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
import { FollowUpButton } from "@/components/follow-up-button";
import { cn } from "@/lib/cn";
import {
  pickDirectOutreachContact,
  pickEmailContact,
  pickPhoneContact,
} from "@/lib/contactSelection";
import {
  contactDisplayValue,
  directOutreachNoteValue,
  hasDirectOutreachNote,
  isDirectOutreachOnly,
} from "@/lib/contactDisplay";
import { countryLabel } from "@/lib/country";
import { formatShowDate } from "@/lib/formatDate";
import { mapWithConcurrency } from "@/lib/integrationUtils";
import {
  appendWorkflowResult,
  festivalReturnPath,
  parseFestivalFilter,
  parseFestivalGenre,
  type FestivalFilter,
  workflowReturnPath,
} from "@/lib/dashboardReturnUrl";
import {
  festivalListPath,
  festivalGroupKey,
  parseFestivalListView,
  type FestivalListView,
} from "@/lib/festivalView";
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
import {
  cancelScheduledAction,
  dismissShowAction,
  markSentAction,
  restoreShowAction,
  sendFollowUpAction,
  unmarkSentAction,
} from "@/app/dashboard/actions";
import { requireServerActionAuth } from "@/lib/auth";
import { refreshWorkflowViews } from "@/lib/workflowRefresh";
import {
  canMarkOutreachManually,
  isActiveManualOutreachMarker,
} from "@/lib/manualOutreach";
import {
  enqueueFestivalManagerResearch,
  needsManagerContactResearch,
} from "@/lib/contactResearch";
import {
  activeFestivalWhere,
  satisfiesFestivalLeadTime,
} from "@/lib/festivalEligibility";

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
      city: true,
      state: true,
      countryCode: true,
      countryName: true,
      ticketUrl: true,
      isFestival: true,
      festivalNycStatus: true,
      eventName: true,
      syncStatus: true,
      dismissedAt: true,
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
                  directOutreachNote: true,
                  name: true,
                  role: true,
                  state: true,
                  isFullTeam: true,
                },
              },
            },
          },
        },
      },
      outreaches: {
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        select: {
          id: true,
          kind: true,
          parentOutreachId: true,
          artistId: true,
          status: true,
          providerMessageId: true,
          attemptCount: true,
          finalSubject: true,
          finalHtml: true,
          _count: { select: { sendAttempts: true } },
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
    description:
      festival?.isFestival
        ? `${festival.eventName || festival.venueName} in ${festival.city}, ${countryLabel(
            festival
          )}`
        : undefined,
  };
}

function bulkResultHref(
  showId: string,
  filter: FestivalFilter,
  genre: string,
  listView: FestivalListView,
  results: Record<string, string>
): string {
  return appendWorkflowResult(
    festivalReturnPath(showId, filter, genre, listView),
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
      date: true,
      festivalNycStatus: true,
      syncStatus: true,
      dismissedAt: true,
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
  if (
    festival.syncStatus === "active" &&
    satisfiesFestivalLeadTime(festival, now) &&
    festival.dismissedAt === null
  ) {
    for (const { artist } of festival.artists) {
      if (!pickTopListenSignal(artist.listenSignals, now)) continue;
      const contact = pickEmailContact(artist.contacts);
      if (contact) contactIds.add(contact.id);
    }
  }
  return {
    active:
      festival.syncStatus === "active" &&
      satisfiesFestivalLeadTime(festival, now) &&
      festival.dismissedAt === null,
    contactIds,
  };
}

async function bulkSend(formData: FormData) {
  "use server";
  await requireServerActionAuth(formData.get("returnTo") ?? "/festivals");
  const returnTo = workflowReturnPath(formData.get("returnTo"));
  const showId = String(formData.get("showId") ?? "").trim();
  const filter = parseFestivalFilter(formData.get("filter"));
  const genre = parseFestivalGenre(formData.get("genre"));
  const listView = parseFestivalListView({
    includeInternational: formData.get("includeInternational"),
    dismissed: formData.get("dismissed"),
  });
  if (!showId) {
    redirect(festivalListPath(listView));
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
    redirect(festivalListPath(listView));
  }
  if (!candidates.active) {
    redirect(
      bulkResultHref(showId, filter, genre, listView, {
        error: "inactive_show",
      })
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
  refreshWorkflowViews(returnTo, ["/outreach"]);
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
  redirect(bulkResultHref(showId, filter, genre, listView, resultParams));
}

async function queueFestivalManagerResearch(formData: FormData) {
  "use server";
  await requireServerActionAuth(formData.get("returnTo") ?? "/festivals");
  const showId = String(formData.get("showId") ?? "").trim();
  const filter = parseFestivalFilter(formData.get("filter"));
  const genre = parseFestivalGenre(formData.get("genre"));
  const listView = parseFestivalListView({
    includeInternational: formData.get("includeInternational"),
    dismissed: formData.get("dismissed"),
  });
  if (!showId) redirect("/festivals");

  let destination: string;
  try {
    const result = await enqueueFestivalManagerResearch(showId);
    destination = bulkResultHref(showId, filter, genre, listView, {
      manager_research: "1",
      manager_eligible: String(result.eligible),
      manager_queued: String(result.enqueued),
      manager_existing: String(result.alreadyQueued),
    });
  } catch (error) {
    destination = bulkResultHref(showId, filter, genre, listView, {
      error: (
        error instanceof Error ? error.message : "Manager research failed"
      ).slice(0, 180),
    });
  }
  refreshWorkflowViews(formData.get("returnTo"), ["/research", "/settings"]);
  redirect(destination);
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
    manager_research?: SearchParamValue;
    manager_eligible?: SearchParamValue;
    manager_queued?: SearchParamValue;
    manager_existing?: SearchParamValue;
    filter?: SearchParamValue;
    genre?: SearchParamValue;
    marked?: SearchParamValue;
    unmarked?: SearchParamValue;
    followup_sent?: SearchParamValue;
    followup_scheduled?: SearchParamValue;
    includeInternational?: SearchParamValue;
    dismissed?: SearchParamValue;
  }>;
}) {
  const { showId } = await params;
  const sp = await searchParams;
  const filter = parseFestivalFilter(sp.filter);
  const genreFilter = parseFestivalGenre(sp.genre);
  const listView = parseFestivalListView(sp);
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
    marked: firstSearchParam(sp.marked),
    unmarked: firstSearchParam(sp.unmarked),
    followUpSent: firstSearchParam(sp.followup_sent),
    followUpScheduled: firstSearchParam(sp.followup_scheduled),
    managerResearch: firstSearchParam(sp.manager_research),
    managerEligible: firstSearchParam(sp.manager_eligible),
    managerQueued: firstSearchParam(sp.manager_queued),
    managerExisting: firstSearchParam(sp.manager_existing),
  };
  const now = new Date();
  const weekend = isWeekendET();
  const returnTo = festivalReturnPath(
    showId,
    filter,
    genreFilter,
    listView
  );
  const [testOverride, festival] = await Promise.all([
    getTestOverride(),
    getFestivalDetails(showId),
  ]);
  if (!festival || !festival.isFestival) return notFound();
  const festivalGroup = festivalGroupKey(festival);
  const groupedShowIds = (
    await db.show.findMany({
      where: activeFestivalWhere(now),
      orderBy: { date: "asc" },
      select: {
        id: true,
        eventName: true,
        venueName: true,
        city: true,
        countryCode: true,
        countryName: true,
      },
      take: 800,
    })
  )
    .filter((candidate) => festivalGroupKey(candidate) === festivalGroup)
    .map((candidate) => candidate.id);
  if (!groupedShowIds.includes(showId)) groupedShowIds.push(showId);
  const festivalActive =
    festival.syncStatus === "active" &&
    satisfiesFestivalLeadTime(festival, now);
  const outreachEnabled =
    festivalActive && festival.dismissedAt === null;

  const baseRows = festival.artists.map((sa) => {
    const a = sa.artist;
    const topSignal = pickTopListenSignal(a.listenSignals, now);
    const matched = topSignal !== null;
    const contact = pickEmailContact(a.contacts);
    const phoneContact = pickPhoneContact(a.contacts, contact);
    const directOutreachContact = pickDirectOutreachContact(a.contacts);
    const displayContact =
      contact ??
      phoneContact ??
      directOutreachContact ??
      a.contacts[0] ??
      null;
    const managerResearchEligible = needsManagerContactResearch(a.contacts);
    const genres: string[] = (() => {
      try {
        return a.genres ? (JSON.parse(a.genres) as string[]).filter((g) => typeof g === "string") : [];
      } catch {
        return [];
      }
    })();
    const outreachHistory = festival.outreaches.filter(
      (outreach) =>
        outreach.artistId === a.id && outreach.kind === "original"
    );
    const manualMarker = outreachHistory.find((outreach) =>
      isActiveManualOutreachMarker({
        id: outreach.id,
        kind: outreach.kind,
        showId,
        artistId: outreach.artistId,
        status: outreach.status,
        providerMessageId: outreach.providerMessageId,
        attemptCount: outreach.attemptCount,
        sendAttemptCount: outreach._count.sendAttempts,
        finalSubject: outreach.finalSubject,
        finalHtml: outreach.finalHtml,
      })
    );
    return {
      artist: a,
      topSignal,
      matched,
      contact,
      displayContact,
      managerResearchEligible,
      hasAnyContact: a.contacts.length > 0,
      genres,
      manualMarker,
      canMarkManually: canMarkOutreachManually(
        outreachHistory.map((outreach) => ({
          status: outreach.status,
          providerMessageId: outreach.providerMessageId,
          attemptCount: outreach.attemptCount,
          sendAttemptCount: outreach._count.sendAttempts,
        }))
      ),
      originalOutreachIds: outreachHistory.map((outreach) => outreach.id),
    };
  });
  const contactIds = baseRows.flatMap((row) =>
    row.contact ? [row.contact.id] : []
  );
  const [sendabilityResults, testOutreaches, followUpEligibilityRows] =
    await Promise.all([
    getOutreachSendabilityBatch(
      contactIds.map((contactId) => ({ showId, contactId })),
      now
    ),
    contactIds.length === 0
      ? Promise.resolve([])
      : db.outreach.findMany({
          where: {
            kind: "original",
            showId,
            contactId: { in: contactIds },
            status: "test",
          },
          select: { contactId: true },
        }),
    getFollowUpEligibilityBatch(
      baseRows.flatMap((row) => row.originalOutreachIds),
      now,
    ),
  ]);
  const sendabilityByContact = new Map(
    sendabilityResults.map((result) => [result.contactId, result])
  );
  const testContactIds = new Set(
    testOutreaches.flatMap((outreach) =>
      outreach.contactId ? [outreach.contactId] : []
    )
  );
  const followUpByParent = new Map(
    followUpEligibilityRows.map((result) => [
      result.parentOutreachId,
      result,
    ]),
  );
  const rows = baseRows.map((row) => ({
    ...row,
    sendability: row.contact
      ? (sendabilityByContact.get(row.contact.id) ?? null)
      : null,
    hasTestSend: row.contact ? testContactIds.has(row.contact.id) : false,
    followUpEligibility:
      row.originalOutreachIds
        .map((outreachId) => followUpByParent.get(outreachId))
        .find(
          (result) =>
            result &&
            (result.state === "eligible" ||
              result.state === "pending" ||
              result.state === "sent"),
        ) ??
      row.originalOutreachIds
        .map((outreachId) => followUpByParent.get(outreachId))
        .find((result) => result !== undefined) ??
      null,
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

  const eligibleSendCount = outreachEnabled
    ? filtered.filter(
        (r) =>
          r.matched &&
          r.sendability?.sendable
      ).length
    : 0;
  const managerResearchCount = rows.filter(
    (row) => row.managerResearchEligible
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
      <Link href={festivalListPath(listView)} className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">← All festivals</Link>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{festival.eventName || festival.venueName}</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {formatShowDate(festival.date, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
            {" · "}{festival.venueName}
            {festival.city ? ` · ${festival.city}` : ""}
            {festival.state ? `, ${festival.state}` : ""}
            {` · ${countryLabel(festival)}`}
            {festival.ticketUrl && (
              <> · <a href={festival.ticketUrl} target="_blank" rel="noopener noreferrer" className="text-zinc-700 hover:underline dark:text-zinc-300">EDMTrain ↗</a></>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <LinkButton href="/research" variant="secondary">
            Review research
          </LinkButton>
          <form action={queueFestivalManagerResearch}>
            <input type="hidden" name="showId" value={showId} />
            <input type="hidden" name="filter" value={filter} />
            <input type="hidden" name="genre" value={genreFilter} />
            <input type="hidden" name="returnTo" value={returnTo} />
            {listView.includeInternational && (
              <input
                type="hidden"
                name="includeInternational"
                value="1"
              />
            )}
            {listView.dismissed && (
              <input type="hidden" name="dismissed" value="1" />
            )}
            <PendingSubmitButton
              disabled={!festivalActive || managerResearchCount === 0}
              pendingLabel="Queueing managers…"
            >
              Research managers ({managerResearchCount})
            </PendingSubmitButton>
          </form>
          <form
            action={
              festival.dismissedAt ? restoreShowAction : dismissShowAction
            }
          >
            <input type="hidden" name="returnTo" value={returnTo} />
            {groupedShowIds.map((groupedShowId) => (
              <input
                key={groupedShowId}
                type="hidden"
                name="showId"
                value={groupedShowId}
              />
            ))}
            <PendingSubmitButton
              variant={festival.dismissedAt ? "secondary" : "ghost"}
              size="sm"
              pendingLabel="…"
            >
              {festival.dismissedAt
                ? "Restore festival"
                : "Dismiss festival"}
            </PendingSubmitButton>
          </form>
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
        {festival.dismissedAt && (
          <div
            role="alert"
            className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
          >
            This festival is dismissed. Restore it to use outreach controls.
          </div>
        )}
        {notices.error === "inactive_show" && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
          >
            This festival became inactive or dismissed before outreach
            started. Nothing was sent.
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
        {notices.managerResearch && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
            Manager research: {notices.managerQueued ?? 0} queued,{" "}
            {notices.managerExisting ?? 0} already active,{" "}
            {notices.managerEligible ?? 0} eligible.
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
        {notices.followUpSent && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
            Follow-up sent.
          </div>
        )}
        {notices.followUpScheduled && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
            Follow-up scheduled for Monday morning.
          </div>
        )}
        {notices.marked && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
            Marked as sent.
          </div>
        )}
        {notices.unmarked && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
            Manual mark removed.
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
            Scheduled send, follow-up, or retry cancelled.
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
                href={festivalReturnPath(
                  showId,
                  opt.key,
                  genreFilter,
                  listView
                )}
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
                  href={festivalReturnPath(
                    showId,
                    filter,
                    g,
                    listView
                  )}
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

      {outreachEnabled && (
        <form
          id={bulkFormId}
          action={bulkSend}
          className="mt-6"
          aria-label="Bulk festival outreach"
        >
          <input type="hidden" name="showId" value={showId} />
          <input type="hidden" name="filter" value={filter} />
          <input type="hidden" name="genre" value={genreFilter} />
          <input
            type="hidden"
            name="includeInternational"
            value={listView.includeInternational ? "1" : "0"}
          />
          <input
            type="hidden"
            name="dismissed"
            value={listView.dismissed ? "1" : "0"}
          />
          <input type="hidden" name="returnTo" value={returnTo} />

          <div className="z-20 -mx-1 mb-3 flex items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-white/95 px-4 py-2 shadow-sm backdrop-blur sm:sticky sm:top-12 dark:border-zinc-800 dark:bg-zinc-950/95">
            <span className="text-sm text-zinc-600 dark:text-zinc-400">
              {filtered.length} shown · <b>{eligibleSendCount}</b> sendable
            </span>
            <PendingSubmitButton
              variant="primary"
              size="md"
              disabled={eligibleSendCount === 0}
              pendingLabel={weekend ? "Scheduling selected…" : "Sending selected…"}
            >
              Send to selected
            </PendingSubmitButton>
          </div>
        </form>
      )}

      <Card className={outreachEnabled ? undefined : "mt-6"}>
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
          {filtered.map((r) => {
              const canSend =
                outreachEnabled &&
                r.matched &&
                r.sendability?.sendable === true;
              const canCustomize =
                outreachEnabled &&
                !!r.contact &&
                r.sendability?.mode !== "retry";
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
                  {outreachEnabled && (
                    <>
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
                    </>
                  )}
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
                      {r.displayContact &&
                        hasDirectOutreachNote(r.displayContact) && (
                          <Badge tone="warning">Direct outreach</Badge>
                        )}
                      {r.managerResearchEligible && (
                        <Badge tone="warning">Manager needed</Badge>
                      )}
                    </div>
                    {r.displayContact ? (
                      <p
                        id={!canSend ? reasonId : undefined}
                        className="mt-0.5 truncate text-xs text-zinc-500"
                        title={!canSend ? disabledReason : undefined}
                      >
                        {r.displayContact.name
                          ? `${r.displayContact.name} · `
                          : ""}
                        {contactDisplayValue(r.displayContact)}
                        {hasDirectOutreachNote(r.displayContact) &&
                        !isDirectOutreachOnly(r.displayContact)
                          ? ` · ${directOutreachNoteValue(r.displayContact)}`
                          : ""}
                        {displayStatus &&
                          ` · ${
                            r.contact
                              ? `original: ${displayStatus}`
                              : displayStatus
                          }`}
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
                  {canCustomize && r.contact && (
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
                  {outreachEnabled &&
                    isCancellableOutreachStatus(
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
                  {outreachEnabled && r.contact && r.followUpEligibility && (
                    <FollowUpButton
                      eligibility={r.followUpEligibility}
                      returnTo={returnTo}
                      isWeekend={weekend}
                      action={sendFollowUpAction}
                      cancelAction={cancelScheduledAction}
                    />
                  )}
                  {outreachEnabled && r.manualMarker && (
                    <form action={unmarkSentAction}>
                      <input
                        type="hidden"
                        name="outreachId"
                        value={r.manualMarker.id}
                      />
                      <input
                        type="hidden"
                        name="returnTo"
                        value={returnTo}
                      />
                      <PendingSubmitButton
                        variant="ghost"
                        size="sm"
                        pendingLabel="Unmarking…"
                      >
                        Unmark sent
                      </PendingSubmitButton>
                    </form>
                  )}
                  {outreachEnabled && r.canMarkManually && (
                    <form action={markSentAction}>
                      <input type="hidden" name="showId" value={showId} />
                      {r.displayContact ? (
                        <input
                          type="hidden"
                          name="contactId"
                          value={r.displayContact.id}
                        />
                      ) : (
                        <input
                          type="hidden"
                          name="artistId"
                          value={r.artist.id}
                        />
                      )}
                      <input
                        type="hidden"
                        name="returnTo"
                        value={returnTo}
                      />
                      <PendingSubmitButton
                        variant="ghost"
                        size="sm"
                        pendingLabel="Marking…"
                      >
                        Mark sent
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
