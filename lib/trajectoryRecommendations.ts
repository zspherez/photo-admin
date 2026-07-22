import { randomUUID } from "node:crypto";
import type { TrajectoryArm, TrajectoryRunStatus } from "@prisma/client";
import { db } from "@/lib/db";
import {
  pickDirectOutreachContact,
  pickEmailContact,
  pickPhoneContact,
} from "@/lib/contactSelection";
import { contactDisplayValue } from "@/lib/contactDisplay";
import {
  getOutreachSendabilityBatch,
  getFollowUpEligibilityBatch,
  type FollowUpEligibility,
  type OutreachSendability,
  type OutreachSendabilityInput,
} from "@/lib/sendOutreach";
import {
  canMarkOutreachManually,
  isActiveManualOutreachMarker,
} from "@/lib/manualOutreach";
import { isCancellableOutreachStatus } from "@/lib/outreachStatus";
import {
  recommendationDateRange,
  type RecommendationQuery,
} from "@/lib/trajectoryRecommendationQuery";
import {
  TRAJECTORY_PRODUCER,
} from "@/lib/trajectoryContract";
import {
  resolveTrajectoryRun,
  trajectoryFreshnessCutoff,
  type TrajectoryRunAvailability,
} from "@/lib/trajectoryActiveRun";
import {
  dateOnlyFromStoredDate,
  easternDateOnly,
} from "@/lib/calendarDate";
import type {
  AnalogSummaryView,
  ContactCategory,
  RecommendationView,
  TrajectoryDecisionView,
  TrajectoryOutcomeView,
} from "@/lib/trajectoryRecommendationView";

export const RECOMMENDATION_BATCH_SIZE = 48;
export const PROVISIONAL_TRAJECTORY_DISCLAIMER =
  "Provisional heuristic; not a validated breakout probability.";

const SENT_OR_SCHEDULED_STATUSES = new Set([
  "sent",
  "scheduled",
  "retry_scheduled",
]);

interface RunRecord {
  id: string;
  generatedAt: Date;
  asOfDate: Date;
  decisionDate: Date;
  minimumShowDate: Date;
  validUntil: Date;
  modelStatus: string;
  status: TrajectoryRunStatus;
  failureCode: string | null;
  failureMessage: string | null;
}

interface ContactRecord {
  id: string;
  email: string | null;
  phone: string | null;
  directOutreachNote: string | null;
  state: "active" | "quarantined";
  isFullTeam: boolean;
  name: string | null;
}

interface OutreachRecord {
  id: string;
  artistId: string;
  contactId: string | null;
  kind: "original" | "follow_up";
  status: string;
  providerMessageId: string | null;
  attemptCount: number;
  scheduledFor: Date | null;
  nextAttemptAt: Date | null;
  finalSubject: string;
  finalHtml: string;
  _count: { sendAttempts: number };
  sentAt: Date | null;
  deliveredAt: Date | null;
  openCount: number;
  clickCount: number;
}

interface RecommendationRecord {
  id: string;
  showId: string;
  arm: TrajectoryArm;
  listRank: number;
  isSuggested: boolean;
  slatePosition: number | null;
  billingPosition: number;
  lineupSize: number;
  isFirstBilled: boolean;
  feedback?: Array<{
    id: string;
    action: "selected" | "declined" | "saved" | "dismissed" | "manual_override";
    propensity: number | null;
    manualOverride: boolean;
    notes: string | null;
    supersedesId: string | null;
    recordedAt: Date;
  }>;
  outcomes?: Array<{
    id: string;
    attended: boolean | null;
    access: "none" | "guestlist" | "photo_pass" | "other" | null;
    keeperCount: number | null;
    relationshipValue: number | null;
    publicationValue: number | null;
    shootability: "good" | "ok" | "poor" | null;
    venueAccessibility: "high" | "medium" | "low" | null;
    notes: string | null;
    supersedesId: string | null;
    recordedAt: Date;
  }>;
  show: {
    id: string;
    date: Date;
    venueName: string;
    city: string;
    state: string | null;
    ticketUrl: string | null;
    eventName: string | null;
    syncStatus: string;
    dismissedAt: Date | null;
    interestedAt: Date | null;
    outreaches: OutreachRecord[];
  };
  runArtist: {
    coverageState:
      | "C_covered"
      | "U0_unresolved"
      | "U1_no_history"
      | "U2_thin_history"
      | "Q_query_incomplete"
      | "Q_query_failure"
      | "J_junk";
    momentumBand: string | null;
    isEarlyStage: boolean;
    isEstablished: boolean;
    isVeteran: boolean;
    eventDelta6m: number | null;
    eventsPrior6m: number | null;
    eventsRecent6m: number | null;
    marketsPrior6m: number | null;
    marketsRecent6m: number | null;
    careerAgeYears: number | null;
    analogSummary: unknown;
    releaseContext: unknown;
    genres: unknown;
    artist: {
      id: string;
      name: string;
      contacts: ContactRecord[];
    } | null;
  };
}

