import type {
  TrajectoryArm,
  TrajectoryFeedbackAction,
  TrajectoryImportIssueCode,
  TrajectoryRunStatus,
} from "@prisma/client";
import { db } from "@/lib/db";
import {
  pickDirectOutreachContact,
  pickEmailContact,
  pickPhoneContact,
} from "@/lib/contactSelection";
import { getOutreachSendabilityBatch } from "@/lib/sendOutreach";
import {
  resolveTrajectoryRun,
  type TrajectoryRunAvailability,
  type TrajectoryRunStore,
} from "@/lib/trajectoryActiveRun";
import { TRAJECTORY_ARMS } from "@/lib/trajectoryContract";

interface MetricsRunRecord {
  id: string;
  producerRunId: string;
  generatedAt: Date;
  validUntil: Date;
  importedAt: Date;
  activatedAt: Date | null;
  artifactByteLength: number;
  status: TrajectoryRunStatus;
  summary: unknown;
}

interface RunIssueInput {
  code: TrajectoryImportIssueCode;
  recommendationKey: string | null;
  detail: unknown;
}

interface ContactInput {
  id: string;
  email: string | null;
  phone: string | null;
  directOutreachNote: string | null;
  isFullTeam: boolean;
  state: "active" | "quarantined";
}

interface SuggestedRecommendationInput {
  showId: string;
  showDate: Date;
  contacts: ContactInput[];
}

interface RunMetricsInput {
  persistedArtistRows: number;
  persistedRecommendationRows: number;
  persistedSuggestedRows: number;
  summary: unknown;
  issues: RunIssueInput[];
  activeSuggested: SuggestedRecommendationInput[];
  readiness: Array<{
    showId: string;
    contactId: string;
    sendable: boolean;
  }>;
}

interface DecisionInput {
  id: string;
  recommendationId: string;
  runId: string;
  arm: TrajectoryArm;
  action: TrajectoryFeedbackAction;
  recordedAt: Date;
  superseded: boolean;
}

interface OutcomeInput {
  id: string;
  recommendationId: string;
  runId: string;
  arm: TrajectoryArm;
  attended: boolean | null;
  access: "none" | "guestlist" | "photo_pass" | "other" | null;
  keeperCount: number | null;
  relationshipValue: number | null;
  publicationValue: number | null;
  shootability: "good" | "ok" | "poor" | null;
  venueAccessibility: "high" | "medium" | "low" | null;
  recordedAt: Date;
  superseded: boolean;
}

interface EngagementInput {
  runId: string;
  arm: TrajectoryArm;
  status: string;
  createdAt: Date;
  sentAt: Date | null;
  deliveredAt: Date | null;
  firstOpenedAt: Date | null;
  lastOpenedAt: Date | null;
  openCount: number;
  firstClickedAt: Date | null;
  lastClickedAt: Date | null;
  clickCount: number;
  bouncedAt: Date | null;
  complainedAt: Date | null;
}

interface HistoricalMetricsInput {
  decisions: DecisionInput[];
  outcomes: OutcomeInput[];
  engagement: EngagementInput[];
}

export interface TrajectoryMetricsStore
  extends TrajectoryRunStore<MetricsRunRecord> {
  loadRunMetrics(runId: string, now: Date): Promise<RunMetricsInput>;
  loadHistoricalMetrics(): Promise<HistoricalMetricsInput>;
}

const RUN_SELECT = {
  id: true,
  producerRunId: true,
  generatedAt: true,
  validUntil: true,
  importedAt: true,
  activatedAt: true,
  artifactByteLength: true,
  status: true,
  summary: true,
} as const;

