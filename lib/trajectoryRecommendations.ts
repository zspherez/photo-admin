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
  type OutreachSendability,
  type OutreachSendabilityInput,
} from "@/lib/sendOutreach";
import {
  recommendationDateRange,
  type RecommendationQuery,
} from "@/lib/trajectoryRecommendationQuery";
import {
  TRAJECTORY_PRODUCER,
  TRAJECTORY_STALE_AFTER_HOURS,
} from "@/lib/trajectoryContract";
import { dateOnlyFromStoredDate } from "@/lib/calendarDate";
import type {
  AnalogSummaryView,
  ContactCategory,
  RecommendationView,
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
}

interface OutreachRecord {
  artistId: string;
  kind: "original" | "follow_up";
  status: string;
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
                artistId: true,
                kind: true,
                status: true,
                sentAt: true,
                deliveredAt: true,
                openCount: true,
                clickCount: true,
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
  | "ready"
  | "none"
  | "failed"
  | "stale"
  | "expired"
  | "superseded"
  | "multiple_ready";

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
}

function freshnessCutoff(now: Date): Date {
  return new Date(
    now.getTime() - TRAJECTORY_STALE_AFTER_HOURS * 60 * 60 * 1_000,
  );
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
      run.generatedAt.getTime() > freshnessCutoff(now).getTime()
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
  const readyRuns = await store.findReadyRuns(TRAJECTORY_PRODUCER, 2);
  if (readyRuns.length > 1) {
    return { availability: "multiple_ready", run: readyRuns[0] };
  }
  if (readyRuns.length === 1) {
    const run = readyRuns[0];
    if (run.validUntil.getTime() <= now.getTime()) {
      return { availability: "expired", run };
    }
    if (run.generatedAt.getTime() <= freshnessCutoff(now).getTime()) {
      return { availability: "stale", run };
    }
    return { availability: "ready", run };
  }

  const latest = await store.findLatestRun(TRAJECTORY_PRODUCER);
  if (!latest) return { availability: "none", run: null };
  if (latest.status === "failed") return { availability: "failed", run: latest };
  if (latest.status === "stale") return { availability: "stale", run: latest };
  if (latest.validUntil.getTime() <= now.getTime()) {
    return { availability: "expired", run: latest };
  }
  return { availability: "superseded", run: latest };
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
    generatedAfter: freshnessCutoff(now),
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
    const contactCategory: ContactCategory = email
      ? sendability?.sendable
        ? "ready_email"
        : "email_blocked"
      : phone || direct
        ? "direct_outreach"
        : "needs_email";
    const displayContact = email ?? phone ?? direct;
    const view: RecommendationView = {
      id: record.id,
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
      outreachLabels: outreachLabels(relevantOutreach),
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
    if (matchesWorkflow(view, relevantOutreach, query.workflow)) {
      filtered.push(view);
    }
  }

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
