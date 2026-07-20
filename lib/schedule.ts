/**
 * Weekend-aware scheduling utilities.
 * All logic uses America/New_York (ET) since this app manages NYC shows.
 */

import { EASTERN_TIME_ZONE } from "@/lib/calendarDate";

export const OUTREACH_TIME_ZONE = EASTERN_TIME_ZONE;
export const OUTREACH_MORNING_DISPATCH_HOUR = 9;
export const OUTREACH_RECOVERY_OVERDUE_MS = 2 * 60 * 60 * 1000;
export const OUTREACH_CLAIM_TIMEOUT_MS = 15 * 60 * 1000;
export const OUTREACH_PROVIDER_TRANSACTION_TIMEOUT_MS = 30 * 1000;
export const SCHEDULED_DISPATCH_ROUTE_TIMEOUT_MS = 60 * 1000;
export const SCHEDULED_DISPATCH_TRANSACTION_RESPONSE_MARGIN_MS = 10 * 1000;
export const SCHEDULED_DISPATCH_MAX_ROWS = 100;
export const SCHEDULED_DISPATCH_MAX_MS =
  SCHEDULED_DISPATCH_ROUTE_TIMEOUT_MS -
  OUTREACH_PROVIDER_TRANSACTION_TIMEOUT_MS -
  SCHEDULED_DISPATCH_TRANSACTION_RESPONSE_MARGIN_MS;

export type ScheduledDispatchDisposition =
  | "success"
  | "skipped"
  | "retryable"
  | "terminal";

export type ScheduledDispatchState =
  | "complete"
  | "pending_claims"
  | "scheduled_retries"
  | "retryable_failure"
  | "terminal_failure"
  | "bounded";

export interface ScheduledDispatchStateInput {
  terminalFailures: number;
  unscheduledRetryableFailures: number;
  pendingClaims: number;
  scheduledRetries: number;
  bounded: boolean;
}

export function getScheduledDispatchDisposition(result: {
  ok: boolean;
  skipped?: boolean;
  retryScheduled?: boolean;
}): ScheduledDispatchDisposition {
  if (result.skipped) return "skipped";
  if (result.ok) return "success";
  return result.retryScheduled ? "retryable" : "terminal";
}

export function getScheduledDispatchState({
  terminalFailures,
  unscheduledRetryableFailures,
  pendingClaims,
  scheduledRetries,
  bounded,
}: ScheduledDispatchStateInput): ScheduledDispatchState {
  if (terminalFailures > 0) return "terminal_failure";
  if (unscheduledRetryableFailures > 0) return "retryable_failure";
  if (pendingClaims > 0) return "pending_claims";
  if (bounded) return "bounded";
  if (scheduledRetries > 0) return "scheduled_retries";
  return "complete";
}

export function getScheduledDispatchHttpStatus(
  state: ScheduledDispatchState,
): number {
  if (state === "terminal_failure") return 500;
  if (state === "retryable_failure") return 503;
  if (state === "pending_claims") return 202;
  return 200;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  weekday: string;
  hour: number;
}

function partsInET(date: Date): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: OUTREACH_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: Number(value("year")),
    month: Number(value("month")),
    day: Number(value("day")),
    weekday: value("weekday"),
    hour: Number(value("hour")),
  };
}

function localETToUtc(year: number, month: number, day: number, hour: number): Date {
  const localAsUtc = Date.UTC(year, month - 1, day, hour);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: OUTREACH_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(new Date(localAsUtc));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  const representedAsUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour"),
    value("minute"),
    value("second")
  );
  return new Date(localAsUtc - (representedAsUtc - localAsUtc));
}

/** True when the supplied instant is Saturday or Sunday in ET. */
export function isWeekendET(now: Date = new Date()): boolean {
  const weekday = partsInET(now).weekday;
  return weekday === "Sat" || weekday === "Sun";
}

/** True during the weekday 09:00-09:59 outreach dispatch window in ET. */
export function isOutreachMorningDispatchWindow(
  now: Date = new Date(),
): boolean {
  const { hour, weekday } = partsInET(now);
  return (
    hour === OUTREACH_MORNING_DISPATCH_HOUR &&
    weekday !== "Sat" &&
    weekday !== "Sun"
  );
}

export function getOutreachRecoveryCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - OUTREACH_RECOVERY_OVERDUE_MS);
}

/**
 * Returns the next Monday at 9:00 AM ET as a UTC Date.
 */
export function getNextMondaySlot(now: Date = new Date()): Date {
  const et = partsInET(now);
  const weekdayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(et.weekday);
  const daysUntilMonday = weekdayIndex === 0 ? 1 : weekdayIndex === 6 ? 2 : 8 - weekdayIndex;
  const target = new Date(Date.UTC(et.year, et.month - 1, et.day + daysUntilMonday));
  return localETToUtc(
    target.getUTCFullYear(),
    target.getUTCMonth() + 1,
    target.getUTCDate(),
    9
  );
}

export function isStaleOutreachClaim(
  claimedAt: Date | null,
  now: Date = new Date()
): boolean {
  return !claimedAt || now.getTime() - claimedAt.getTime() >= OUTREACH_CLAIM_TIMEOUT_MS;
}

export function shouldContinueScheduledDispatch(
  startedAtMs: number,
  processed: number,
  nowMs: number = Date.now()
): boolean {
  return (
    processed < SCHEDULED_DISPATCH_MAX_ROWS &&
    nowMs - startedAtMs < SCHEDULED_DISPATCH_MAX_MS
  );
}

/** Format a UTC Date as a human-readable ET string like "Mon, Jun 1 at 9:23 AM" */
export function formatScheduledTime(utcDate: Date): string {
  return utcDate.toLocaleString("en-US", {
    timeZone: OUTREACH_TIME_ZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}
