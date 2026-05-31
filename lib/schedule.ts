/**
 * Weekend-aware scheduling utilities.
 * All logic uses America/New_York (ET) since this app manages NYC shows.
 */

const TZ = "America/New_York";

function nowInET(): Date {
  const str = new Date().toLocaleString("en-US", { timeZone: TZ });
  return new Date(str);
}

/** True when the current time in ET is Saturday (6) or Sunday (0). */
export function isWeekendET(): boolean {
  const day = nowInET().getDay();
  return day === 0 || day === 6;
}

/**
 * Returns the next Monday at 9:00 AM ET as a UTC Date.
 */
export function getNextMondaySlot(): Date {
  const et = nowInET();
  const day = et.getDay(); // 0=Sun, 6=Sat
  const daysUntilMonday = day === 0 ? 1 : day === 6 ? 2 : (8 - day) % 7 || 7;

  const monday = new Date(et);
  monday.setDate(monday.getDate() + daysUntilMonday);
  monday.setHours(9, 0, 0, 0);

  // Convert ET time to UTC
  const etYear = monday.getFullYear();
  const etMonth = String(monday.getMonth() + 1).padStart(2, "0");
  const etDay = String(monday.getDate()).padStart(2, "0");

  // Determine ET→UTC offset on that day (handles EDT vs EST)
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const tempDate = new Date(`${etYear}-${etMonth}-${etDay}T12:00:00Z`);
  const parts = formatter.formatToParts(tempDate);
  const findPart = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "0";
  const utcNoon = 12;
  const etNoon = parseInt(findPart("hour"), 10);
  const offsetHours = utcNoon - etNoon; // 4 (EDT) or 5 (EST)

  return new Date(
    Date.UTC(etYear, monday.getMonth(), monday.getDate(), 9 + offsetHours, 0, 0, 0)
  );
}

/** Format a UTC Date as a human-readable ET string like "Mon, Jun 1 at 9:23 AM" */
export function formatScheduledTime(utcDate: Date): string {
  return utcDate.toLocaleString("en-US", {
    timeZone: TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}
