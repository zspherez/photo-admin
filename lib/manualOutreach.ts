import type { Prisma } from "@prisma/client";

export const MANUAL_OUTREACH_SUBJECT = "(manual outreach)";
export const MANUAL_OUTREACH_HTML = "(manual outreach)";

export const REUSABLE_MANUAL_OUTREACH_MARKER_WHERE = {
  kind: "original",
  providerMessageId: null,
  attemptCount: 0,
  finalSubject: MANUAL_OUTREACH_SUBJECT,
  finalHtml: MANUAL_OUTREACH_HTML,
  sendAttempts: { none: {} },
} satisfies Prisma.OutreachWhereInput;

export const MANUAL_OUTREACH_MARKER_WHERE = {
  status: "sent",
  ...REUSABLE_MANUAL_OUTREACH_MARKER_WHERE,
} satisfies Prisma.OutreachWhereInput;

export interface ManualOutreachState {
  status: string;
  providerMessageId: string | null;
  attemptCount: number;
  sendAttemptCount: number;
}

export interface ManualOutreachMarkerRecord extends ManualOutreachState {
  id: string;
  kind: "original" | "follow_up";
  showId: string;
  artistId: string;
  finalSubject: string;
  finalHtml: string;
}

export function isActiveManualOutreachMarker(
  row: ManualOutreachMarkerRecord
): boolean {
  return (
    row.kind === "original" &&
    row.status === "sent" &&
    row.providerMessageId === null &&
    row.attemptCount === 0 &&
    row.sendAttemptCount === 0 &&
    row.finalSubject === MANUAL_OUTREACH_SUBJECT &&
    row.finalHtml === MANUAL_OUTREACH_HTML
  );
}

export interface ManualOutreachMarkerStore {
  findById(id: string): Promise<ManualOutreachMarkerRecord | null>;
  deleteActiveMarker(id: string): Promise<boolean>;
}

export async function removeManualOutreachMarker(
  store: ManualOutreachMarkerStore,
  outreachId: string
): Promise<ManualOutreachMarkerRecord | null> {
  const marker = await store.findById(outreachId);
  if (!marker || !isActiveManualOutreachMarker(marker)) return null;
  return (await store.deleteActiveMarker(marker.id)) ? marker : null;
}

export function manualMarkBlockingReason(
  rows: readonly ManualOutreachState[]
): string | null {
  if (rows.some((row) => row.status === "sent")) {
    return "Outreach is already sent for this artist";
  }
  if (rows.some((row) => row.status === "scheduled")) {
    return "Automated outreach is already scheduled";
  }
  if (rows.some((row) => row.status === "retry_scheduled")) {
    return "An automatic outreach retry is already scheduled";
  }
  if (rows.some((row) => row.status === "queued")) {
    return "Automated outreach is already in progress";
  }
  if (rows.some((row) => row.status === "manual_review")) {
    return "Existing email outreach history requires review";
  }
  if (
    rows.some(
      (row) =>
        row.status === "failed" &&
        (row.providerMessageId !== null ||
          row.attemptCount > 0 ||
          row.sendAttemptCount > 0)
    )
  ) {
    return "Existing email outreach history requires review";
  }
  return null;
}

export function canMarkOutreachManually(
  rows: readonly ManualOutreachState[]
): boolean {
  return manualMarkBlockingReason(rows) === null;
}