export interface RecommendationReadRequest {
  runId: string;
  producer: typeof TRAJECTORY_PRODUCER;
  status: "ready";
  validAfter: Date;
  generatedAfter: Date;
  showStart: Date;
  showEndExclusive: Date;
  tab: RecommendationQuery["tab"];
}

export interface TrajectoryRecommendationStore {
  findReadyRuns(
    producer: typeof TRAJECTORY_PRODUCER,
    limit: number,
  ): Promise<RunRecord[]>;
  findLatestRun(
    producer: typeof TRAJECTORY_PRODUCER,
  ): Promise<RunRecord | null>;
  findRecommendations(
    request: RecommendationReadRequest,
  ): Promise<RecommendationRecord[]>;
}

const RUN_SELECT = {
  id: true,
  generatedAt: true,
  asOfDate: true,
  decisionDate: true,
  minimumShowDate: true,
  validUntil: true,
  modelStatus: true,
  status: true,
  failureCode: true,
  failureMessage: true,
} as const;

const DEFAULT_STORE: TrajectoryRecommendationStore = {
  findReadyRuns: (producer, limit) =>
    db.trajectoryModelRun.findMany({
      where: { producer, status: "ready" },
      orderBy: [{ generatedAt: "desc" }, { id: "desc" }],
      take: limit,
      select: RUN_SELECT,
    }),
  findLatestRun: (producer) =>
    db.trajectoryModelRun.findFirst({
      where: { producer },
      orderBy: [{ generatedAt: "desc" }, { id: "desc" }],
      select: RUN_SELECT,
    }),
  findRecommendations: (request) =>
    db.trajectoryRecommendation.findMany({
      where: {
        runId: request.runId,
        run: {
          is: {
            producer: request.producer,
            status: request.status,
            validUntil: { gt: request.validAfter },
            generatedAt: { gt: request.generatedAfter },
          },
        },
        ...(request.tab === "suggested"
          ? { isSuggested: true }
          : {
              arm:
                request.tab === "momentum"
                  ? "momentum"
                  : request.tab,
            }),
        show: {
          is: {
            syncStatus: "active",
            date: {
              gte: request.showStart,
              lt: request.showEndExclusive,
            },
          },
        },
        runArtist: {
          is: {
            artistId: { not: null },
            artist: { isNot: null },
          },
        },
      },
      orderBy: [
        { show: { date: "asc" } },
        ...(request.tab === "suggested"
          ? ([{ slatePosition: "asc" }] as const)
          : ([{ listRank: "asc" }] as const)),
        { id: "asc" },
      ],
      select: {
        id: true,
        showId: true,
        arm: true,
        listRank: true,
        isSuggested: true,
        slatePosition: true,
        billingPosition: true,
        lineupSize: true,
        isFirstBilled: true,
        feedback: {
          orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
          select: {
            id: true,
            action: true,
            propensity: true,
            manualOverride: true,
            notes: true,
            supersedesId: true,
            recordedAt: true,
          },
        },
        outcomes: {
          orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
          select: {
            id: true,
            attended: true,
            access: true,
            keeperCount: true,
            relationshipValue: true,
            publicationValue: true,
            shootability: true,
            venueAccessibility: true,
            notes: true,
            supersedesId: true,
            recordedAt: true,
          },
        },
        show: {
          select: {
            id: true,
            date: true,
            venueName: true,
            city: true,
            state: true,
            ticketUrl: true,
            eventName: true,
            syncStatus: true,
            dismissedAt: true,
            interestedAt: true,
            outreaches: {
              where: { kind: "original" },
              orderBy: [{ createdAt: "desc" }, { id: "asc" }],
              select: {
                id: true,
                artistId: true,
                contactId: true,
                kind: true,
                status: true,
                providerMessageId: true,
                attemptCount: true,
                scheduledFor: true,
                nextAttemptAt: true,
                finalSubject: true,
                finalHtml: true,
                sentAt: true,
                deliveredAt: true,
                openCount: true,
                clickCount: true,
                _count: { select: { sendAttempts: true } },
              },
            },
          },
        },
        runArtist: {
          select: {
            coverageState: true,
            momentumBand: true,
            isEarlyStage: true,
            isEstablished: true,
            isVeteran: true,
            eventDelta6m: true,
            eventsPrior6m: true,
            eventsRecent6m: true,
            marketsPrior6m: true,
            marketsRecent6m: true,
            careerAgeYears: true,
            analogSummary: true,
            releaseContext: true,
            genres: true,
            artist: {
              select: {
                id: true,
                name: true,
                contacts: {
                  orderBy: [{ isFullTeam: "desc" }, { id: "asc" }],
                  select: {
                    id: true,
                    email: true,
                    phone: true,
                    directOutreachNote: true,
                    state: true,
                    isFullTeam: true,
                    name: true,
                  },
                },
              },
            },
          },
        },
      },
    }) as Promise<RecommendationRecord[]>,
};

