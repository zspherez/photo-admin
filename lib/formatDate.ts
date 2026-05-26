// Show dates are stored as UTC midnight (see lib/edmtrain.ts).
// Format in UTC so the calendar day doesn't shift in negative offsets.
export function formatShowDate(
  date: Date | string,
  opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", year: "numeric" },
): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString(undefined, { ...opts, timeZone: "UTC" });
}