const DEFAULT_STORE: TrajectoryMetricsStore = {
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
  async loadRunMetrics(runId, now) {
    const [
      persistedArtistRows,
      persistedRecommendationRows,
      persistedSuggestedRows,
      run,
      issues,
      recommendations,
    ] = await Promise.all([
      db.trajectoryRunArtist.count({ where: { runId } }),
      db.trajectoryRecommendation.count({ where: { runId } }),
      db.trajectoryRecommendation.count({
        where: { runId, isSuggested: true },
      }),
      db.trajectoryModelRun.findUniqueOrThrow({
        where: { id: runId },
        select: { summary: true },
      }),
      db.trajectoryImportIssue.findMany({
        where: { runId },
        select: { code: true, recommendationKey: true, detail: true },
      }),
      db.trajectoryRecommendation.findMany({
        where: {
          runId,
          isSuggested: true,
          show: { is: { syncStatus: "active" } },
          runArtist: { is: { artistId: { not: null } } },
        },
        select: {
          showId: true,
          show: { select: { date: true } },
          runArtist: {
            select: {
              artist: {
                select: {
                  contacts: {
                    orderBy: [{ isFullTeam: "desc" }, { id: "asc" }],
                    select: {
                      id: true,
                      email: true,
                      phone: true,
                      directOutreachNote: true,
                      isFullTeam: true,
                      state: true,
                    },
                  },
                },
              },
            },
          },
        },
      }),
    ]);

    const activeSuggested = recommendations.flatMap((recommendation) => {
      const artist = recommendation.runArtist.artist;
      return artist
        ? [
            {
              showId: recommendation.showId,
              showDate: recommendation.show.date,
              contacts: artist.contacts,
            },
          ]
        : [];
    });
    const targets = new Map<string, { showId: string; contactId: string }>();
    for (const recommendation of activeSuggested) {
      const contact = pickEmailContact(recommendation.contacts);
      if (!contact) continue;
      targets.set(`${recommendation.showId}\u0000${contact.id}`, {
        showId: recommendation.showId,
        contactId: contact.id,
      });
    }
    const readiness =
      targets.size === 0
        ? []
        : await getOutreachSendabilityBatch([...targets.values()], now);

    return {
      persistedArtistRows,
      persistedRecommendationRows,
      persistedSuggestedRows,
      summary: run.summary,
      issues,
      activeSuggested,
      readiness: readiness.map((row) => ({
        showId: row.showId,
        contactId: row.contactId,
        sendable: row.sendable,
      })),
    };
  },
  async loadHistoricalMetrics() {
    const [decisions, outcomes, engagement] = await Promise.all([
      db.trajectoryFeedbackEvent.findMany({
        select: {
          id: true,
          recommendationId: true,
          action: true,
          recordedAt: true,
          recommendation: { select: { arm: true, runId: true } },
          supersededBy: { select: { id: true } },
        },
      }),
      db.trajectoryShowOutcome.findMany({
        select: {
          id: true,
          recommendationId: true,
          attended: true,
          access: true,
          keeperCount: true,
          relationshipValue: true,
          publicationValue: true,
          shootability: true,
          venueAccessibility: true,
          recordedAt: true,
          recommendation: { select: { arm: true, runId: true } },
          supersededBy: { select: { id: true } },
        },
      }),
      db.outreach.findMany({
        where: { trajectoryRecommendationId: { not: null } },
        select: {
          status: true,
          createdAt: true,
          sentAt: true,
          deliveredAt: true,
          firstOpenedAt: true,
          lastOpenedAt: true,
          openCount: true,
          firstClickedAt: true,
          lastClickedAt: true,
          clickCount: true,
          bouncedAt: true,
          complainedAt: true,
          trajectoryRecommendation: { select: { arm: true, runId: true } },
        },
      }),
    ]);
    return {
      decisions: decisions.map((row) => ({
        id: row.id,
        recommendationId: row.recommendationId,
        runId: row.recommendation.runId,
        arm: row.recommendation.arm,
        action: row.action,
        recordedAt: row.recordedAt,
        superseded: row.supersededBy !== null,
      })),
      outcomes: outcomes.map((row) => ({
        id: row.id,
        recommendationId: row.recommendationId,
        runId: row.recommendation.runId,
        arm: row.recommendation.arm,
        attended: row.attended,
        access: row.access,
        keeperCount: row.keeperCount,
        relationshipValue: row.relationshipValue,
        publicationValue: row.publicationValue,
        shootability: row.shootability,
        venueAccessibility: row.venueAccessibility,
        recordedAt: row.recordedAt,
        superseded: row.supersededBy !== null,
      })),
      engagement: engagement.flatMap((row) =>
        row.trajectoryRecommendation
          ? [
              {
                ...row,
                runId: row.trajectoryRecommendation.runId,
                arm: row.trajectoryRecommendation.arm,
              },
            ]
          : [],
      ),
    };
  },
};

export interface OperationalCount {
  value: number | null;
  unavailableReason: string | null;
}

