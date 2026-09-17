import type { Metadata } from "next";
import { appConfig } from "@/lib/appConfig";
import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { cache } from "react";
import { db } from "@/lib/db";
import {
  getOutreachSendabilityBatch,
  getFollowUpEligibilityBatch,
  scheduleFestivalManagerOutreach,
  scheduleFollowUp,
  scheduleOutreach,
  type FollowUpEligibility,
  type OutreachSendability,
} from "@/lib/sendOutreach";
import { getTestOverride } from "@/lib/resend";
import {
  formatScheduledTime,
  getNextNormalOutreachDispatch,
  isWeekendET,
  getNextMondaySlot,
} from "@/lib/schedule";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { ArtistLink } from "@/components/artist-modal";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { FollowUpButton } from "@/components/follow-up-button";
import { RejectWorkflowTargetButton } from "@/components/reject-workflow-target-button";
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
  markUnsentAction,
  restoreShowAction,
  sendFollowUpAction,
  restoreRejectedFestivalArtistAction,
  unmarkSentAction,
} from "@/app/dashboard/actions";
import { requireServerActionAuth } from "@/lib/auth";
import { refreshWorkflowViews } from "@/lib/workflowRefresh";
import { artistDisplayName } from "@/lib/artistDisplayName";
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
import { normalizeEmail, normalizeEmails } from "@/lib/resend";
import { groupFestivalManagerTargets } from "@/lib/festivalOutreach";
import {
  FestivalBulkOutreachForm,
  type FestivalBulkConfirmationCandidate,
} from "@/components/festival-bulk-outreach-form";
import { OutreachDeliveryBadges } from "@/components/outreach-delivery-badges";
import {
  FESTIVAL_UTM_CAMPAIGN_MAX_LENGTH,
  normalizeFestivalUtmCampaign,
} from "@/lib/festivalUtm";
import {
  DEFAULT_RECIPIENT_DELIVERY_MODE,
  isSelectableRecipientDeliveryMode,
} from "@/lib/recipientDelivery";
import {
  BulkManualFestivalArtistForm,
  ManualFestivalArtistForm,
} from "./manual-lineup-form";
import { removeManualFestivalArtist } from "./manual-lineup-actions";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BULK_SCHEDULE_CONCURRENCY = 1;
const BULK_ACTION_BUDGET_MS = 260_000;
const BULK_ACTION_MIN_START_BUDGET_MS = 70_000;
const SCHEDULED_WORKFLOW_START_WINDOW_MS = 15 * 60 * 1000;
const BULK_ACTION_DEADLINE_ERROR =
  "Bulk action reached its safe time limit; rerun to process the remaining artists";

export function hasFestivalBulkActionBudget(
  deadlineAt: number,
  now: number = Date.now(),
): boolean {
  return deadlineAt - now >= BULK_ACTION_MIN_START_BUDGET_MS;
}

export function nextScheduledOutreachPoll(now: Date): Date {
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  const minute = next.getUTCMinutes();
  let minutesUntilPoll = (7 - (minute % 10) + 10) % 10;
  if (minutesUntilPoll === 0) minutesUntilPoll = 10;
  next.setUTCMinutes(minute + minutesUntilPoll);
  return next;
}

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
      festivalUtmCampaign: true,
      eventName: true,
      syncStatus: true,
      dismissedAt: true,
      artists: {
        select: {
          providerManaged: true,
          manuallyAdded: true,
          rejectedAt: true,
          artist: {
            select: {
              id: true,
              name: true,
              customName: true,
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
          createdAt: true,
          kind: true,
          parentOutreachId: true,
          artistId: true,
          status: true,
          providerMessageId: true,
          attemptCount: true,
          sentAt: true,
          deliveredAt: true,
          bouncedAt: true,
          complainedAt: true,
          openCount: true,
          clickCount: true,
          finalSubject: true,
          finalHtml: true,
          scheduledFor: true,
          nextAttemptAt: true,
          coveredArtists: { select: { artistId: true } },
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
            timeZone: appConfig.timeZone,
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

function storedOutreachLabel(outreach: {
  status: string;
  nextAttemptAt: Date | null;
  scheduledFor: Date | null;
  bouncedAt: Date | null;
  complainedAt: Date | null;
}): string {
  if (outreach.bouncedAt) return "bounced";
  if (outreach.complainedAt) return "complained";
  if (outreach.status === "sent") return "already sent";
  if (outreach.status === "scheduled") return "already scheduled";
  if (outreach.status === "retry_scheduled") {
    const next = outreach.nextAttemptAt ?? outreach.scheduledFor;
    return next
      ? `retry scheduled · ${next.toLocaleString("en-US", {
          timeZone: appConfig.timeZone,
          weekday: "short",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        })}`
      : "retry scheduled";
  }
  if (outreach.status === "queued") return "send in progress";
  if (outreach.status === "manual_review") return "manual review required";
  return outreach.status.replaceAll("_", " ");
}

function scheduledOutreachTooltip(
  sendability: OutreachSendability | null,
  outreach:
    | {
        status: string;
        nextAttemptAt: Date | null;
        scheduledFor: Date | null;
      }
    | null,
): string | null {
  const blockingStatus = sendability?.blockingStatus;
  const blockingScheduledAt = sendability?.blockingNextAttemptAt;
  if (
    (blockingStatus === "scheduled" ||
      blockingStatus === "retry_scheduled") &&
    blockingScheduledAt
  ) {
    const label =
      blockingStatus === "retry_scheduled" ? "Retry scheduled" : "Scheduled";
    return `${label} for ${formatScheduledTime(
      blockingScheduledAt,
    )} (${appConfig.timeZone})`;
  }

  if (
    outreach?.status !== "scheduled" &&
    outreach?.status !== "retry_scheduled"
  ) {
    return null;
  }
  const scheduledAt =
    outreach.status === "retry_scheduled"
      ? outreach.nextAttemptAt ?? outreach.scheduledFor
      : outreach.scheduledFor ?? outreach.nextAttemptAt;
  if (!scheduledAt) return null;
  const label =
    outreach.status === "retry_scheduled" ? "Retry scheduled" : "Scheduled";
  return `${label} for ${formatScheduledTime(scheduledAt)} (${
    appConfig.timeZone
  })`;
}

async function festivalBulkCandidates(
  showId: string,
  now: Date
): Promise<{
  active: boolean;
  targetsByContactId: Map<
    string,
    { artistId: string; contactId: string; email: string }
  >;
} | null> {
  const festival = await db.show.findUnique({
    where: { id: showId },
    select: {
      isFestival: true,
      date: true,
      festivalNycStatus: true,
      syncStatus: true,
      dismissedAt: true,
      artists: {
        where: { rejectedAt: null },
        select: {
          artistId: true,
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
                },
              },
            },
          },
        },
      },
    },
  });
  if (!festival?.isFestival) return null;

  const targetsByContactId = new Map<
    string,
    { artistId: string; contactId: string; email: string }
  >();
  if (
    festival.syncStatus === "active" &&
    satisfiesFestivalLeadTime(festival, now) &&
    festival.dismissedAt === null
  ) {
    for (const { artistId, artist } of festival.artists) {
      const contact = pickEmailContact(artist.contacts);
      const email = normalizeEmail(contact?.email ?? "");
      if (contact && email) {
        targetsByContactId.set(contact.id, {
          artistId,
          contactId: contact.id,
          email,
        });
      }
    }
  }
  return {
    active:
      festival.syncStatus === "active" &&
      satisfiesFestivalLeadTime(festival, now) &&
      festival.dismissedAt === null,
    targetsByContactId,
  };
}

