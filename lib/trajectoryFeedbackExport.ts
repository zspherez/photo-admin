import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export const PRODUCER_FEEDBACK_CONTRACT_VERSION = "photo-admin-model-v1";

const DECISION_ALLOWED_FIELDS = new Set([
  "show_id",
  "action",
  "arm",
  "propensity",
  "manual_override",
  "outreach_id",
  "run_id",
  "integration_contract_version",
  "logged_at_utc",
]);

const OUTCOME_ALLOWED_FIELDS = new Set([
  "show_id",
  "attended",
  "access",
  "keepers",
  "relationship_value",
  "publication_value",
  "shootability",
  "venue_accessibility",
  "run_id",
  "integration_contract_version",
  "logged_at_utc",
]);

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

const producerDecisionActions = new Set(["selected", "declined", "saved"]);
const producerDecisionArms = new Set([
  "trajectory",
  "momentum",
  "exploration",
  "portfolio",
  "manual",
]);
const producerAccessValues = new Set([
  "none",
  "guestlist",
  "photo_pass",
  "other",
]);
const producerShootabilityValues = new Set(["good", "ok", "poor"]);
const producerAccessibilityValues = new Set(["high", "medium", "low"]);
const emailLike = /[^@\s]+@[^@\s]+\.[^@\s]+/;
const forbiddenFieldName =
  /(contact_name|email|phone|recipient|subject|body|html|text|notes?)/i;

interface ExportRecommendation {
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
  outreaches: Array<{
    id: string;
  }>;
}

export interface TrajectoryDecisionExportRow {
  id: string;
  action: "selected" | "declined" | "saved" | "dismissed" | "manual_override";
  propensity: number | null;
  manualOverride: boolean;
  recordedAt: Date;
  recommendation: ExportRecommendation;
}

export interface TrajectoryOutcomeExportRow {
  id: string;
  attended: boolean | null;
  access: "none" | "guestlist" | "photo_pass" | "other" | null;
  keeperCount: number | null;
  relationshipValue: number | null;
  publicationValue: number | null;
  shootability: "good" | "ok" | "poor" | null;
  venueAccessibility: "high" | "medium" | "low" | null;
  recordedAt: Date;
  recommendation: ExportRecommendation;
}

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
  trajectoryRecommendation: Omit<ExportRecommendation, "outreaches">;
}

export interface ProducerDecisionEvent {
  show_id: string;
  action: "selected" | "declined" | "saved";
  arm: "trajectory" | "momentum" | "exploration" | "portfolio" | "manual";
  propensity?: number;
  manual_override: boolean;
  outreach_id?: string;
  run_id: string;
  integration_contract_version: string;
  logged_at_utc: string;
}