export type RecommendationAvailability =
  TrajectoryRunAvailability;

export interface RecommendationRun {
  id: string;
  generatedAt: string;
  asOfDate: string;
  decisionDate: string;
  minimumShowDate: string;
  validUntil: string;
  modelStatus: string;
  status: TrajectoryRunStatus;
  failureCode: string | null;
  failureMessage: string | null;
  freshness: "fresh" | "stale";
}

export interface RecommendationPageResult {
  availability: RecommendationAvailability;
  run: RecommendationRun | null;
  recommendations: RecommendationView[];
  total: number;
  nextOffset: number | null;
}

interface LoadOptions {
  now?: Date;
  offset?: number;
  expectedRunId?: string;
  store?: TrajectoryRecommendationStore;
  sendability?: (
    inputs: readonly OutreachSendabilityInput[],
    now: Date,
  ) => Promise<OutreachSendability[]>;
  followUpEligibility?: (
    parentOutreachIds: readonly string[],
    now: Date,
  ) => Promise<FollowUpEligibility[]>;
}

function runView(run: RunRecord, now: Date): RecommendationRun {
  return {
    id: run.id,
    generatedAt: run.generatedAt.toISOString(),
    asOfDate: dateOnlyFromStoredDate(run.asOfDate),
    decisionDate: dateOnlyFromStoredDate(run.decisionDate),
    minimumShowDate: dateOnlyFromStoredDate(run.minimumShowDate),
    validUntil: run.validUntil.toISOString(),
    modelStatus: run.modelStatus,
    status: run.status,
    failureCode: run.failureCode,
    failureMessage: run.failureMessage,
    freshness:
      run.generatedAt.getTime() > trajectoryFreshnessCutoff(now).getTime()
        ? "fresh"
        : "stale",
  };
}

export async function resolveRecommendationRun(
  now: Date,
  store: TrajectoryRecommendationStore = DEFAULT_STORE,
): Promise<{
  availability: RecommendationAvailability;
  run: RunRecord | null;
}> {
  return resolveTrajectoryRun(now, store);
}

function analogSummary(value: unknown): AnalogSummaryView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    !Array.isArray(row.nearest) ||
    typeof row.sustained_positive_neighbors !== "number" ||
    typeof row.k !== "number" ||
    typeof row.sustained_pool_base_rate !== "number"
  ) {
    return null;
  }
  const names = row.nearest
    .map((item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? (item as Record<string, unknown>).name
        : null,
    )
    .filter((name): name is string => typeof name === "string")
    .slice(0, 3);
  return {
    names,
    positiveNeighbors: row.sustained_positive_neighbors,
    neighborCount: row.k,
    poolBaseRatePercent: Math.round(row.sustained_pool_base_rate * 100),
  };
}

function coverageReason(state: RecommendationRecord["runArtist"]["coverageState"]): string {
  const labels: Record<typeof state, string> = {
    C_covered: "Booking history is covered by the model.",
    U0_unresolved: "Booking-history coverage is unresolved.",
    U1_no_history: "No prior booking history was found.",
    U2_thin_history: "Only thin prior booking history was found.",
    Q_query_incomplete: "Booking-history query coverage is incomplete.",
    Q_query_failure: "Booking-history query failed.",
    J_junk: "Booking-history evidence was classified as unusable.",
  };
  return labels[state];
}

