import { db } from "@/lib/db";

export const PRODUCER_OUTREACH_ENGAGEMENT_ALLOWED_FIELDS = new Set([
  "outreach_id",
  "show_id",
  "artist",
  "ra_artist_id",
  "spotify_artist_id",
  "edmtrain_artist_id",
  "contact_id",
  "status",
  "sent_at",
  "delivered_at",
  "first_opened_at",
  "last_opened_at",
  "open_count",
  "first_clicked_at",
  "last_clicked_at",
  "click_count",
  "bounced_at",
  "complained_at",
  "run_id",
  "logged_at_utc",
  "source",
]);

const producerStatuses = new Set([
  "queued",
  "scheduled",
  "retry_scheduled",
  "sent",
  "test",
  "delivered",
  "opened",
  "clicked",
  "bounced",
  "complained",
  "failed",
  "manual_review",
  "cancelled",
]);

const emailLike = /[^@\s]+@[^@\s]+\.[^@\s]+/;
const forbiddenFieldName =
  /(contact_name|email|phone|recipient|subject|body|html|text|notes?)/i;

export interface TrajectoryEngagementExportRow {
  id: string;
  status: string;
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
  trajectoryRecommendation: {
    id: string;
    arm: string;
    run: {
      id: string;
      producerRunId: string;
    };
    show: {
      edmtrainId: number | null;
    };
    runArtist: {
      edmtrainArtistId: number;
    };
  };
}

export interface ProducerOutreachEngagementEvent {
  outreach_id: string;
  show_id: string;
  edmtrain_artist_id: number;
  status: string;
  sent_at?: string;
  delivered_at?: string;
  first_opened_at?: string;
  last_opened_at?: string;
  open_count: number;
  first_clicked_at?: string;
  last_clicked_at?: string;
  click_count: number;
  bounced_at?: string;
  complained_at?: string;
  run_id: string;
  source: string;
}

function iso(value: Date | null): string | undefined {
  return value?.toISOString();
}

export function normalizeProducerOutreachStatus(
  row: Pick<TrajectoryEngagementExportRow, "status">,
): string {
  if (producerStatuses.has(row.status)) return row.status;
  if (row.status === "delivery_failed") return "failed";
  if (row.status === "sending" || row.status === "prepared") return "queued";
  throw new Error(`Unapproved outreach status for feedback export: ${row.status}`);
}

function attributionSource(
  recommendation: TrajectoryEngagementExportRow["trajectoryRecommendation"],
): string {
  const run = encodeURIComponent(recommendation.run.id);
  const recommendationId = encodeURIComponent(recommendation.id);
  const arm = encodeURIComponent(recommendation.arm);
  return `photo-admin://trajectory-runs/${run}/recommendations/${recommendationId}?arm=${arm}`;
}

export function assertProducerCompatibleEvent(
  event: object,
): void {
  const record = event as Record<string, unknown>;
  const unapprovedFields = Object.keys(record).filter(
    (field) => !PRODUCER_OUTREACH_ENGAGEMENT_ALLOWED_FIELDS.has(field),
  );
  if (unapprovedFields.length > 0) {
    throw new Error(
      `Unapproved trajectory feedback export field(s): ${unapprovedFields.sort().join(", ")}`,
    );
  }
  const piiShapedFields = Object.keys(record).filter((field) =>
    forbiddenFieldName.test(field),
  );
  if (piiShapedFields.length > 0) {
    throw new Error(
      `PII-shaped trajectory feedback export field(s): ${piiShapedFields.sort().join(", ")}`,
    );
  }
  for (const [field, value] of Object.entries(record)) {
    if (typeof value === "string" && emailLike.test(value)) {
      throw new Error(
        `Email-shaped value rejected from trajectory feedback field ${field}`,
      );
    }
  }
  if (
    typeof record.open_count !== "number" ||
    !Number.isInteger(record.open_count) ||
    record.open_count < 0 ||
    typeof record.click_count !== "number" ||
    !Number.isInteger(record.click_count) ||
    record.click_count < 0
  ) {
    throw new Error("Engagement counts must be non-negative integers");
  }
  if (
    typeof record.status !== "string" ||
    !producerStatuses.has(record.status)
  ) {
    throw new Error("Unapproved producer engagement status");
  }
}

export function buildTrajectoryEngagementExportEvent(
  row: TrajectoryEngagementExportRow,
): ProducerOutreachEngagementEvent {
  const showId = row.trajectoryRecommendation.show.edmtrainId;
  if (!showId || showId <= 0) {
    throw new Error(
      `Recommendation ${row.trajectoryRecommendation.id} has no EDMTrain show attribution`,
    );
  }
  const artistId = row.trajectoryRecommendation.runArtist.edmtrainArtistId;
  if (!Number.isInteger(artistId) || artistId <= 0) {
    throw new Error(
      `Recommendation ${row.trajectoryRecommendation.id} has no EDMTrain artist attribution`,
    );
  }

  const event: ProducerOutreachEngagementEvent = {
    outreach_id: row.id,
    show_id: String(showId),
    edmtrain_artist_id: artistId,
    status: normalizeProducerOutreachStatus(row),
    ...(iso(row.sentAt) ? { sent_at: iso(row.sentAt) } : {}),
    ...(iso(row.deliveredAt)
      ? { delivered_at: iso(row.deliveredAt) }
      : {}),
    ...(iso(row.firstOpenedAt)
      ? { first_opened_at: iso(row.firstOpenedAt) }
      : {}),
    ...(iso(row.lastOpenedAt)
      ? { last_opened_at: iso(row.lastOpenedAt) }
      : {}),
    open_count: row.openCount,
    ...(iso(row.firstClickedAt)
      ? { first_clicked_at: iso(row.firstClickedAt) }
      : {}),
    ...(iso(row.lastClickedAt)
      ? { last_clicked_at: iso(row.lastClickedAt) }
      : {}),
    click_count: row.clickCount,
    ...(iso(row.bouncedAt) ? { bounced_at: iso(row.bouncedAt) } : {}),
    ...(iso(row.complainedAt)
      ? { complained_at: iso(row.complainedAt) }
      : {}),
    run_id: row.trajectoryRecommendation.run.producerRunId,
    source: attributionSource(row.trajectoryRecommendation),
  };
  assertProducerCompatibleEvent(event);
  return event;
}

export function serializeTrajectoryFeedbackJsonl(
  rows: readonly TrajectoryEngagementExportRow[],
): string {
  const sorted = [...rows].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  if (sorted.length === 0) return "";
  return `${sorted
    .map((row) => JSON.stringify(buildTrajectoryEngagementExportEvent(row)))
    .join("\n")}\n`;
}

export async function loadTrajectoryEngagementExportRows(): Promise<
  TrajectoryEngagementExportRow[]
> {
  return db.outreach.findMany({
    where: {
      trajectoryRecommendationId: { not: null },
    },
    orderBy: [{ id: "asc" }],
    select: {
      id: true,
      status: true,
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
      trajectoryRecommendation: {
        select: {
          id: true,
          arm: true,
          run: {
            select: {
              id: true,
              producerRunId: true,
            },
          },
          show: {
            select: {
              edmtrainId: true,
            },
          },
          runArtist: {
            select: {
              edmtrainArtistId: true,
            },
          },
        },
      },
    },
  }) as Promise<TrajectoryEngagementExportRow[]>;
}
