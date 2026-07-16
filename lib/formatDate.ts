import { dateOnlyFromStoredDate, parseDateOnly } from "@/lib/calendarDate";

// Calendar dates are stored as UTC midnight values. Formatting in UTC with an
// explicit locale preserves the source date without depending on the host.
export function formatShowDate(
  date: Date | string,
  opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", year: "numeric" },
): string {
  const canonical = parseDateOnly(dateOnlyFromStoredDate(date));
  return new Intl.DateTimeFormat("en-US", {
    ...opts,
    timeZone: "UTC",
  }).format(canonical);
}
