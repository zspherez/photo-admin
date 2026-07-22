import { randomUUID } from "node:crypto";
import type {
  Prisma,
  TrajectoryArm,
  TrajectoryRunStatus,
} from "@prisma/client";
import {
  easternTodayStoredDate,
} from "@/lib/calendarDate";
import { db } from "@/lib/db";
import {
  trajectoryOutcomeRecordability,
} from "@/lib/trajectoryRecommendations";
import {
  TRAJECTORY_PRODUCER,
} from "@/lib/trajectoryContract";
import type {
  TrajectoryDecisionView,
  TrajectoryOutcomeView,
} from "@/lib/trajectoryRecommendationView";

export const HISTORICAL_OUTCOME_PAGE_SIZE = 48;
const HISTORICAL_RUN_STATUSES = [
  "ready",
  "stale",
  "superseded",
] satisfies TrajectoryRunStatus[];

interface HistoricalRecommendationRecord {
  id: string;
  runId: string;
  arm: TrajectoryArm;
  feedback: Array<{
    id: string;
    action: "selected" | "declined" | "saved" | "dismissed" | "manual_override";
    propensity: number | null;
    manualOverride: boolean;
    notes: string | null;
    supersedesId: string | null;
    recordedAt: Date;
  }>;
  outcomes: Array<{
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
  run: {
    producerRunId: string;
    status: TrajectoryRunStatus;
    generatedAt: Date;
  };
  show: {
    id: string;
    date: Date;
    venueName: string;
    eventName: string | null;
    city: string;
    state: string | null;
  };
  runArtist: {
    edmtrainArtistId: number;
    artist: {
      id: string;
      name: string;
    } | null;
  };
}

export interface HistoricalOutcomeRecommendation {
  id: string;
  runId: string;
  producerRunId: string;
  trajectoryActionId: string;
  showId: string;
  showDate: string;
  venueName: string;
  eventName: string | null;
  location: string;
  artistId: string;
  artistName: string;
  edmtrainArtistId: number;
  arm: TrajectoryArm;
  runStatus: TrajectoryRunStatus;
  runGeneratedAt: string;
  decisionHistory: TrajectoryDecisionView[];
  outcomeHistory: TrajectoryOutcomeView[];
  outcomeRecordable: boolean;
  outcomeRecordabilityMessage: string | null;
}

export interface HistoricalOutcomeQuery {
  producer: typeof TRAJECTORY_PRODUCER;
  statuses: readonly TrajectoryRunStatus[];
  today: Date;
  offset: number;
  limit: number;
}

export interface HistoricalOutcomeStore {
  countRecommendations(query: HistoricalOutcomeQuery): Promise<number>;
  findRecommendations(
    query: HistoricalOutcomeQuery,
  ): Promise<HistoricalRecommendationRecord[]>;
}

function historicalWhere(
  query: HistoricalOutcomeQuery,
): Prisma.TrajectoryRecommendationWhereInput {
  return {
    run: {
      is: {
        producer: query.producer,
        status: { in: [...query.statuses] },
      },
    },
    runArtist: {
      is: {
        artistId: { not: null },
        artist: { isNot: null },
      },
    },
    OR: [
      { show: { is: { date: { lte: query.today } } } },
      { outcomes: { some: {} } },
    ],
  };
}

const DEFAULT_STORE: HistoricalOutcomeStore = {
  countRecommendations: (query) =>
    db.trajectoryRecommendation.count({
      where: historicalWhere(query),
    }),
  findRecommendations: (query) =>
    db.trajectoryRecommendation.findMany({
      where: historicalWhere(query),
      orderBy: [
        { show: { date: "desc" } },
        { run: { generatedAt: "desc" } },
        { id: "asc" },
      ],
      skip: query.offset,
      take: query.limit,
      select: {
        id: true,
        runId: true,
        arm: true,
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
        run: {
          select: {
            producerRunId: true,
            status: true,
            generatedAt: true,
          },
        },
        show: {
          select: {
            id: true,
            date: true,
            venueName: true,
            eventName: true,
            city: true,
            state: true,
          },
        },
        runArtist: {
          select: {
            edmtrainArtistId: true,
            artist: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    }),
};

function currentEvidenceId(
  rows: readonly { id: string; supersedesId: string | null }[],
): string | null {
  const supersededIds = new Set(
    rows.flatMap((row) => (row.supersedesId ? [row.supersedesId] : [])),
  );
  return rows.find((row) => !supersededIds.has(row.id))?.id ?? null;
}

function decisionHistory(
  rows: HistoricalRecommendationRecord["feedback"],
): TrajectoryDecisionView[] {
  const currentId = currentEvidenceId(rows);
  return rows.map((row) => ({
    ...row,
    recordedAt: row.recordedAt.toISOString(),
    isCurrent: row.id === currentId,
  }));
}

function outcomeHistory(
  rows: HistoricalRecommendationRecord["outcomes"],
): TrajectoryOutcomeView[] {
  const currentId = currentEvidenceId(rows);
  return rows.map((row) => ({
    ...row,
    recordedAt: row.recordedAt.toISOString(),
    isCurrent: row.id === currentId,
  }));
}

export async function getHistoricalOutcomeRecommendationPage(
  options: {
    now?: Date;
    offset?: number;
    limit?: number;
    store?: HistoricalOutcomeStore;
  } = {},
): Promise<{
  recommendations: HistoricalOutcomeRecommendation[];
  total: number;
  offset: number;
  nextOffset: number | null;
}> {
  const now = options.now ?? new Date();
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.max(1, options.limit ?? HISTORICAL_OUTCOME_PAGE_SIZE);
  const store = options.store ?? DEFAULT_STORE;
  const query: HistoricalOutcomeQuery = {
    producer: TRAJECTORY_PRODUCER,
    statuses: HISTORICAL_RUN_STATUSES,
    today: easternTodayStoredDate(now),
    offset,
    limit,
  };
  const [total, records] = await Promise.all([
    store.countRecommendations(query),
    store.findRecommendations(query),
  ]);
  const recommendations = records.flatMap((record) => {
    const artist = record.runArtist.artist;
    if (!artist) return [];
    const availability = trajectoryOutcomeRecordability(
      record.show.date,
      now,
      record.outcomes.length > 0,
    );
    return [{
      id: record.id,
      runId: record.runId,
      producerRunId: record.run.producerRunId,
      trajectoryActionId: randomUUID(),
      showId: record.show.id,
      showDate: record.show.date.toISOString(),
      venueName: record.show.venueName,
      eventName: record.show.eventName,
      location: [record.show.city, record.show.state].filter(Boolean).join(", "),
      artistId: artist.id,
      artistName: artist.name,
      edmtrainArtistId: record.runArtist.edmtrainArtistId,
      arm: record.arm,
      runStatus: record.run.status,
      runGeneratedAt: record.run.generatedAt.toISOString(),
      decisionHistory: decisionHistory(record.feedback),
      outcomeHistory: outcomeHistory(record.outcomes),
      outcomeRecordable: availability.recordable,
      outcomeRecordabilityMessage: availability.message,
    }];
  });
  return {
    recommendations,
    total,
    offset,
    nextOffset: offset + records.length < total ? offset + limit : null,
  };
}