export function eligibleFestivalFollowUp(
  artistId: string,
  parentOutreaches: readonly {
    id: string;
    artistId: string;
    createdAt: Date;
    coveredArtists: readonly { artistId: string }[];
  }[],
  eligibilityByParent: ReadonlyMap<string, FollowUpEligibility>,
): FollowUpEligibility | null {
  const matchingParents = [...parentOutreaches]
    .filter(
      (outreach) =>
        outreach.artistId === artistId ||
        outreach.coveredArtists.some(
          (covered) => covered.artistId === artistId,
        ),
    )
    .sort(
      (left, right) =>
        right.createdAt.getTime() - left.createdAt.getTime() ||
        left.id.localeCompare(right.id),
    );
  for (const parent of matchingParents) {
    const eligibility = eligibilityByParent.get(parent.id);
    if (!eligibility) continue;
    if (eligibility.eligible) return eligibility;
    if (
      eligibility.state === "pending" ||
      eligibility.state === "sent"
    ) {
      return null;
    }
  }
  return null;
}

async function bulkSend(formData: FormData) {
  "use server";
  await requireServerActionAuth(formData.get("returnTo") ?? "/festivals");
  const deadlineAt = Date.now() + BULK_ACTION_BUDGET_MS;
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

  const requestedTargets = Array.from(
    new Set(
      formData
        .getAll("outreachTargets")
        .map((value) => String(value).trim())
        .filter(Boolean)
    )
  );
  const requestedDeliveryMode = formData.get("recipientDeliveryMode");
  const recipientDeliveryMode = isSelectableRecipientDeliveryMode(
    requestedDeliveryMode,
  )
    ? requestedDeliveryMode
    : DEFAULT_RECIPIENT_DELIVERY_MODE;
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

  const candidateTargets = [...candidates.targetsByContactId.values()];
  const requestedContactIds = requestedTargets.flatMap((selectionId) =>
    selectionId.startsWith("original:")
      ? [selectionId.slice("original:".length)]
      : [],
  );
  const requestedParentOutreachIds = requestedTargets.flatMap((selectionId) =>
    selectionId.startsWith("follow_up:")
      ? [selectionId.slice("follow_up:".length)]
      : [],
  );
  const candidateIds = requestedContactIds.filter((contactId) =>
    candidates.targetsByContactId.has(contactId),
  );
  const parentOutreaches = await db.outreach.findMany({
    where: {
      id: { in: requestedParentOutreachIds },
      kind: "original",
      showId,
      OR: [
        { artistId: { in: candidateTargets.map((target) => target.artistId) } },
        {
          coveredArtists: {
            some: {
              artistId: {
                in: candidateTargets.map((target) => target.artistId),
              },
            },
          },
        },
      ],
    },
    select: {
      id: true,
      artistId: true,
      createdAt: true,
      coveredArtists: {
        orderBy: { artistId: "asc" },
        select: { artistId: true },
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
  });
  const [sendability, followUpEligibility] = await Promise.all([
    getOutreachSendabilityBatch(
      candidateIds.map((contactId) => ({
        showId,
        contactId,
        festivalAllContacts: true,
      })),
      now,
    ),
    getFollowUpEligibilityBatch(
      parentOutreaches.map((outreach) => outreach.id),
      now,
    ),
  ]);
  const sendabilityByContact = new Map(
    sendability.map((result) => [result.contactId, result]),
  );
  const followUpByParent = new Map(
    followUpEligibility.map((result) => [
      result.parentOutreachId,
      result,
    ]),
  );
  const eligibleSelections = new Map<
    string,
    | {
        kind: "original";
        selectionId: string;
        target: (typeof candidateTargets)[number];
        sendability: OutreachSendability;
      }
    | {
        kind: "follow_up";
        selectionId: string;
        target: (typeof candidateTargets)[number];
        eligibility: FollowUpEligibility;
      }
  >();
  for (const target of candidateTargets) {
    const followUp = eligibleFestivalFollowUp(
      target.artistId,
      parentOutreaches,
      followUpByParent,
    );
    if (followUp) {
      const selectionId = `follow_up:${followUp.parentOutreachId}`;
      if (!eligibleSelections.has(selectionId)) {
        eligibleSelections.set(selectionId, {
          kind: "follow_up",
          selectionId,
          target,
          eligibility: followUp,
        });
      }
      continue;
    }
    const initial = sendabilityByContact.get(target.contactId);
    if (!initial?.sendable) continue;
    const selectionId = `original:${target.contactId}`;
    eligibleSelections.set(selectionId, {
      kind: "original",
      selectionId,
      target,
      sendability: initial,
    });
  }
  const selected = requestedTargets.flatMap((selectionId) => {
    const selection = eligibleSelections.get(selectionId);
    return selection ? [selection] : [];
  });
  const selectedInitialTargets = selected.flatMap((selection) => {
    if (selection.kind !== "original") return [];
    const recipients = normalizeEmails(selection.sendability.recipients);
    return [
      {
        ...selection.target,
        recipientDeliveryMode:
          selection.sendability.mode === "retry"
            ? selection.sendability.recipientDeliveryMode ??
              DEFAULT_RECIPIENT_DELIVERY_MODE
            : recipientDeliveryMode,
        email:
          !selection.sendability.fullTeamSend &&
          recipients.length === 1 &&
          recipients[0] === selection.target.email
            ? selection.target.email
            : `contact:${selection.target.contactId}`,
      },
    ];
  });
  const { groups: initialGroups } = groupFestivalManagerTargets(
    selectedInitialTargets,
    new Set(selectedInitialTargets.map((target) => target.contactId)),
  );
  const followUpSelections = selected.filter(
    (selection): selection is Extract<
      (typeof selected)[number],
      { kind: "follow_up" }
    > => selection.kind === "follow_up",
  );
  const jobs = [
    ...initialGroups.map((group) => ({
      kind: "original" as const,
      id: `original:${group.contactId}`,
      group,
    })),
    ...followUpSelections.map((selection) => ({
      kind: "follow_up" as const,
      id: selection.selectionId,
      selection,
    })),
  ];
  let sent = 0;
  let scheduled = 0;
  let failed = 0;
  let skipped = requestedTargets.length - selected.length;
  const errors: string[] = [];
  if (requestedTargets.length === 0) {
    errors.push("Select at least one eligible artist");
  } else if (skipped > 0) {
    const acceptedIds = new Set(selected.map((selection) => selection.selectionId));
    for (const selectionId of requestedTargets) {
      if (acceptedIds.has(selectionId)) continue;
      const isFollowUp = selectionId.startsWith("follow_up:");
      const identifier = selectionId.slice(
        isFollowUp ? "follow_up:".length : "original:".length,
      );
      const reason = isFollowUp
        ? followUpByParent.get(identifier)?.reason
        : sendabilityByContact.get(identifier)?.reason;
      errors.push(
        `${isFollowUp ? "follow-up" : "initial"} ${identifier.slice(-8)}: ${
          reason ?? "Selected outreach is no longer eligible"
        }`,
      );
    }
  }

  const results = await mapWithConcurrency(
    jobs,
    BULK_SCHEDULE_CONCURRENCY,
    async (job) => {
      if (!hasFestivalBulkActionBudget(deadlineAt)) {
        return {
          job,
          result: {
            ok: false as const,
            error: BULK_ACTION_DEADLINE_ERROR,
          },
        };
      }
      try {
        const immediateSchedule = new Date(Date.now() + 60_000);
        const nextDispatcherPoll =
          nextScheduledOutreachPoll(immediateSchedule);
        const dispatcherWindowEnd = new Date(
          nextDispatcherPoll.getTime() + SCHEDULED_WORKFLOW_START_WINDOW_MS,
        );
        const scheduledFor =
          isWeekendET(nextDispatcherPoll) ||
          isWeekendET(dispatcherWindowEnd)
          ? getNextMondaySlot(immediateSchedule)
          : immediateSchedule;
        const result =
          job.kind === "follow_up"
            ? await scheduleFollowUp(
                job.selection.eligibility.parentOutreachId,
                scheduledFor,
              )
            : job.group.artistIds.length > 1
              ? await scheduleFestivalManagerOutreach(
                  {
                    showId,
                    contactId: job.group.contactId,
                    coveredArtistIds: job.group.artistIds,
                  },
                  scheduledFor,
                )
              : await scheduleOutreach(
                  {
                    showId,
                    contactId: job.group.contactId,
                    festivalAllContacts: true,
                    recipientDeliveryMode:
                      job.group.recipientDeliveryMode,
                  },
                  scheduledFor,
                );
        return { job, result };
      } catch (error) {
        return {
          job,
          result: {
            ok: false,
            error: error instanceof Error ? error.message : "Unexpected send error",
          },
        };
      }
    }
  );

  for (const { job, result } of results) {
    if (result.ok) {
      if (result.scheduled === true) scheduled++;
      else sent++;
    } else if (
      result.error?.toLowerCase().includes("already sent") ||
      result.error?.toLowerCase().includes("already scheduled")
    ) {
      skipped++;
    } else {
      failed++;
      errors.push(
        `${job.id.slice(-8)}: ${
          result.error ?? "Unknown send failure"
        }`,
      );
    }
  }
  if (errors.some((error) => error.includes(BULK_ACTION_DEADLINE_ERROR))) {
    errors.splice(
      0,
      errors.length,
      BULK_ACTION_DEADLINE_ERROR,
      ...errors.filter(
        (error) => !error.includes(BULK_ACTION_DEADLINE_ERROR),
      ),
    );
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

async function queueFestivalOutreach(formData: FormData) {
  "use server";
  await requireServerActionAuth(formData.get("returnTo") ?? "/festivals");
  const deadlineAt = Date.now() + BULK_ACTION_BUDGET_MS;
  const returnTo = workflowReturnPath(formData.get("returnTo"));
  const showId = String(formData.get("showId") ?? "").trim();
  const filter = parseFestivalFilter(formData.get("filter"));
  const genre = parseFestivalGenre(formData.get("genre"));
  const listView = parseFestivalListView({
    includeInternational: formData.get("includeInternational"),
    dismissed: formData.get("dismissed"),
  });
  if (!showId) redirect(festivalListPath(listView));

  const now = new Date();
  const festival = await db.show.findUnique({
    where: { id: showId },
    select: {
      isFestival: true,
      date: true,
      festivalNycStatus: true,
      syncStatus: true,
      dismissedAt: true,
      artists: {
        where: { rejectedAt: null },
        select: {
          artistId: true,
          artist: {
            select: {
              contacts: {
                where: { state: "active", email: { not: null } },
                orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
                select: {
                  id: true,
                  email: true,
                  phone: true,
                  directOutreachNote: true,
                  name: true,
                  role: true,
                  state: true,
                },
              },
            },
          },
        },
      },
    },
  });
  if (
    !festival?.isFestival ||
    festival.syncStatus !== "active" ||
    festival.dismissedAt !== null ||
    !satisfiesFestivalLeadTime(festival, now)
  ) {
    redirect(
      bulkResultHref(showId, filter, genre, listView, {
        error: "inactive_show",
      }),
    );
  }

  const targets = festival.artists
    .flatMap(({ artistId, artist }) => {
      const contact = pickEmailContact(artist.contacts);
      const email = normalizeEmail(contact?.email ?? "");
      return contact && email ? [{ artistId, contactId: contact.id, email }] : [];
    })
    .sort((left, right) => left.artistId.localeCompare(right.artistId));
  const sendability = await getOutreachSendabilityBatch(
    targets.map(({ contactId }) => ({
      showId,
      contactId,
      festivalAllContacts: true,
    })),
    now,
  );
  const sendabilityByContact = new Map(
    sendability.map((result) => [result.contactId, result]),
  );
  const { groups, skipped } = groupFestivalManagerTargets(
    targets.map((target) => {
      const result = sendabilityByContact.get(target.contactId);
      const recipients = normalizeEmails(result?.recipients ?? []);
      return {
        ...target,
        email:
          !result?.fullTeamSend &&
          recipients.length === 1 &&
          recipients[0] === target.email
            ? target.email
            : `contact:${target.contactId}`,
      };
    }),
    new Set(
      [...sendabilityByContact]
        .filter(([, result]) => result.sendable)
        .map(([contactId]) => contactId),
    ),
  );

  const scheduledFor = getNextNormalOutreachDispatch(now);
  const results = await mapWithConcurrency(
    groups,
    BULK_SCHEDULE_CONCURRENCY,
    async (group) => {
      if (!hasFestivalBulkActionBudget(deadlineAt)) {
        return {
          group,
          result: {
            ok: false as const,
            error: BULK_ACTION_DEADLINE_ERROR,
          },
        };
      }
      try {
        const result =
          group.artistIds.length > 1
            ? await scheduleFestivalManagerOutreach(
                {
                  showId,
                  contactId: group.contactId,
                  coveredArtistIds: group.artistIds,
                },
                scheduledFor,
              )
            : await scheduleOutreach(
                {
                  showId,
                  contactId: group.contactId,
                  festivalAllContacts: true,
                },
                scheduledFor,
              );
        return { group, result };
      } catch (error) {
        return {
          group,
          result: {
            ok: false,
            error:
              error instanceof Error ? error.message : "Unexpected queue error",
          },
        };
      }
    },
  );

  let scheduledManagers = 0;
  let coveredArtists = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const { group, result } of results) {
    if (result.ok) {
      scheduledManagers += 1;
      coveredArtists += group.artistIds.length;
    } else {
      failed += 1;
      errors.push(result.error ?? "Unknown queue failure");
    }
  }
  if (errors.some((error) => error.includes(BULK_ACTION_DEADLINE_ERROR))) {
    errors.splice(
      0,
      errors.length,
      BULK_ACTION_DEADLINE_ERROR,
      ...errors.filter(
        (error) => !error.includes(BULK_ACTION_DEADLINE_ERROR),
      ),
    );
  }
  refreshWorkflowViews(returnTo, ["/outreach"]);
  redirect(
    bulkResultHref(showId, filter, genre, listView, {
      queue_outreach: "1",
      queue_managers: String(scheduledManagers),
      queue_artists: String(coveredArtists),
      queue_failed: String(failed),
      queue_skipped: String(skipped),
      ...(errors.length ? { errors: errors.slice(0, 5).join(" | ") } : {}),
    }),
  );
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

async function saveFestivalUtmCampaign(formData: FormData) {
  "use server";
  await requireServerActionAuth(formData.get("returnTo") ?? "/festivals");
  const showId = String(formData.get("showId") ?? "").trim();
  const filter = parseFestivalFilter(formData.get("filter"));
  const genre = parseFestivalGenre(formData.get("genre"));
  const listView = parseFestivalListView({
    includeInternational: formData.get("includeInternational"),
    dismissed: formData.get("dismissed"),
  });
  if (!showId) redirect(festivalListPath(listView));

  let destination: string;
  try {
    const festivalUtmCampaign = normalizeFestivalUtmCampaign(
      formData.get("festivalUtmCampaign"),
    );
    const updated = await db.show.updateMany({
      where: { id: showId, isFestival: true },
      data: { festivalUtmCampaign },
    });
    if (updated.count !== 1) throw new Error("Festival not found");
    refreshWorkflowViews(formData.get("returnTo"), []);
    destination = bulkResultHref(showId, filter, genre, listView, {
      utm_saved: "1",
    });
  } catch (error) {
    destination = bulkResultHref(showId, filter, genre, listView, {
      error: (
        error instanceof Error ? error.message : "Unable to save UTM campaign"
      ).slice(0, 180),
    });
  }
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
    cancelled?: SearchParamValue;
    bulk?: SearchParamValue;
    manager_research?: SearchParamValue;
    manager_eligible?: SearchParamValue;
    manager_queued?: SearchParamValue;
    manager_existing?: SearchParamValue;
    queue_outreach?: SearchParamValue;
    queue_managers?: SearchParamValue;
    queue_artists?: SearchParamValue;
    queue_failed?: SearchParamValue;
    queue_skipped?: SearchParamValue;
    filter?: SearchParamValue;
    genre?: SearchParamValue;
    marked?: SearchParamValue;
    unmarked?: SearchParamValue;
    unsent?: SearchParamValue;
    followup_sent?: SearchParamValue;
    followup_scheduled?: SearchParamValue;
    includeInternational?: SearchParamValue;
    dismissed?: SearchParamValue;
    utm_saved?: SearchParamValue;
    lineup_added?: SearchParamValue;
    lineup_removed?: SearchParamValue;
    lineup_manual_cleared?: SearchParamValue;
    lineup_error?: SearchParamValue;
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
    cancelled: firstSearchParam(sp.cancelled),
    bulk: firstSearchParam(sp.bulk),
    marked: firstSearchParam(sp.marked),
    unmarked: firstSearchParam(sp.unmarked),
    unsent: firstSearchParam(sp.unsent),
    followUpSent: firstSearchParam(sp.followup_sent),
    followUpScheduled: firstSearchParam(sp.followup_scheduled),
    managerResearch: firstSearchParam(sp.manager_research),
    managerEligible: firstSearchParam(sp.manager_eligible),
    managerQueued: firstSearchParam(sp.manager_queued),
    managerExisting: firstSearchParam(sp.manager_existing),
    queueOutreach: firstSearchParam(sp.queue_outreach),
    queueManagers: firstSearchParam(sp.queue_managers),
    queueArtists: firstSearchParam(sp.queue_artists),
    queueFailed: firstSearchParam(sp.queue_failed),
    queueSkipped: firstSearchParam(sp.queue_skipped),
    utmSaved: firstSearchParam(sp.utm_saved),
    lineupAdded: firstSearchParam(sp.lineup_added),
    lineupRemoved: firstSearchParam(sp.lineup_removed),
    lineupManualCleared: firstSearchParam(sp.lineup_manual_cleared),
    lineupError: firstSearchParam(sp.lineup_error),
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
        outreach.kind === "original" &&
        (outreach.artistId === a.id ||
          outreach.coveredArtists.some(
            (covered) => covered.artistId === a.id,
          ))
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
    const engagementOutreach = outreachHistory.find(
      (outreach) =>
        outreach.id !== manualMarker?.id &&
        outreach.status !== "test" &&
        (outreach.providerMessageId !== null ||
          outreach.sentAt !== null ||
          outreach.deliveredAt !== null ||
          outreach.openCount > 0 ||
          outreach.clickCount > 0),
    );
    const coveredOutreach =
      outreachHistory.find((outreach) => outreach.status === "scheduled") ??
      outreachHistory.find(
        (outreach) => outreach.status === "retry_scheduled",
      ) ??
      outreachHistory.find((outreach) => outreach.status === "sent") ??
      outreachHistory.find((outreach) => outreach.status === "queued") ??
      outreachHistory.find(
        (outreach) =>
          outreach.status === "failed" &&
          (outreach.bouncedAt !== null || outreach.complainedAt !== null),
      ) ??
      outreachHistory.find(
        (outreach) => outreach.status === "manual_review",
      ) ??
      null;
    return {
      association: {
        providerManaged: sa.providerManaged,
        manuallyAdded: sa.manuallyAdded,
        rejectedAt: sa.rejectedAt,
      },
      artist: a,
      topSignal,
      matched,
      contact,
      displayContact,
      managerResearchEligible,
      hasAnyContact: a.contacts.length > 0,
      genres,
      manualMarker,
      engagementOutreach,
      coveredOutreach,
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
      contactIds.map((contactId) => ({
        showId,
        contactId,
        festivalAllContacts: true,
      })),
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
  const festivalParentOutreaches = festival.outreaches
    .filter((outreach) => outreach.kind === "original")
    .map((outreach) => ({
      id: outreach.id,
      artistId: outreach.artistId,
      createdAt: outreach.createdAt,
      coveredArtists: outreach.coveredArtists,
    }));
  const rows = baseRows.map((row) => ({
    ...row,
    sendability: row.contact
      ? (sendabilityByContact.get(row.contact.id) ?? null)
      : null,
    hasTestSend: row.contact ? testContactIds.has(row.contact.id) : false,
    bulkFollowUpEligibility: eligibleFestivalFollowUp(
      row.artist.id,
      festivalParentOutreaches,
      followUpByParent,
    ),
    followUpEligibility:
      eligibleFestivalFollowUp(
        row.artist.id,
        festivalParentOutreaches,
        followUpByParent,
      ) ??
      row.originalOutreachIds
        .map((outreachId) => followUpByParent.get(outreachId))
        .find(
          (result) =>
            result &&
            (result.state === "pending" || result.state === "sent"),
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
    if (filter === "rejected") {
      if (!r.association.rejectedAt) return false;
    } else if (r.association.rejectedAt) {
      return false;
    }
    if (filter === "matched" && !r.matched) return false;
    if (filter === "matched_with_contact" && !(r.matched && !!r.contact)) return false;
    if (filter === "needs_contact" && !(r.matched && !r.contact)) return false;
    if (filter === "manager_needed" && !r.managerResearchEligible) return false;
    if (
      filter === "unsent" &&
      !r.sendability?.sendable
    ) {
      return false;
    }
    if (genreFilter !== "all" && !r.genres.some((g) => g.toLowerCase() === genreFilter)) return false;
    return true;
  });

  const managerResearchCount = rows.filter(
    (row) => !row.association.rejectedAt && row.managerResearchEligible
  ).length;
  const bulkFormId = "festival-bulk-outreach";
  const bulkConfirmationCandidates: FestivalBulkConfirmationCandidate[] = [];
  const festivalArtistNameById = new Map(
    rows.map((row) => [
      row.artist.id,
      artistDisplayName(row.artist),
    ]),
  );
  const addedBulkSelections = new Set<string>();
  if (outreachEnabled) {
    for (const row of filtered) {
      const followUp = row.bulkFollowUpEligibility;
      if (followUp?.contactId) {
        const selectionId = `follow_up:${followUp.parentOutreachId}`;
        if (addedBulkSelections.has(selectionId)) continue;
        const recipients = normalizeEmails(followUp.recipients);
        if (recipients.length === 0) continue;
        const parent = festivalParentOutreaches.find(
          (outreach) => outreach.id === followUp.parentOutreachId,
        );
        const coveredArtistIds = parent
          ? Array.from(
              new Set([
                parent.artistId,
                ...parent.coveredArtists.map(
                  (covered) => covered.artistId,
                ),
              ]),
            )
          : [row.artist.id];
        bulkConfirmationCandidates.push({
          selectionId,
          artistId: row.artist.id,
          coveredArtistIds,
          contactId: followUp.contactId,
          outreachKind: "follow_up",
          artistNames: coveredArtistIds.map(
            (artistId) =>
              festivalArtistNameById.get(artistId) ?? artistId,
          ),
          groupKey: selectionId,
          emailLabel: recipients.join(", "),
          recipients,
          primaryRecipientEmail: followUp.primaryRecipientEmail ?? null,
          recipientDeliveryMode:
            followUp.recipientDeliveryMode ??
            DEFAULT_RECIPIENT_DELIVERY_MODE,
          immutableDeliveryMode: true,
          selectedByDefault: false,
        });
        addedBulkSelections.add(selectionId);
        continue;
      }
      if (!row.contact || !row.sendability?.sendable) continue;
      const contactEmail = normalizeEmail(row.contact.email ?? "");
      const recipients = normalizeEmails(row.sendability.recipients);
      if (!contactEmail || recipients.length === 0) continue;
      const shareable =
        !row.sendability.fullTeamSend &&
        recipients.length === 1 &&
        recipients[0] === contactEmail;
      const selectionId = `original:${row.contact.id}`;
      bulkConfirmationCandidates.push({
        selectionId,
        artistId: row.artist.id,
        coveredArtistIds: [row.artist.id],
        contactId: row.contact.id,
        outreachKind: "original",
        artistNames: [artistDisplayName(row.artist)],
        groupKey: shareable
          ? contactEmail
          : `contact:${row.contact.id}`,
        emailLabel: recipients.join(", "),
        recipients,
        primaryRecipientEmail:
          row.sendability.primaryRecipientEmail ?? contactEmail,
        recipientDeliveryMode:
          row.sendability.recipientDeliveryMode ??
          DEFAULT_RECIPIENT_DELIVERY_MODE,
        immutableDeliveryMode: row.sendability.mode === "retry",
        selectedByDefault: filter === "unsent",
      });
      addedBulkSelections.add(selectionId);
    }
  }
  const bulkCandidateByArtistId = new Map(
    bulkConfirmationCandidates.flatMap((candidate) =>
      candidate.coveredArtistIds.map((artistId) => [
        artistId,
        candidate,
      ] as const),
    ),
  );

  const filterOptions: { key: FestivalFilter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "matched", label: "Matched" },
    { key: "matched_with_contact", label: "Matched + email" },
    { key: "needs_contact", label: "Needs email" },
    { key: "manager_needed", label: "Manager needed" },
    { key: "unsent", label: "Unsent" },
    { key: "rejected", label: "Rejected" },
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
          <form action={queueFestivalOutreach}>
            <input type="hidden" name="showId" value={showId} />
            <input type="hidden" name="filter" value={filter} />
            <input type="hidden" name="genre" value={genreFilter} />
            <input type="hidden" name="returnTo" value={returnTo} />
            {listView.includeInternational && (
              <input type="hidden" name="includeInternational" value="1" />
            )}
            {listView.dismissed && (
              <input type="hidden" name="dismissed" value="1" />
            )}
            <PendingSubmitButton
              variant="secondary"
              disabled={!outreachEnabled || contactIds.length === 0}
              pendingLabel="Queueing outreach…"
            >
              Queue outreach ({contactIds.length})
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

      <Card className="mt-4">
        <form
          action={saveFestivalUtmCampaign}
          className="flex flex-wrap items-end gap-3 p-4"
        >
          <input type="hidden" name="showId" value={showId} />
          <input type="hidden" name="filter" value={filter} />
          <input type="hidden" name="genre" value={genreFilter} />
          <input type="hidden" name="returnTo" value={returnTo} />
          {listView.includeInternational && (
            <input type="hidden" name="includeInternational" value="1" />
          )}
          {listView.dismissed && (
            <input type="hidden" name="dismissed" value="1" />
          )}
          <div className="min-w-64 flex-1">
            <label
              htmlFor="festival-utm-campaign"
              className="text-sm font-medium"
            >
              Festival UTM campaign
            </label>
            <input
              id="festival-utm-campaign"
              name="festivalUtmCampaign"
              defaultValue={festival.festivalUtmCampaign ?? ""}
              maxLength={FESTIVAL_UTM_CAMPAIGN_MAX_LENGTH}
              placeholder="experts-only-2026"
              className="mt-1 block min-h-11 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-base placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none sm:min-h-9 sm:text-sm dark:border-zinc-800 dark:bg-zinc-950 dark:placeholder:text-zinc-600"
            />
            <p className="mt-1 text-xs text-zinc-500">
              Overrides utm_campaign on links in newly prepared emails for
              this festival. Leave blank to use the global original or
              follow-up campaign.
            </p>
          </div>
          <PendingSubmitButton
            variant="secondary"
            size="sm"
            pendingLabel="Saving campaign…"
          >
            Save campaign
          </PendingSubmitButton>
        </form>
      </Card>

      <Card className="mt-4 p-4">
        <div className="mb-3">
          <h2 className="text-sm font-semibold">Merge artists into the lineup</h2>
          <p className="mt-1 text-xs text-zinc-500">
            Paste the latest lineup when EDMTrain is behind. Names are
            deduplicated, existing artists are reused, and manual ownership is
            merged with provider ownership so refreshes cannot remove them.
          </p>
        </div>
        <BulkManualFestivalArtistForm showId={showId} returnTo={returnTo} />
        <details className="mt-5 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <summary className="cursor-pointer text-sm font-medium">
            Add or resolve one artist
          </summary>
          <div className="mt-3">
        <ManualFestivalArtistForm showId={showId} returnTo={returnTo} />
          </div>
        </details>
      </Card>

      <div className="mt-4 space-y-2">
        {notices.utmSaved && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
            Festival UTM campaign saved.
          </div>
        )}
        {notices.lineupAdded && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
            Artist added to the festival lineup.
          </div>
        )}
        {notices.lineupRemoved && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
            Manual lineup artist removed.
          </div>
        )}
        {notices.lineupManualCleared && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
            Manual ownership removed. EDMTrain still owns this lineup entry.
          </div>
        )}
        {notices.lineupError && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
          >
            {notices.lineupError === "provider_owned"
              ? "EDMTrain owns this lineup entry, so it cannot be removed manually."
              : notices.lineupError === "invalid_artist"
                ? "The lineup artist selection was invalid."
                : "Unable to remove the manual lineup artist. Please try again."}
          </div>
        )}
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
        {notices.queueOutreach && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
            Festival outreach queued: {notices.queueManagers ?? 0} manager
            {notices.queueManagers === "1" ? "" : "s"} covering{" "}
            {notices.queueArtists ?? 0} artist
            {notices.queueArtists === "1" ? "" : "s"};{" "}
            {notices.queueSkipped ?? 0} skipped and{" "}
            {notices.queueFailed ?? 0} failed.
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
        {notices.unsent && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
            Bounced outreach marked unsent. The corrected initial email can now
            be sent again.
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
        <FestivalBulkOutreachForm
          action={bulkSend}
          formId={bulkFormId}
          hiddenFields={{
            showId,
            filter,
            genre: genreFilter,
            includeInternational: listView.includeInternational ? "1" : "0",
            dismissed: listView.dismissed ? "1" : "0",
            returnTo,
          }}
          candidates={bulkConfirmationCandidates}
          testOverride={testOverride}
        />
      )}

      <Card className={outreachEnabled ? undefined : "mt-6"}>
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
          {filtered.map((r) => {
              const canSend =
                outreachEnabled &&
                !r.association.rejectedAt &&
                r.sendability?.sendable === true;
              const canCustomize =
                outreachEnabled &&
                !r.association.rejectedAt &&
                !!r.contact &&
                !r.followUpEligibility &&
                r.sendability?.mode !== "retry";
              const bulkCandidate = bulkCandidateByArtistId.get(r.artist.id);
              const canBulkSelect = Boolean(bulkCandidate);
              const checkboxId = `festival-outreach-${r.artist.id}`;
              const reasonId = `${checkboxId}-reason`;
              const disabledReason = !r.contact
                ? "No email contact"
                : r.sendability?.reason ?? "Outreach is unavailable";
              const statusLabel = sendabilityLabel(
                r.sendability,
                r.hasTestSend
              );
              const displayStatus =
                (r.coveredOutreach?.bouncedAt ||
                r.coveredOutreach?.complainedAt
                  ? storedOutreachLabel(r.coveredOutreach)
                  : statusLabel) ??
                (r.coveredOutreach
                  ? storedOutreachLabel(r.coveredOutreach)
                  : !canSend
                    ? disabledReason
                    : null);
              const scheduledTooltip = scheduledOutreachTooltip(
                r.sendability,
                r.coveredOutreach,
              );
              const cancellableOutreach =
                r.sendability?.blockingOutreachId &&
                isCancellableOutreachStatus(
                  r.sendability.blockingStatus,
                )
                  ? {
                      id: r.sendability.blockingOutreachId,
                    }
                  : r.coveredOutreach &&
                      isCancellableOutreachStatus(r.coveredOutreach.status)
                    ? {
                        id: r.coveredOutreach.id,
                      }
                    : null;
              return (
                <li key={r.artist.id} className="flex items-center gap-3 px-4 py-3">
                  {outreachEnabled && (
                    <>
                      <input
                        id={checkboxId}
                        type="checkbox"
                        name="outreachTargets"
                        form={bulkFormId}
                        value={bulkCandidate?.selectionId ?? ""}
                        disabled={!canBulkSelect}
                        defaultChecked={
                          bulkCandidate?.selectedByDefault ?? false
                        }
                        aria-describedby={
                          !canBulkSelect ? reasonId : undefined
                        }
                        className="h-4 w-4 accent-zinc-900 disabled:cursor-not-allowed disabled:opacity-30 dark:accent-zinc-100"
                      />
                      <label htmlFor={checkboxId} className="sr-only">
                        Select {artistDisplayName(r.artist)} for{" "}
                        {bulkCandidate?.outreachKind === "follow_up"
                          ? "follow-up"
                          : "initial outreach"}
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
                        {artistDisplayName(r.artist)}
                      </ArtistLink>
                      {r.topSignal && (
                        <Badge tone="success">
                          {formatRankLabel(
                            r.topSignal.source,
                            r.topSignal.rank
                          )}
                        </Badge>
                      )}
                      {r.association.manuallyAdded && (
                        <Badge tone="info" size="xs">
                          {r.association.providerManaged
                            ? "manual + EDMTrain"
                            : "manual lineup"}
                        </Badge>
                      )}
                      {r.association.rejectedAt && (
                        <Badge tone="danger" size="xs">
                          Rejected
                        </Badge>
                      )}
                      {r.genres.slice(0, 2).map((g) => (
                        <Badge key={g} tone="muted" size="xs">{g}</Badge>
                      ))}
                      {r.displayContact &&
                        hasDirectOutreachNote(r.displayContact) && (
                          <Badge tone="warning">Direct outreach</Badge>
                        )}
                      {r.managerResearchEligible && (
                        <Badge tone="warning">Manager needed</Badge>
                      )}
                      {r.engagementOutreach && (
                        <OutreachDeliveryBadges
                          outreach={r.engagementOutreach}
                        />
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
                        {displayStatus && (
                          <>
                            {" · "}
                            <span title={scheduledTooltip ?? undefined}>
                              {r.contact
                                ? `original: ${displayStatus}`
                                : displayStatus}
                            </span>
                          </>
                        )}
                      </p>
                    ) : (
                      <p
                        id={reasonId}
                        className="mt-0.5 text-xs text-amber-700 dark:text-amber-400"
                      >
                        No email contact
                        {displayStatus && (
                          <>
                            {" · "}
                            <span title={scheduledTooltip ?? undefined}>
                              original: {displayStatus}
                            </span>
                          </>
                        )}
                        {" · "}
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
                  {outreachEnabled && cancellableOutreach && (
                      <form action={cancelScheduledAction}>
                        <input
                          type="hidden"
                          name="outreachId"
                          value={cancellableOutreach.id}
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
                          aria-label={`Cancel scheduled outreach for ${artistDisplayName(r.artist)}`}
                        >
                          Cancel
                        </PendingSubmitButton>
                      </form>
                    )}
                  {outreachEnabled &&
                    r.contact &&
                    r.coveredOutreach?.artistId === r.artist.id &&
                    r.coveredOutreach.bouncedAt && (
                      <form action={markUnsentAction}>
                        <input
                          type="hidden"
                          name="outreachId"
                          value={r.coveredOutreach.id}
                        />
                        <input
                          type="hidden"
                          name="contactId"
                          value={r.contact.id}
                        />
                        <input
                          type="hidden"
                          name="returnTo"
                          value={returnTo}
                        />
                        <PendingSubmitButton
                          variant="secondary"
                          size="sm"
                          pendingLabel="Marking unsent…"
                        >
                          Mark unsent
                        </PendingSubmitButton>
                      </form>
                    )}
                  {r.coveredOutreach?.status === "failed" && r.coveredOutreach.bouncedAt && (
                    <LinkButton
                      href={`/outreach/${r.coveredOutreach.id}/resend`}
                      variant="secondary"
                      size="sm"
                    >
                      Review &amp; resend
                    </LinkButton>
                  )}
                  {outreachEnabled &&
                    !r.association.rejectedAt &&
                    r.followUpEligibility && (
                    <FollowUpButton
                      eligibility={r.followUpEligibility}
                      returnTo={returnTo}
                      isWeekend={weekend}
                      action={sendFollowUpAction}
                      cancelAction={cancelScheduledAction}
                      showId={showId}
                    />
                  )}
                  {r.association.rejectedAt ? (
                    <form action={restoreRejectedFestivalArtistAction}>
                      <input type="hidden" name="showId" value={showId} />
                      <input
                        type="hidden"
                        name="targetArtistId"
                        value={r.artist.id}
                      />
                      <input type="hidden" name="returnTo" value={returnTo} />
                      <PendingSubmitButton
                        variant="secondary"
                        size="sm"
                        pendingLabel="Restoring…"
                      >
                        Restore
                      </PendingSubmitButton>
                    </form>
                  ) : (
                    <RejectWorkflowTargetButton
                      showId={showId}
                      targetArtistId={r.artist.id}
                      returnTo={returnTo}
                    />
                  )}
                  {outreachEnabled &&
                    !r.association.rejectedAt &&
                    r.manualMarker && (
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
                  {outreachEnabled &&
                    !r.association.rejectedAt &&
                    r.canMarkManually && (
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
                          name="targetArtistId"
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
                  {r.association.manuallyAdded && (
                    <form action={removeManualFestivalArtist}>
                      <input type="hidden" name="showId" value={showId} />
                      <input
                        type="hidden"
                        name="artistId"
                        value={r.artist.id}
                      />
                      <input
                        type="hidden"
                        name="returnTo"
                        value={returnTo}
                      />
                      <PendingSubmitButton
                        variant="danger"
                        size="sm"
                        pendingLabel="Removing…"
                        aria-label={`Remove ${artistDisplayName(r.artist)} from the manual lineup`}
                      >
                        Remove
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
