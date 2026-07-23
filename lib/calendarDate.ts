import { appConfig } from "@/lib/appConfig";

export const EASTERN_TIME_ZONE = appConfig.timeZone;

const easternDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: EASTERN_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function dateParts(
  instant: Date,
  formatter: Intl.DateTimeFormat
): { year: string; month: string; day: string } {
  const parts = formatter.formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  const year = value("year");
  const month = value("month");
  const day = value("day");
  if (!year || !month || !day) {
    throw new Error("Unable to determine calendar date");
  }
  return { year, month, day };
}

export function easternDateOnly(instant: Date = new Date()): string {
  const { year, month, day } = dateParts(instant, easternDateFormatter);
  return `${year}-${month}-${day}`;
}

export function parseDateOnly(dateOnly: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly);
  if (!match) throw new Error(`Invalid calendar date: ${dateOnly}`);
  const value = new Date(`${dateOnly}T00:00:00.000Z`);
  if (
    Number.isNaN(value.getTime()) ||
    value.getUTCFullYear() !== Number(match[1]) ||
    value.getUTCMonth() + 1 !== Number(match[2]) ||
    value.getUTCDate() !== Number(match[3])
  ) {
    throw new Error(`Invalid calendar date: ${dateOnly}`);
  }
  return value;
}

export function dateOnlyFromStoredDate(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid stored calendar date: ${String(value)}`);
  }
  return [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

export function addDateOnlyDays(dateOnly: string, days: number): string {
  if (!Number.isInteger(days)) throw new Error("Calendar-day offset must be an integer");
  const value = parseDateOnly(dateOnly);
  value.setUTCDate(value.getUTCDate() + days);
  return dateOnlyFromStoredDate(value);
}

/**
 * Show dates are stored as UTC midnight calendar values. This returns the
 * canonical stored value for today's date in America/New_York.
 */
export function easternTodayStoredDate(now: Date = new Date()): Date {
  return parseDateOnly(easternDateOnly(now));
}

export interface DateOnlyRange {
  startDate: string;
  endDate: string;
  start: Date;
  end: Date;
}

export function easternDateRange(daysAhead: number, now: Date = new Date()): DateOnlyRange {
  if (!Number.isInteger(daysAhead) || daysAhead < 0) {
    throw new Error("daysAhead must be a non-negative integer");
  }
  const startDate = easternDateOnly(now);
  const endDate = addDateOnlyDays(startDate, daysAhead);
  return {
    startDate,
    endDate,
    start: parseDateOnly(startDate),
    end: parseDateOnly(endDate),
  };
}

export function splitDateOnlyRange(
  startDate: string,
  endDate: string,
  maxDaysPerChunk: number
): Array<{ startDate: string; endDate: string }> {
  if (!Number.isInteger(maxDaysPerChunk) || maxDaysPerChunk < 1) {
    throw new Error("maxDaysPerChunk must be a positive integer");
  }
  const end = parseDateOnly(endDate);
  let cursor = parseDateOnly(startDate);
  if (cursor > end) throw new Error("Date range start must not follow end");

  const chunks: Array<{ startDate: string; endDate: string }> = [];
  while (cursor <= end) {
    const chunkStart = dateOnlyFromStoredDate(cursor);
    const candidateEnd = parseDateOnly(addDateOnlyDays(chunkStart, maxDaysPerChunk - 1));
    const chunkEnd = candidateEnd < end ? candidateEnd : end;
    chunks.push({
      startDate: chunkStart,
      endDate: dateOnlyFromStoredDate(chunkEnd),
    });
    cursor = parseDateOnly(addDateOnlyDays(dateOnlyFromStoredDate(chunkEnd), 1));
  }
  return chunks;
}