function rationaleFor(row: RecommendationRecord): string[] {
  const evidence = row.runArtist;
  const reasons: string[] = [];
  if (
    evidence.eventsPrior6m !== null &&
    evidence.eventsRecent6m !== null
  ) {
    reasons.push(
      `Completed bookings ${evidence.eventsPrior6m} → ${evidence.eventsRecent6m} in the compared six-month windows.`,
    );
  }
  if (evidence.isEarlyStage) reasons.push("Early-stage criteria met.");
  if (row.arm === "exploration") reasons.push(coverageReason(evidence.coverageState));
  if (row.arm === "portfolio") {
    if (evidence.isEstablished && evidence.isVeteran) {
      reasons.push("Established and veteran portfolio criteria met.");
    } else if (evidence.isEstablished) {
      reasons.push("Established portfolio criteria met.");
    } else if (evidence.isVeteran) {
      reasons.push("Veteran portfolio criteria met.");
    }
  }
  if (row.arm === "momentum" && evidence.momentumBand) {
    reasons.push(`Momentum band: ${evidence.momentumBand.replaceAll("_", " ")}.`);
  }
  if (reasons.length === 0) reasons.push(coverageReason(evidence.coverageState));
  return reasons;
}

function outreachLabels(rows: readonly OutreachRecord[]): string[] {
  const labels = new Set<string>();
  for (const row of rows) {
    if (row.status === "failed") labels.add("Failed");
    else if (row.status === "manual_review") labels.add("Manual review");
    else if (row.status === "queued") labels.add("Queued");
    else if (row.status === "scheduled") labels.add("Scheduled");
    else if (row.status === "retry_scheduled") labels.add("Retry scheduled");
    else if (row.status === "cancelled") labels.add("Cancelled");
    else if (row.status === "test") labels.add("Test sent");
    else if (row.sentAt || row.status === "sent") labels.add("Sent");
    else labels.add(row.status.replaceAll("_", " "));
  }
  if (rows.some((row) => row.deliveredAt)) labels.add("Delivered");
  const opens = rows.reduce((total, row) => total + row.openCount, 0);
  const clicks = rows.reduce((total, row) => total + row.clickCount, 0);
  if (opens > 0) labels.add(opens === 1 ? "Opened" : `Opened (${opens})`);
  if (clicks > 0) labels.add(clicks === 1 ? "Clicked" : `Clicked (${clicks})`);
  return labels.size > 0 ? [...labels] : ["No outreach"];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function currentEvidenceId(
  rows: readonly { id: string; supersedesId: string | null }[],
): string | null {
  const supersededIds = new Set(
    rows.flatMap((row) => (row.supersedesId ? [row.supersedesId] : [])),
  );
  return rows.find((row) => !supersededIds.has(row.id))?.id ?? null;
}

function decisionHistory(
  rows: NonNullable<RecommendationRecord["feedback"]>,
): TrajectoryDecisionView[] {
  const currentId = currentEvidenceId(rows);
  return rows.map((row) => ({
    ...row,
    recordedAt: row.recordedAt.toISOString(),
    isCurrent: row.id === currentId,
  }));
}

function outcomeHistory(
  rows: NonNullable<RecommendationRecord["outcomes"]>,
): TrajectoryOutcomeView[] {
  const currentId = currentEvidenceId(rows);
  return rows.map((row) => ({
    ...row,
    recordedAt: row.recordedAt.toISOString(),
    isCurrent: row.id === currentId,
  }));
}

export function trajectoryOutcomeRecordability(
  showDate: Date,
  now: Date,
  hasExistingOutcome: boolean,
): {
  recordable: boolean;
  message: string | null;
} {
  const showDateOnly = dateOnlyFromStoredDate(showDate);
  if (hasExistingOutcome) {
    return {
      recordable: true,
      message:
        showDateOnly > easternDateOnly(now)
          ? "Correction remains available because an outcome was already recorded before the canonical date changed."
          : null,
    };
  }
  if (showDateOnly <= easternDateOnly(now)) {
    return { recordable: true, message: null };
  }
  return {
    recordable: false,
    message: `Outcome entry opens on ${showDateOnly}, using the canonical show date and Eastern calendar day.`,
  };
}

function matchesWorkflow(
  row: RecommendationView,
  outreach: readonly OutreachRecord[],
  workflow: RecommendationQuery["workflow"],
): boolean {
  if (workflow === "all") return true;
  if (workflow === "ready") return row.contactCategory === "ready_email";
  if (workflow === "needs") return row.contactCategory === "needs_email";
  if (workflow === "direct") return row.contactCategory === "direct_outreach";
  if (workflow === "interested") return row.interested;
  if (workflow === "dismissed") return row.dismissed;
  if (workflow === "opened") {
    return outreach.some((item) => item.openCount > 0);
  }
  if (workflow === "clicked") {
    return outreach.some((item) => item.clickCount > 0);
  }
  return outreach.some((item) => SENT_OR_SCHEDULED_STATUSES.has(item.status));
}

function workflowPriority(
  row: Pick<
    RecommendationView,
    "interested" | "contactCategory" | "isSuggested" | "arm"
  >,
): RecommendationView["workflowPriority"] {
  if (row.interested && row.contactCategory === "ready_email") {
    return { rank: 1, label: "Interested + ready to send" };
  }
  if (row.isSuggested && row.arm === "trajectory") {
    return { rank: 2, label: "Suggested trajectory" };
  }
  if (row.arm === "trajectory") {
    return { rank: 3, label: "Other trajectory" };
  }
  if (row.arm === "momentum") {
    return { rank: 4, label: "Broader momentum" };
  }
  if (row.arm === "exploration") {
    return { rank: 6, label: "Exploration" };
  }
  return { rank: 7, label: "Portfolio" };
}

function framingLabel(arm: RecommendationView["arm"]): string {
  if (arm === "exploration") return "Listen/research first";
  if (arm === "portfolio") return "Portfolio credibility framing";
  return "Relationship-building framing";
}

function scheduledLabel(
  status: string | undefined,
  scheduledAt: Date | undefined,
): string {
  if (!scheduledAt) {
    return status === "retry_scheduled" ? "Retry scheduled" : "Scheduled";
  }
  const prefix = status === "retry_scheduled" ? "Retry" : "Scheduled";
  return `${prefix} · ${scheduledAt.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })}`;
}

export async function getTrajectoryRecommendationPage(
  query: RecommendationQuery,
  options: LoadOptions = {},
): Promise<RecommendationPageResult> {
  const now = options.now ?? new Date();
  const offset = options.offset ?? 0;
  const store = options.store ?? DEFAULT_STORE;
  const resolved = await resolveRecommendationRun(now, store);
  const run = resolved.run ? runView(resolved.run, now) : null;
  if (
    resolved.availability !== "ready" ||
    !resolved.run ||
    (options.expectedRunId && options.expectedRunId !== resolved.run.id)
  ) {
    return {
      availability:
        options.expectedRunId && resolved.availability === "ready"
          ? "superseded"
          : resolved.availability,
      run,
      recommendations: [],
      total: 0,
      nextOffset: null,
    };
  }

  const dateRange = recommendationDateRange(
    query.dateBand,
    now,
    resolved.run.minimumShowDate,
  );
  const records = await store.findRecommendations({
    runId: resolved.run.id,
    producer: TRAJECTORY_PRODUCER,
    status: "ready",
    validAfter: now,
    generatedAfter: trajectoryFreshnessCutoff(now),
    showStart: dateRange.start,
    showEndExclusive: dateRange.endExclusive,
    tab: query.tab,
  });

  const uniqueRecords: RecommendationRecord[] = [];
  const identities = new Set<string>();
  for (const record of records) {
    const artist = record.runArtist.artist;
    if (!artist || record.show.syncStatus !== "active") continue;
    const identity = `${record.showId}\u0000${artist.id}\u0000${record.arm}`;
    if (identities.has(identity)) continue;
    identities.add(identity);
    uniqueRecords.push(record);
  }

  const emailTargets = new Map<string, OutreachSendabilityInput>();
  for (const record of uniqueRecords) {
    const contact = pickEmailContact(record.runArtist.artist?.contacts ?? []);
    if (!contact) continue;
    const key = `${record.showId}\u0000${contact.id}`;
    emailTargets.set(key, { showId: record.showId, contactId: contact.id });
  }
  const sendabilityRows = await (
    options.sendability ?? getOutreachSendabilityBatch
  )([...emailTargets.values()], now);
  const sendabilityByTarget = new Map(
    sendabilityRows.map((item) => [
      `${item.showId}\u0000${item.contactId}`,
      item,
    ]),
  );
  const parentOutreachIds = uniqueRecords.flatMap((record) =>
    record.show.outreaches.flatMap((outreach) =>
      outreach.kind === "original" ? [outreach.id] : [],
    ),
  );
  const followUpRows =
    parentOutreachIds.length === 0
      ? []
      : options.followUpEligibility
        ? await options.followUpEligibility(parentOutreachIds, now)
        : store === DEFAULT_STORE
          ? await getFollowUpEligibilityBatch(parentOutreachIds, now)
          : [];
  const followUpByParent = new Map(
    followUpRows.map((row) => [row.parentOutreachId, row]),
  );

  const filtered: RecommendationView[] = [];
  for (const record of uniqueRecords) {
    const artist = record.runArtist.artist;
    if (!artist) continue;
    const relevantOutreach = record.show.outreaches.filter(
      (item) => item.artistId === artist.id && item.kind === "original",
    );
    const email = pickEmailContact(artist.contacts);
    const phone = pickPhoneContact(artist.contacts, email);
    const direct = pickDirectOutreachContact(artist.contacts);
    const sendability = email
      ? sendabilityByTarget.get(`${record.showId}\u0000${email.id}`)
      : null;
    const artistOutreaches = relevantOutreach;
    const preferredOutreach =
      artistOutreaches.find((outreach) =>
        [
          "sent",
          "scheduled",
          "retry_scheduled",
          "queued",
          "manual_review",
        ].includes(outreach.status),
      ) ??
      artistOutreaches.find((outreach) => outreach.status === "failed") ??
      artistOutreaches.find((outreach) => outreach.status === "test");
    const followUpEligibility =
      artistOutreaches
        .map((row) => followUpByParent.get(row.id))
        .find(
          (row) =>
            row &&
            (row.state === "eligible" ||
              row.state === "pending" ||
              row.state === "sent"),
        ) ?? null;
    const scheduledOutreach =
      artistOutreaches.find(
        (row) => row.id === sendability?.blockingOutreachId,
      ) ??
      (isCancellableOutreachStatus(preferredOutreach?.status)
        ? preferredOutreach
        : undefined);
    const scheduledStatus =
      sendability?.blockingStatus ?? scheduledOutreach?.status;
    const scheduledAt =
      sendability?.blockingNextAttemptAt ??
      scheduledOutreach?.nextAttemptAt ??
      scheduledOutreach?.scheduledFor ??
      undefined;
    const scheduledInfo =
      isCancellableOutreachStatus(scheduledStatus) && scheduledOutreach
        ? {
            outreachId:
              sendability?.blockingOutreachId ?? scheduledOutreach.id,
            scheduledLabel: scheduledLabel(scheduledStatus, scheduledAt),
          }
        : null;
    const manualMarker =
      artistOutreaches.find((outreach) =>
        isActiveManualOutreachMarker({
          id: outreach.id,
          kind: outreach.kind,
          showId: record.showId,
          artistId: outreach.artistId,
          status: outreach.status,
          providerMessageId: outreach.providerMessageId,
          attemptCount: outreach.attemptCount,
          sendAttemptCount: outreach._count?.sendAttempts ?? 0,
          finalSubject: outreach.finalSubject,
          finalHtml: outreach.finalHtml,
        }),
      ) ?? null;
    const contactCategory: ContactCategory = email
      ? sendability?.sendable
        ? "ready_email"
        : "email_blocked"
      : phone || direct
        ? "direct_outreach"
        : "needs_email";
    const displayContact = email ?? phone ?? direct;
    const outcomeAvailability = trajectoryOutcomeRecordability(
      record.show.date,
      now,
      (record.outcomes?.length ?? 0) > 0,
    );
    const view: RecommendationView = {
      id: record.id,
      runId: resolved.run.id,
      trajectoryActionId: randomUUID(),
      identityKey: `${record.showId}:${artist.id}:${record.arm}`,
      showId: record.show.id,
      showDate: record.show.date.toISOString(),
      venueName: record.show.venueName,
      location: [record.show.city, record.show.state]
        .filter(Boolean)
        .join(", "),
      ticketUrl: record.show.ticketUrl,
      eventName: record.show.eventName,
      artistId: artist.id,
      artistName: artist.name,
      arm: record.arm,
      listRank: record.listRank,
      isSuggested: record.isSuggested,
      slatePosition: record.slatePosition,
      billingPosition: record.billingPosition,
      lineupSize: record.lineupSize,
      isFirstBilled: record.isFirstBilled,
      interested: record.show.interestedAt !== null,
      dismissed: record.show.dismissedAt !== null,
      contactCategory,
      contactLabel:
        contactCategory === "ready_email"
          ? "Ready email"
          : contactCategory === "needs_email"
            ? "Needs email"
            : contactCategory === "direct_outreach"
              ? "Direct outreach"
              : "Email blocked",
      contactDetail: displayContact
        ? contactDisplayValue(displayContact, "")
        : null,
      emailContact: email ? { id: email.id, name: email.name } : null,
      phoneContact:
        phone?.phone
          ? { phone: phone.phone, name: phone.name }
          : null,
      contactId: displayContact?.id ?? null,
      sendability: sendability
        ? {
            sendable: sendability.sendable,
            mode: sendability.mode,
            reason: sendability.reason,
            blockingOutreachId: sendability.blockingOutreachId ?? null,
            blockingStatus: sendability.blockingStatus ?? null,
            blockingNextAttemptAt:
              sendability.blockingNextAttemptAt?.toISOString() ?? null,
          }
        : null,
      alreadySent:
        sendability?.blockingStatus === "sent" ||
        preferredOutreach?.status === "sent",
      scheduledInfo,
      followUpEligibility: followUpEligibility
        ? {
            parentOutreachId: followUpEligibility.parentOutreachId,
            eligible: followUpEligibility.eligible,
            state: followUpEligibility.state,
            mode: followUpEligibility.mode,
            reason: followUpEligibility.reason,
            recipients: followUpEligibility.recipients,
            fullTeamSend: followUpEligibility.fullTeamSend,
            followUpOutreachId: followUpEligibility.followUpOutreachId,
            followUpStatus: followUpEligibility.followUpStatus,
            nextAttemptAt:
              followUpEligibility.nextAttemptAt?.toISOString(),
          }
        : null,
      canMarkManually: canMarkOutreachManually(
        artistOutreaches.map((outreach) => ({
          status: outreach.status,
          providerMessageId: outreach.providerMessageId,
          attemptCount: outreach.attemptCount,
          sendAttemptCount: outreach._count?.sendAttempts ?? 0,
        })),
      ),
      manualMarkerId: manualMarker?.id ?? null,
      workflowPriority: { rank: 0, label: "" },
      framingLabel: framingLabel(record.arm),
      outreachLabels: outreachLabels(relevantOutreach),
      decisionHistory: decisionHistory(record.feedback ?? []),
      outcomeHistory: outcomeHistory(record.outcomes ?? []),
      outcomeRecordable: outcomeAvailability.recordable,
      outcomeRecordabilityMessage: outcomeAvailability.message,
      rationale: rationaleFor(record),
      analogSummary: analogSummary(record.runArtist.analogSummary),
      details: {
        coverageState: record.runArtist.coverageState,
        momentumBand: record.runArtist.momentumBand,
        eventDelta6m: record.runArtist.eventDelta6m,
        eventsPrior6m: record.runArtist.eventsPrior6m,
        eventsRecent6m: record.runArtist.eventsRecent6m,
        marketsPrior6m: record.runArtist.marketsPrior6m,
        marketsRecent6m: record.runArtist.marketsRecent6m,
        careerAgeYears: record.runArtist.careerAgeYears,
        genres: stringArray(record.runArtist.genres),
        releaseContext: record.runArtist.releaseContext,
      },
    };
    view.workflowPriority = workflowPriority(view);
    if (matchesWorkflow(view, relevantOutreach, query.workflow)) {
      filtered.push(view);
    }
  }

  filtered.sort(
    (left, right) =>
      left.workflowPriority.rank - right.workflowPriority.rank ||
      left.showDate.localeCompare(right.showDate) ||
      (left.slatePosition ?? left.listRank) -
        (right.slatePosition ?? right.listRank) ||
      left.id.localeCompare(right.id),
  );

  const page = filtered.slice(offset, offset + RECOMMENDATION_BATCH_SIZE);
  const nextOffset =
    offset + page.length < filtered.length ? offset + page.length : null;
  return {
    availability: "ready",
    run,
    recommendations: page,
    total: filtered.length,
    nextOffset,
  };
}