export interface ProducerOutcomeEvent {
  show_id: string;
  attended?: "yes" | "no";
  access?: "none" | "guestlist" | "photo_pass" | "other";
  keepers?: number;
  relationship_value?: number;
  publication_value?: number;
  shootability?: "good" | "ok" | "poor";
  venue_accessibility?: "high" | "medium" | "low";
  run_id: string;
  integration_contract_version: string;
  logged_at_utc: string;
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

function assertSafeAllowedEvent(
  event: object,
  allowedFields: ReadonlySet<string>,
  label: string,
): void {
  const record = event as Record<string, unknown>;
  const unapprovedFields = Object.keys(record).filter(
    (field) => !allowedFields.has(field),
  );
  if (unapprovedFields.length > 0) {
    throw new Error(
      `Unapproved ${label} export field(s): ${unapprovedFields.sort().join(", ")}`,
    );
  }
  const piiShapedFields = Object.keys(record).filter((field) =>
    forbiddenFieldName.test(field),
  );
  if (piiShapedFields.length > 0) {
    throw new Error(
      `PII-shaped ${label} export field(s): ${piiShapedFields.sort().join(", ")}`,
    );
  }
  for (const [field, value] of Object.entries(record)) {
    if (typeof value === "string" && emailLike.test(value)) {
      throw new Error(`Email-shaped value rejected from ${label} field ${field}`);
    }
  }
}

function externalShowId(recommendation: ExportRecommendation): string {
  const showId = recommendation.show.edmtrainId;
  if (!showId || !Number.isInteger(showId) || showId <= 0) {
    throw new Error(
      `Recommendation ${recommendation.id} has no EDMTrain show attribution`,
    );
  }
  return String(showId);
}

function decisionAction(
  action: TrajectoryDecisionExportRow["action"],
): ProducerDecisionEvent["action"] {
  if (action === "dismissed") return "declined";
  if (action === "manual_override") return "selected";
  return action;
}

function decisionArm(
  row: TrajectoryDecisionExportRow,
): ProducerDecisionEvent["arm"] {
  if (row.action === "manual_override" || row.manualOverride) return "manual";
  if (!producerDecisionArms.has(row.recommendation.arm)) {
    throw new Error(`Unapproved producer decision arm: ${row.recommendation.arm}`);
  }
  return row.recommendation.arm as ProducerDecisionEvent["arm"];
}

export function assertProducerCompatibleDecision(
  event: object,
): void {
  assertSafeAllowedEvent(event, DECISION_ALLOWED_FIELDS, "trajectory decision");
  const record = event as Record<string, unknown>;
  if (
    typeof record.action !== "string" ||
    !producerDecisionActions.has(record.action)
  ) {
    throw new Error("Unapproved producer decision action");
  }
  if (
    typeof record.arm !== "string" ||
    !producerDecisionArms.has(record.arm)
  ) {
    throw new Error("Unapproved producer decision arm");
  }
  if (
    record.propensity !== undefined &&
    (typeof record.propensity !== "number" ||
      !Number.isFinite(record.propensity) ||
      record.propensity < 0 ||
      record.propensity > 1)
  ) {
    throw new Error("Decision propensity must be between 0 and 1");
  }
  if (typeof record.manual_override !== "boolean") {
    throw new Error("Decision manual_override must be boolean");
  }
}

export function buildTrajectoryDecisionExportEvent(
  row: TrajectoryDecisionExportRow,
): ProducerDecisionEvent {
  const action = decisionAction(row.action);
  const outreachId =
    action === "selected" ? row.recommendation.outreaches[0]?.id : undefined;
  const event: ProducerDecisionEvent = {
    show_id: externalShowId(row.recommendation),
    action,
    arm: decisionArm(row),
    ...(row.propensity === null ? {} : { propensity: row.propensity }),
    manual_override: row.action === "manual_override" || row.manualOverride,
    ...(outreachId ? { outreach_id: outreachId } : {}),
    run_id: row.recommendation.run.producerRunId,
    integration_contract_version: PRODUCER_FEEDBACK_CONTRACT_VERSION,
    logged_at_utc: row.recordedAt.toISOString(),
  };
  assertProducerCompatibleDecision(event);
  return event;
}

export function assertProducerCompatibleOutcome(event: object): void {
  assertSafeAllowedEvent(event, OUTCOME_ALLOWED_FIELDS, "trajectory outcome");
  const record = event as Record<string, unknown>;
  if (
    record.attended !== undefined &&
    record.attended !== "yes" &&
    record.attended !== "no"
  ) {
    throw new Error("Outcome attended must be yes or no");
  }
  if (
    record.access !== undefined &&
    (typeof record.access !== "string" ||
      !producerAccessValues.has(record.access))
  ) {
    throw new Error("Unapproved producer access outcome");
  }
  for (const field of ["keepers", "relationship_value", "publication_value"]) {
    const value = record[field];
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    ) {
      throw new Error(`${field} must be a non-negative integer`);
    }
  }
  for (const field of ["relationship_value", "publication_value"]) {
    const value = record[field];
    if (typeof value === "number" && value > 2) {
      throw new Error(`${field} must be between 0 and 2`);
    }
  }
  if (
    record.shootability !== undefined &&
    (typeof record.shootability !== "string" ||
      !producerShootabilityValues.has(record.shootability))
  ) {
    throw new Error("Unapproved producer shootability outcome");
  }
  if (
    record.venue_accessibility !== undefined &&
    (typeof record.venue_accessibility !== "string" ||
      !producerAccessibilityValues.has(record.venue_accessibility))
  ) {
    throw new Error("Unapproved producer venue accessibility outcome");
  }
}

