export const CANCELLABLE_OUTREACH_STATUSES = [
  "scheduled",
  "retry_scheduled",
] as const;

export type CancellableOutreachStatus =
  (typeof CANCELLABLE_OUTREACH_STATUSES)[number];

export function isCancellableOutreachStatus(
  status: string | null | undefined
): status is CancellableOutreachStatus {
  return CANCELLABLE_OUTREACH_STATUSES.some(
    (cancellableStatus) => cancellableStatus === status
  );
}
