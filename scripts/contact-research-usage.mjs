import { appendFileSync, readFileSync } from "node:fs";

export const NANO_AIU_PER_CREDIT = 1_000_000_000;

export function creditsFromNanoAiu(value) {
  return value / NANO_AIU_PER_CREDIT;
}

export function parseUsageEvent(event, currentNanoAiu = null) {
  if (
    event?.type === "session.usage_checkpoint" &&
    Number.isFinite(event.data?.totalNanoAiu)
  ) {
    return event.data.totalNanoAiu;
  }
  return currentNanoAiu;
}

export function readArtistForSession(metricsFile, sessionId) {
  if (!metricsFile || !sessionId) return null;
  try {
    const metrics = JSON.parse(readFileSync(metricsFile, "utf8"));
    const artist = metrics?.artistBySession?.[sessionId];
    return typeof artist === "string" && artist.trim()
      ? artist.trim()
      : null;
  } catch {
    return null;
  }
}

export function appendUsageRecord(path, record) {
  appendFileSync(path, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function summarizeUsageRecords(records) {
  const valid = records.filter(
    (record) =>
      typeof record?.artist === "string" &&
      Number.isFinite(record?.nanoAiu) &&
      record.nanoAiu >= 0
  );
  const totalNanoAiu = valid.reduce(
    (sum, record) => sum + record.nanoAiu,
    0
  );
  return {
    artists: valid.length,
    totalNanoAiu,
    totalCredits: creditsFromNanoAiu(totalNanoAiu),
    averageCredits:
      valid.length > 0
        ? creditsFromNanoAiu(totalNanoAiu) / valid.length
        : 0,
  };
}
