import type {
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

interface MetricsRunRecord {
  id: string;
  producerRunId: string;
  generatedAt: Date;
  validUntil: Date;
  importedAt: Date;
  activatedAt: Date | null;
  artifactByteLength: number;
  status: TrajectoryRunStatus;
}

interface RunIssueInput {
  code: TrajectoryImportIssueCode;
  recommendationKey: string | null;
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
  artistRows: number;
  mappedArtistRows: number;
  recommendationRows: number;
  suggestedRows: number;
  issues: RunIssueInput[];
  activeSuggested: SuggestedRecommendationInput[];
  readiness: Array<{
    showId: string;
    contactId: string;
    sendable: boolean;
  }>;
}

interface DecisionInput {
  action: TrajectoryFeedbackAction;
  recordedAt: Date;
}

interface OutcomeInput {
  attended: boolean | null;
  access: "none" | "guestlist" | "photo_pass" | "other" | null;
  keeperCount: number | null;
  relationshipValue: number | null;
  publicationValue: number | null;
  shootability: "good" | "ok" | "poor" | null;
  venueAccessibility: "high" | "medium" | "low" | null;
  recordedAt: Date;
}

interface EngagementInput {
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
      artistRows,
      mappedArtistRows,
      recommendationRows,
      suggestedRows,
      issues,
      recommendations,
    ] = await Promise.all([
      db.trajectoryRunArtist.count({ where: { runId } }),
      db.trajectoryRunArtist.count({
        where: { runId, artistId: { not: null } },
      }),
      db.trajectoryRecommendation.count({ where: { runId } }),
      db.trajectoryRecommendation.count({
        where: { runId, isSuggested: true },
      }),
      db.trajectoryImportIssue.findMany({
        where: { runId },
        select: { code: true, recommendationKey: true },
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
      artistRows,
      mappedArtistRows,
      recommendationRows,
      suggestedRows,
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
        where: { supersededBy: { is: null } },
        select: { action: true, recordedAt: true },
      }),
      db.trajectoryShowOutcome.findMany({
        where: { supersededBy: { is: null } },
        select: {
          attended: true,
          access: true,
          keeperCount: true,
          relationshipValue: true,
          publicationValue: true,
          shootability: true,
          venueAccessibility: true,
          recordedAt: true,
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
        },
      }),
    ]);
    return { decisions, outcomes, engagement };
  },
};

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
    artistRows: number;
    recommendationRows: number;
    suggestedRows: number;
  };
  mapping: {
    available: boolean;
    artistRows: number;
    mappedArtistRows: number;
    unmappedArtistRows: number;
    importedRecommendationRows: number;
    unresolvedRecommendationRows: number;
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
  decisions: {
    records: number;
    latestAt: string | null;
    selected: number;
    declined: number;
    saved: number;
    dismissed: number;
    manualOverride: number;
  };
  engagement: {
    attributedOutreach: number;
    sent: number;
    delivered: number;
    opened: number;
    clicked: number;
    bounced: number;
    complained: number;
    latestObservedAt: string | null;
  };
  access: {
    records: number;
    notRecorded: number;
    none: number;
    guestlist: number;
    photoPass: number;
    other: number;
  };
  outcomes: {
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
  };
  exportLag: {
    available: false;
    reason: string;
    exportableOutreachRows: number;
    latestExportableChangeAt: string | null;
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

function aggregateRunMetrics(input: RunMetricsInput | null) {
  if (!input) {
    return {
      importMetrics: {
        available: false,
        artistRows: 0,
        recommendationRows: 0,
        suggestedRows: 0,
      },
      mapping: {
        available: false,
        artistRows: 0,
        mappedArtistRows: 0,
        unmappedArtistRows: 0,
        importedRecommendationRows: 0,
        unresolvedRecommendationRows: 0,
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

  return {
    importMetrics: {
      available: true,
      artistRows: input.artistRows,
      recommendationRows: input.recommendationRows,
      suggestedRows: input.suggestedRows,
    },
    mapping: {
      available: true,
      artistRows: input.artistRows,
      mappedArtistRows: input.mappedArtistRows,
      unmappedArtistRows: input.artistRows - input.mappedArtistRows,
      importedRecommendationRows: input.recommendationRows,
      unresolvedRecommendationRows: input.issues.filter(
        (issue) => issue.recommendationKey !== null,
      ).length,
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
  const latestEngagementAt = latestDate(
    history.engagement.flatMap((row) => [
      row.createdAt,
      row.sentAt,
      row.deliveredAt,
      row.firstOpenedAt,
      row.lastOpenedAt,
      row.firstClickedAt,
      row.lastClickedAt,
      row.bouncedAt,
      row.complainedAt,
    ]),
  );

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
      records: history.decisions.length,
      latestAt: latestDate(history.decisions.map((row) => row.recordedAt)),
      selected: countActions(history.decisions, "selected"),
      declined: countActions(history.decisions, "declined"),
      saved: countActions(history.decisions, "saved"),
      dismissed: countActions(history.decisions, "dismissed"),
      manualOverride: countActions(history.decisions, "manual_override"),
    },
    engagement: {
      attributedOutreach: history.engagement.length,
      sent: history.engagement.filter(
        (row) => row.sentAt !== null || row.status === "sent",
      ).length,
      delivered: history.engagement.filter((row) => row.deliveredAt !== null)
        .length,
      opened: history.engagement.filter(
        (row) => row.firstOpenedAt !== null || row.openCount > 0,
      ).length,
      clicked: history.engagement.filter(
        (row) => row.firstClickedAt !== null || row.clickCount > 0,
      ).length,
      bounced: history.engagement.filter((row) => row.bouncedAt !== null).length,
      complained: history.engagement.filter(
        (row) => row.complainedAt !== null,
      ).length,
      latestObservedAt: latestEngagementAt,
    },
    access: {
      records: history.outcomes.length,
      notRecorded: countValue(history.outcomes, (row) => row.access, null),
      none: countValue(history.outcomes, (row) => row.access, "none"),
      guestlist: countValue(history.outcomes, (row) => row.access, "guestlist"),
      photoPass: countValue(
        history.outcomes,
        (row) => row.access,
        "photo_pass",
      ),
      other: countValue(history.outcomes, (row) => row.access, "other"),
    },
    outcomes: {
      records: history.outcomes.length,
      attended: countValue(history.outcomes, (row) => row.attended, true),
      notAttended: countValue(history.outcomes, (row) => row.attended, false),
      attendanceNotRecorded: countValue(
        history.outcomes,
        (row) => row.attended,
        null,
      ),
      keeperCountRecorded: history.outcomes.filter(
        (row) => row.keeperCount !== null,
      ).length,
      keeperTotal: history.outcomes.reduce(
        (total, row) => total + (row.keeperCount ?? 0),
        0,
      ),
      relationshipValue: [0, 1, 2].map((value) =>
        countValue(history.outcomes, (row) => row.relationshipValue, value),
      ) as [number, number, number],
      publicationValue: [0, 1, 2].map((value) =>
        countValue(history.outcomes, (row) => row.publicationValue, value),
      ) as [number, number, number],
      shootability: {
        good: countValue(history.outcomes, (row) => row.shootability, "good"),
        ok: countValue(history.outcomes, (row) => row.shootability, "ok"),
        poor: countValue(history.outcomes, (row) => row.shootability, "poor"),
      },
      venueAccessibility: {
        high: countValue(
          history.outcomes,
          (row) => row.venueAccessibility,
          "high",
        ),
        medium: countValue(
          history.outcomes,
          (row) => row.venueAccessibility,
          "medium",
        ),
        low: countValue(
          history.outcomes,
          (row) => row.venueAccessibility,
          "low",
        ),
      },
      latestAt: latestDate(history.outcomes.map((row) => row.recordedAt)),
    },
    exportLag: {
      available: false,
      reason:
        "No durable export receipt or successful-export timestamp is stored; JSONL generation alone cannot establish export lag.",
      exportableOutreachRows: history.engagement.length,
      latestExportableChangeAt: latestEngagementAt,
    },
    sameNight: runMetrics.sameNight,
  };
}