export function buildTrajectoryOutcomeExportEvent(
  row: TrajectoryOutcomeExportRow,
): ProducerOutcomeEvent {
  const event: ProducerOutcomeEvent = {
    show_id: externalShowId(row.recommendation),
    ...(row.attended === null
      ? {}
      : { attended: row.attended ? ("yes" as const) : ("no" as const) }),
    ...(row.access ? { access: row.access } : {}),
    ...(row.keeperCount === null ? {} : { keepers: row.keeperCount }),
    ...(row.relationshipValue === null
      ? {}
      : { relationship_value: row.relationshipValue }),
    ...(row.publicationValue === null
      ? {}
      : { publication_value: row.publicationValue }),
    ...(row.shootability ? { shootability: row.shootability } : {}),
    ...(row.venueAccessibility
      ? { venue_accessibility: row.venueAccessibility }
      : {}),
    run_id: row.recommendation.run.producerRunId,
    integration_contract_version: PRODUCER_FEEDBACK_CONTRACT_VERSION,
    logged_at_utc: row.recordedAt.toISOString(),
  };
  assertProducerCompatibleOutcome(event);
  return event;
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

export function assertProducerCompatibleEvent(event: object): void {
  assertSafeAllowedEvent(
    event,
    PRODUCER_OUTREACH_ENGAGEMENT_ALLOWED_FIELDS,
    "trajectory feedback",
  );
  const record = event as Record<string, unknown>;
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
  const showId = externalShowId({
    ...row.trajectoryRecommendation,
    outreaches: [],
  });
  const artistId = row.trajectoryRecommendation.runArtist.edmtrainArtistId;
  if (!Number.isInteger(artistId) || artistId <= 0) {
    throw new Error(
      `Recommendation ${row.trajectoryRecommendation.id} has no EDMTrain artist attribution`,
    );
  }

  const event: ProducerOutreachEngagementEvent = {
    outreach_id: row.id,
    show_id: showId,
    edmtrain_artist_id: artistId,
    status: normalizeProducerOutreachStatus(row),
    ...(iso(row.sentAt) ? { sent_at: iso(row.sentAt) } : {}),
    ...(iso(row.deliveredAt) ? { delivered_at: iso(row.deliveredAt) } : {}),
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

function serializeRows<T>(
  rows: readonly T[],
  sortKey: (row: T) => string,
  build: (row: T) => object,
): string {
  const sorted = [...rows].sort((left, right) =>
    sortKey(left).localeCompare(sortKey(right)),
  );
  if (sorted.length === 0) return "";
  return `${sorted.map((row) => JSON.stringify(build(row))).join("\n")}\n`;
}

export function serializeTrajectoryDecisionJsonl(
  rows: readonly TrajectoryDecisionExportRow[],
): string {
  return serializeRows(
    rows,
    (row) => `${row.recordedAt.toISOString()}\u0000${row.id}`,
    buildTrajectoryDecisionExportEvent,
  );
}

export function serializeTrajectoryOutcomeJsonl(
  rows: readonly TrajectoryOutcomeExportRow[],
): string {
  return serializeRows(
    rows,
    (row) => `${row.recordedAt.toISOString()}\u0000${row.id}`,
    buildTrajectoryOutcomeExportEvent,
  );
}

export function serializeTrajectoryEngagementJsonl(
  rows: readonly TrajectoryEngagementExportRow[],
): string {
  return serializeRows(rows, (row) => row.id, buildTrajectoryEngagementExportEvent);
}

export const serializeTrajectoryFeedbackJsonl =
  serializeTrajectoryEngagementJsonl;

export function selectLatestEvidenceByRecommendation<
  T extends {
    id: string;
    recordedAt: Date;
    recommendation: { id: string };
  },
>(rows: readonly T[]): T[] {
  const latest = new Map<string, T>();
  for (const row of rows) {
    const existing = latest.get(row.recommendation.id);
    if (
      !existing ||
      row.recordedAt > existing.recordedAt ||
      (row.recordedAt.getTime() === existing.recordedAt.getTime() &&
        row.id > existing.id)
    ) {
      latest.set(row.recommendation.id, row);
    }
  }
  return [...latest.values()];
}

const recommendationExportSelect = {
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
  outreaches: {
    where: { kind: "original" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 1,
    select: { id: true },
  },
} satisfies Prisma.TrajectoryRecommendationSelect;

export async function loadTrajectoryDecisionExportRows(): Promise<
  TrajectoryDecisionExportRow[]
> {
  const rows = await db.trajectoryFeedbackEvent.findMany({
    where: { supersededBy: null },
    orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      action: true,
      propensity: true,
      manualOverride: true,
      recordedAt: true,
      recommendation: {
        select: recommendationExportSelect,
      },
    },
  });
  return selectLatestEvidenceByRecommendation(rows);
}

export async function loadTrajectoryOutcomeExportRows(): Promise<
  TrajectoryOutcomeExportRow[]
> {
  const rows = await db.trajectoryShowOutcome.findMany({
    where: { supersededBy: null },
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
      recordedAt: true,
      recommendation: {
        select: recommendationExportSelect,
      },
    },
  });
  return selectLatestEvidenceByRecommendation(rows);
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