interface DecisionMetrics {
  records: number;
  latestAt: string | null;
  selected: number;
  declined: number;
  saved: number;
  dismissed: number;
  manualOverride: number;
}

interface EngagementMetrics {
  attributedOutreach: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  complained: number;
}

interface AccessMetrics {
  records: number;
  notRecorded: number;
  none: number;
  guestlist: number;
  photoPass: number;
  other: number;
}

interface OutcomeMetrics {
  records: number;
  attended: number;
  notAttended: number;
  attendanceNotRecorded: number;
  keeperCountRecorded: number;
  keeperTotal: number;
  relationshipValue: [number, number, number];
  publicationValue: [number, number, number];
  shootability: { good: number; ok: number; poor: number };
  venueAccessibility: { high: number; medium: number; low: number };
  latestAt: string | null;
}

export type MetricsByArm<T> = Record<TrajectoryArm, T>;

export interface TrajectoryOperationalMetrics {
  generatedAt: string;
  scope: {
    run: "selected trajectory run";
    history: "all trajectory-attributed history";
  };
  run: {
    availability: TrajectoryRunAvailability;
    id: string;
    producerRunId: string;
    status: TrajectoryRunStatus;
    generatedAt: string;
    validUntil: string;
    importedAt: string;
    activatedAt: string | null;
    artifactByteLength: number;
  } | null;
  import: {
    available: boolean;
    persistedArtistRows: number;
    persistedRecommendationRows: number;
    persistedSuggestedRows: number;
  };
  mapping: {
    available: boolean;
    sourceArtistRows: OperationalCount;
    mappedArtistRows: OperationalCount;
    sourceRecommendationRows: OperationalCount;
    mappedRecommendationRows: OperationalCount;
    sourceSuggestedRows: OperationalCount;
    mappedSuggestedRows: OperationalCount;
    sourceNonSuggestedRows: OperationalCount;
    mappedNonSuggestedRows: OperationalCount;
    unresolvedRows: number;
    unresolvedSuggestedRows: OperationalCount;
    unresolvedNonSuggestedRows: OperationalCount;
  };
  issues: {
    total: number;
    showNotFound: number;
    artistNotFound: number;
    membershipMissing: number;
  };
  contactReadiness: {
    available: boolean;
    scopeRows: number;
    readyEmail: number;
    emailBlocked: number;
    directOutreach: number;
    needsContact: number;
  };
  decisions: DecisionMetrics & {
    byArm: MetricsByArm<DecisionMetrics>;
  };
  engagement: EngagementMetrics & {
    byArm: MetricsByArm<EngagementMetrics>;
  };
  access: AccessMetrics & {
    byArm: MetricsByArm<AccessMetrics>;
  };
  outcomes: OutcomeMetrics & {
    byArm: MetricsByArm<OutcomeMetrics>;
  };
  exportLag: {
    available: false;
    reason: string;
    exportableOutreachRows: number;
  };
  sameNight: {
    available: boolean;
    nightsWithAlternatives: number;
    distinctShows: number;
    recommendationRows: number;
    comparisonAvailable: false;
    comparisonReason: string;
  };
}

function latestDate(values: Array<Date | null | undefined>): string | null {
  const timestamps = values
    .filter((value): value is Date => value instanceof Date)
    .map((value) => value.getTime());
  return timestamps.length > 0
    ? new Date(Math.max(...timestamps)).toISOString()
    : null;
}

function countActions(
  decisions: readonly DecisionInput[],
  action: TrajectoryFeedbackAction,
): number {
  return decisions.filter((decision) => decision.action === action).length;
}

function countValue<T>(
  values: readonly T[],
  select: (value: T) => unknown,
  expected: unknown,
): number {
  return values.filter((value) => select(value) === expected).length;
}

function unavailableCount(reason: string): OperationalCount {
  return { value: null, unavailableReason: reason };
}

function summaryCount(
  summary: unknown,
  field: string,
): OperationalCount {
  const reason = `Run summary does not persist ${field}; unavailable for legacy or incomplete imports.`;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    return unavailableCount(reason);
  }
  const value = (summary as Record<string, unknown>)[field];
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0
    ? { value, unavailableReason: null }
    : unavailableCount(reason);
}

