import { parseDateOnly } from "@/lib/calendarDate";
import { normalizeCountryCode } from "@/lib/country";
import { festivalRunName } from "@/lib/festivalRuns";
import { isFestivalInTargetRegion } from "@/lib/festivalView";
import { assertPublicHttpsSourceUrl } from "./contactAgentPayloadValidation.mjs";

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};
const US_REGIONS = new Set(
  "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" "),
);
const CA_REGIONS = new Set("AB BC MB NB NL NS NT NU ON PE QC SK YT".split(" "));

export interface FestivalRunEvidence {
  date: string;
  festivalName: string;
  city: string;
  region: string;
  countryCode: string;
  sourceUrl: string;
  evidence: string;
}

function normalizedWords(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function extractFestivalRunEvidence(
  artist: string,
  title: string,
  block: string,
  sourceUrl: string,
  range: { start: Date; end: Date },
): FestivalRunEvidence | null {
  if (artist.length < 2 || title.length > 300 || block.length > 2000) return null;
  const artistName = normalizedWords(artist);
  if (!artistName || !(` ${normalizedWords(`${title} ${block}`)} `.includes(` ${artistName} `))) return null;

  const festival = `${title} ${block}`.match(/\b([\p{L}\p{N}][\p{L}\p{N}&'. -]{1,65}?\s+(?:Festival|Fest|in the Park))\b/iu);
  if (!festival) return null;
  const festivalName = festival[1].trim().replace(/\s+/g, " ")
    .replace(new RegExp(`^${artist.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(?:at|@)\\s+`, "i"), "");
  if (festivalName.length > 100) return null;

  const named = block.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(20\d{2})\b/i);
  const iso = block.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (!named && !iso) return null;
  const month = named ? MONTHS[named[1].toLowerCase().replace(/^sept$/, "sep")] : Number(iso?.[2]);
  const dateOnly = `${named?.[3] ?? iso?.[1]}-${String(month).padStart(2, "0")}-${String(named?.[2] ?? iso?.[3]).padStart(2, "0")}`;
  let date: Date;
  try {
    date = parseDateOnly(dateOnly);
    assertPublicHttpsSourceUrl(sourceUrl, "festival source");
  } catch {
    return null;
  }
  if (date < range.start || date >= range.end) return null;

  const locations = [...block.matchAll(/\b([\p{L}][\p{L} .'-]{1,48}),\s*([\p{L}][\p{L} .'-]{1,48}?)(?:,\s*([\p{L}][\p{L} .'-]{1,48}?))?(?=$|[\n|·;])/gu)];
  const validLocations = locations
    .map((match) => {
      const city = match[1].trim();
      const part = match[2].trim();
      const region = match[3] ? part : "";
      const countryCode = match[3] ? normalizeCountryCode(match[3].trim()) :
        CA_REGIONS.has(part) ? "CA" : US_REGIONS.has(part) ? "US" : normalizeCountryCode(part);
      if (!countryCode || !isFestivalInTargetRegion({ countryCode })) return null;
      if (region && !(countryCode === "CA" ? CA_REGIONS.has(region) :
        countryCode === "US" && US_REGIONS.has(region))) return null;
      return { city, region, countryCode };
    })
    .filter((location): location is { city: string; region: string; countryCode: string } => location !== null);
  if (validLocations.length !== 1 || /^(unknown|online|virtual)$/i.test(validLocations[0].city)) return null;
  return {
    date: dateOnly,
    festivalName,
    ...validLocations[0],
    sourceUrl,
    evidence: `${title}\n${block}`.slice(0, 2300),
  };
}

export function validateFestivalRunEvidence(
  artist: string,
  row: FestivalRunEvidence,
  range: { start: Date; end: Date },
): boolean {
  if (!row || typeof row.evidence !== "string" || typeof row.sourceUrl !== "string" ||
    typeof row.festivalName !== "string" || typeof row.city !== "string" ||
    typeof row.region !== "string" || typeof row.countryCode !== "string" ||
    typeof row.date !== "string" ||
    row.evidence.length > 2300 || row.sourceUrl.length > 2048) return false;
  const [title, ...lines] = row.evidence.split("\n");
  const parsed = extractFestivalRunEvidence(artist, title, lines.join("\n"), row.sourceUrl, range);
  return !!parsed && parsed.date === row.date &&
    festivalRunName(parsed.festivalName) === festivalRunName(row.festivalName) &&
    parsed.city.toLowerCase() === row.city.trim().toLowerCase() &&
    parsed.region === row.region && parsed.countryCode === row.countryCode;
}

export function festivalSuggestionsForConfirmedShows(
  rows: FestivalRunEvidence[],
  shows: Array<{
    date: Date;
    eventName: string | null;
    venueName: string;
  }>,
): FestivalRunEvidence[] {
  const confirmedNames = new Set(shows.map((show) =>
    festivalRunName(show.eventName || show.venueName),
  ));
  const distinctNames = new Set([
    ...confirmedNames,
    ...rows.map((row) => festivalRunName(row.festivalName)),
  ]);
  if (distinctNames.size < 2) return [];
  return rows.filter((row) => !shows.some((show) =>
    show.date.toISOString().slice(0, 10) === row.date &&
    festivalRunName(show.eventName || show.venueName) === festivalRunName(row.festivalName),
  ));
}
