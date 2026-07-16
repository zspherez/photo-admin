import type { Prisma } from "@prisma/client";

export const MANUAL_OUTREACH_SUBJECT = "(manual outreach)";
export const MANUAL_OUTREACH_HTML = "(manual outreach)";

export const MANUAL_OUTREACH_MARKER_WHERE = {
  providerMessageId: null,
  attemptCount: 0,
  finalSubject: MANUAL_OUTREACH_SUBJECT,
  finalHtml: MANUAL_OUTREACH_HTML,
  sendAttempts: { none: {} },
} satisfies Prisma.OutreachWhereInput;

export interface ManualOutreachState {
  status: string;
  providerMessageId: string | null;
  attemptCount: number;
  sendAttemptCount: number;
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