function issueSuggestionState(issue: RunIssueInput): boolean | null {
  if (
    !issue.detail ||
    typeof issue.detail !== "object" ||
    Array.isArray(issue.detail)
  ) {
    return null;
  }
  const value = (issue.detail as Record<string, unknown>).isSuggested;
  return typeof value === "boolean" ? value : null;
}

function aggregateRunMetrics(input: RunMetricsInput | null) {
  if (!input) {
    const noRun = "No selected trajectory run exists.";
    return {
      importMetrics: {
        available: false,
        persistedArtistRows: 0,
        persistedRecommendationRows: 0,
        persistedSuggestedRows: 0,
      },
      mapping: {
        available: false,
        sourceArtistRows: unavailableCount(noRun),
        mappedArtistRows: unavailableCount(noRun),
        sourceRecommendationRows: unavailableCount(noRun),
        mappedRecommendationRows: unavailableCount(noRun),
        sourceSuggestedRows: unavailableCount(noRun),
        mappedSuggestedRows: unavailableCount(noRun),
        sourceNonSuggestedRows: unavailableCount(noRun),
        mappedNonSuggestedRows: unavailableCount(noRun),
        unresolvedRows: 0,
        unresolvedSuggestedRows: unavailableCount(noRun),
        unresolvedNonSuggestedRows: unavailableCount(noRun),
      },
      issues: {
        total: 0,
        showNotFound: 0,
        artistNotFound: 0,
        membershipMissing: 0,
      },
      contactReadiness: {
        available: false,
        scopeRows: 0,
        readyEmail: 0,
        emailBlocked: 0,
        directOutreach: 0,
        needsContact: 0,
      },
      sameNight: {
        available: false,
        nightsWithAlternatives: 0,
        distinctShows: 0,
        recommendationRows: 0,
        comparisonAvailable: false as const,
        comparisonReason:
          "No selected run exists, and primary/backup roles are not persisted.",
      },
    };
  }

  const readiness = new Map(
    input.readiness.map((row) => [
      `${row.showId}\u0000${row.contactId}`,
      row.sendable,
    ]),
  );
  let readyEmail = 0;
  let emailBlocked = 0;
  let directOutreach = 0;
  let needsContact = 0;
  for (const recommendation of input.activeSuggested) {
    const email = pickEmailContact(recommendation.contacts);
    if (email) {
      if (readiness.get(`${recommendation.showId}\u0000${email.id}`) === true) {
        readyEmail += 1;
      } else {
        emailBlocked += 1;
      }
      continue;
    }
    const phone = pickPhoneContact(recommendation.contacts);
    const direct = pickDirectOutreachContact(recommendation.contacts);
    if (phone || direct) directOutreach += 1;
    else needsContact += 1;
  }

  const dateShows = new Map<string, Set<string>>();
  const dateRows = new Map<string, number>();
  for (const recommendation of input.activeSuggested) {
    const date = recommendation.showDate.toISOString().slice(0, 10);
    const shows = dateShows.get(date) ?? new Set<string>();
    shows.add(recommendation.showId);
    dateShows.set(date, shows);
    dateRows.set(date, (dateRows.get(date) ?? 0) + 1);
  }
  const alternativeDates = [...dateShows.entries()].filter(
    ([, shows]) => shows.size > 1,
  );
  const sourceRecommendationRows = summaryCount(
    input.summary,
    "recommendationCount",
  );
  const mappedRecommendationRows = summaryCount(
    input.summary,
    "mappedRecommendationCount",
  );
  const issueSuggestionStates = input.issues.map(issueSuggestionState);
  const issueClassificationUnavailable =
    issueSuggestionStates.some((value) => value === null);
  const issueClassificationReason =
    "One or more import issues do not persist suggested/non-suggested classification.";

  return {
    importMetrics: {
      available: true,
      persistedArtistRows: input.persistedArtistRows,
      persistedRecommendationRows: input.persistedRecommendationRows,
      persistedSuggestedRows: input.persistedSuggestedRows,
    },
    mapping: {
      available:
        sourceRecommendationRows.value !== null &&
        mappedRecommendationRows.value !== null,
      sourceArtistRows: summaryCount(input.summary, "artistCount"),
      mappedArtistRows: summaryCount(input.summary, "mappedArtistCount"),
      sourceRecommendationRows,
      mappedRecommendationRows,
      sourceSuggestedRows: summaryCount(
        input.summary,
        "suggestedRecommendationCount",
      ),
      mappedSuggestedRows: summaryCount(
        input.summary,
        "mappedSuggestedRecommendationCount",
      ),
      sourceNonSuggestedRows: summaryCount(
        input.summary,
        "nonSuggestedRecommendationCount",
      ),
      mappedNonSuggestedRows: summaryCount(
        input.summary,
        "mappedNonSuggestedRecommendationCount",
      ),
      unresolvedRows: input.issues.length,
      unresolvedSuggestedRows: issueClassificationUnavailable
        ? unavailableCount(issueClassificationReason)
        : {
            value: issueSuggestionStates.filter((value) => value === true)
              .length,
            unavailableReason: null,
          },
      unresolvedNonSuggestedRows: issueClassificationUnavailable
        ? unavailableCount(issueClassificationReason)
        : {
            value: issueSuggestionStates.filter((value) => value === false)
              .length,
            unavailableReason: null,
          },
    },
    issues: {
      total: input.issues.length,
      showNotFound: countValue(input.issues, (issue) => issue.code, "show_not_found"),
      artistNotFound: countValue(
        input.issues,
        (issue) => issue.code,
        "artist_not_found",
      ),
      membershipMissing: countValue(
        input.issues,
        (issue) => issue.code,
        "show_artist_membership_missing",
      ),
    },
    contactReadiness: {
      available: true,
      scopeRows: input.activeSuggested.length,
      readyEmail,
      emailBlocked,
      directOutreach,
      needsContact,
    },
    sameNight: {
      available: true,
      nightsWithAlternatives: alternativeDates.length,
      distinctShows: alternativeDates.reduce(
        (total, [, shows]) => total + shows.size,
        0,
      ),
      recommendationRows: alternativeDates.reduce(
        (total, [date]) => total + (dateRows.get(date) ?? 0),
        0,
      ),
      comparisonAvailable: false as const,
      comparisonReason:
        "Primary and backup roles are derived for display and are not persisted with decisions or outcomes.",
    },
  };
}

function latestPerRecommendation<
  Row extends {
    id: string;
    recommendationId: string;
    recordedAt: Date;
    superseded: boolean;
  },
>(rows: readonly Row[]): Row[] {
  const latest = new Map<string, Row>();
  for (const row of rows) {
    if (row.superseded) continue;
    const prior = latest.get(row.recommendationId);
    if (
      !prior ||
      row.recordedAt.getTime() > prior.recordedAt.getTime() ||
      (row.recordedAt.getTime() === prior.recordedAt.getTime() &&
        row.id.localeCompare(prior.id) > 0)
    ) {
      latest.set(row.recommendationId, row);
    }
  }
  return [...latest.values()];
}

function metricsByArm<Row extends { arm: TrajectoryArm }, T>(
  rows: readonly Row[],
  aggregate: (rows: readonly Row[]) => T,
): MetricsByArm<T> {
  return Object.fromEntries(
    TRAJECTORY_ARMS.map((arm) => [
      arm,
      aggregate(rows.filter((row) => row.arm === arm)),
    ]),
  ) as MetricsByArm<T>;
}

function decisionMetrics(rows: readonly DecisionInput[]): DecisionMetrics {
  return {
    records: rows.length,
    latestAt: latestDate(rows.map((row) => row.recordedAt)),
    selected: countActions(rows, "selected"),
    declined: countActions(rows, "declined"),
    saved: countActions(rows, "saved"),
    dismissed: countActions(rows, "dismissed"),
    manualOverride: countActions(rows, "manual_override"),
  };
}

function engagementMetrics(
  rows: readonly EngagementInput[],
): EngagementMetrics {
  return {
    attributedOutreach: rows.length,
    sent: rows.filter((row) => row.sentAt !== null || row.status === "sent")
      .length,
    delivered: rows.filter((row) => row.deliveredAt !== null).length,
    opened: rows.filter(
      (row) => row.firstOpenedAt !== null || row.openCount > 0,
    ).length,
    clicked: rows.filter(
      (row) => row.firstClickedAt !== null || row.clickCount > 0,
    ).length,
    bounced: rows.filter((row) => row.bouncedAt !== null).length,
    complained: rows.filter((row) => row.complainedAt !== null).length,
  };
}

function accessMetrics(rows: readonly OutcomeInput[]): AccessMetrics {
  return {
    records: rows.length,
    notRecorded: countValue(rows, (row) => row.access, null),
    none: countValue(rows, (row) => row.access, "none"),
    guestlist: countValue(rows, (row) => row.access, "guestlist"),
    photoPass: countValue(rows, (row) => row.access, "photo_pass"),
    other: countValue(rows, (row) => row.access, "other"),
  };
}

function outcomeMetrics(rows: readonly OutcomeInput[]): OutcomeMetrics {
  return {
    records: rows.length,
    attended: countValue(rows, (row) => row.attended, true),
    notAttended: countValue(rows, (row) => row.attended, false),
    attendanceNotRecorded: countValue(rows, (row) => row.attended, null),
    keeperCountRecorded: rows.filter((row) => row.keeperCount !== null).length,
    keeperTotal: rows.reduce(
      (total, row) => total + (row.keeperCount ?? 0),
      0,
    ),
    relationshipValue: [0, 1, 2].map((value) =>
      countValue(rows, (row) => row.relationshipValue, value),
    ) as [number, number, number],
    publicationValue: [0, 1, 2].map((value) =>
      countValue(rows, (row) => row.publicationValue, value),
    ) as [number, number, number],
    shootability: {
      good: countValue(rows, (row) => row.shootability, "good"),
      ok: countValue(rows, (row) => row.shootability, "ok"),
      poor: countValue(rows, (row) => row.shootability, "poor"),
    },
    venueAccessibility: {
      high: countValue(rows, (row) => row.venueAccessibility, "high"),
      medium: countValue(rows, (row) => row.venueAccessibility, "medium"),
      low: countValue(rows, (row) => row.venueAccessibility, "low"),
    },
    latestAt: latestDate(rows.map((row) => row.recordedAt)),
  };
}

export async function getTrajectoryOperationalMetrics(
  options: {
    now?: Date;
    store?: TrajectoryMetricsStore;
  } = {},
): Promise<TrajectoryOperationalMetrics> {
  const now = options.now ?? new Date();
  const store = options.store ?? DEFAULT_STORE;
  const resolved = await resolveTrajectoryRun(now, store);
  const [runInput, history] = await Promise.all([
    resolved.run
      ? store.loadRunMetrics(resolved.run.id, now)
      : Promise.resolve(null),
    store.loadHistoricalMetrics(),
  ]);
  const runMetrics = aggregateRunMetrics(runInput);
  const decisions = latestPerRecommendation(history.decisions);
  const outcomes = latestPerRecommendation(history.outcomes);
  const decisionTotals = decisionMetrics(decisions);
  const engagementTotals = engagementMetrics(history.engagement);
  const accessTotals = accessMetrics(outcomes);
  const outcomeTotals = outcomeMetrics(outcomes);

  return {
    generatedAt: now.toISOString(),
    scope: {
      run: "selected trajectory run",
      history: "all trajectory-attributed history",
    },
    run: resolved.run
      ? {
          availability: resolved.availability,
          id: resolved.run.id,
          producerRunId: resolved.run.producerRunId,
          status: resolved.run.status,
          generatedAt: resolved.run.generatedAt.toISOString(),
          validUntil: resolved.run.validUntil.toISOString(),
          importedAt: resolved.run.importedAt.toISOString(),
          activatedAt: resolved.run.activatedAt?.toISOString() ?? null,
          artifactByteLength: resolved.run.artifactByteLength,
        }
      : null,
    import: runMetrics.importMetrics,
    mapping: runMetrics.mapping,
    issues: runMetrics.issues,
    contactReadiness: runMetrics.contactReadiness,
    decisions: {
      ...decisionTotals,
      byArm: metricsByArm(decisions, decisionMetrics),
    },
    engagement: {
      ...engagementTotals,
      byArm: metricsByArm(history.engagement, engagementMetrics),
    },
    access: {
      ...accessTotals,
      byArm: metricsByArm(outcomes, accessMetrics),
    },
    outcomes: {
      ...outcomeTotals,
      byArm: metricsByArm(outcomes, outcomeMetrics),
    },
    exportLag: {
      available: false,
      reason:
        "No durable export receipt, successful-export timestamp, or complete export-relevant change timestamp is stored; export lag is unavailable.",
      exportableOutreachRows: history.engagement.length,
    },
    sameNight: runMetrics.sameNight,
  };
}
