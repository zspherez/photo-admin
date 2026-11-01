import { assertPublicHttpsSourceUrl } from "./contactAgentPayloadValidation.mjs";

const STATES = new Set(
  "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" ")
);
const MONTHS: Record<string, number> = {
  jan: 1, january: 1, dec: 12, december: 12,
};

export interface RunEvidence {
  date: string;
  city: string;
  state: string;
  sourceUrl: string;
  evidence: string;
}

export function extractRunEvidence(
  artist: string,
  title: string,
  block: string,
  sourceUrl: string,
  year: number
): RunEvidence | null {
  if (artist.length < 2 || block.length > 2000 || title.length > 300) return null;
  const normalize = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const name = normalize(artist);
  if (!name || !(` ${normalize(`${title} ${block}`)} `.includes(` ${name} `))) return null;
  const named = block.match(/\b(December|Dec|January|Jan)\.?\s+(2[7-9]|3[01]|0?[1-3])(?:st|nd|rd|th)?[,]?\s+(20\d{2})\b/i);
  const iso = block.match(/\b(20\d{2})-(12|01)-(2[7-9]|3[01]|0?[1-3])\b/);
  const numeric = block.match(/\b(12|01)\/(2[7-9]|3[01]|0?[1-3])\/(20\d{2})\b/);
  if (!named && !iso && !numeric) return null;
  const month = named ? MONTHS[named[1].toLowerCase()] : Number(iso?.[2] ?? numeric?.[1]);
  const day = Number(named?.[2] ?? iso?.[3] ?? numeric?.[2]);
  const eventYear = Number(named?.[3] ?? iso?.[1] ?? numeric?.[3]);
  const date = `${eventYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if ((month === 12 ? day < 27 || day > 31 || eventYear !== year
    : day < 1 || day > 3 || eventYear !== year + 1)) return null;
  const cities = [...block.matchAll(/(?:^|[|·–—:;]\s*|\s+-\s+)([A-Za-z][A-Za-z .'-]{1,48}),\s*([A-Z]{2})\b/g)]
    .filter((item) => STATES.has(item[2]));
  if (cities.length !== 1) return null;
  const city = cities[0][1].trim();
  if (/^(unknown|online|virtual)$/i.test(city)) return null;
  try { assertPublicHttpsSourceUrl(sourceUrl, "event source"); } catch { return null; }
  return { date, city, state: cities[0][2], sourceUrl, evidence: `${title}\n${block}`.slice(0, 2300) };
}

export function validateRunEvidence(artist: string, value: RunEvidence, year: number): boolean {
  if (typeof value.evidence !== "string" || typeof value.sourceUrl !== "string" ||
    typeof value.city !== "string" || typeof value.state !== "string" ||
    typeof value.date !== "string" ||
    value.evidence.length > 2300 || value.sourceUrl.length > 2048) return false;
  const [title, ...lines] = value.evidence.split("\n");
  const parsed = extractRunEvidence(artist, title, lines.join("\n"), value.sourceUrl, year);
  return !!parsed && parsed.date === value.date &&
    parsed.city.toLowerCase() === value.city.trim().toLowerCase() &&
    parsed.state === value.state;
}

export function multiCityEvidence(rows: RunEvidence[]): boolean {
  return new Set(rows.map((row) => `${row.city.trim().toLowerCase()},${row.state}`)).size >= 2;
}

export interface ConfirmedRunShow {
  date: Date;
  city: string;
  state: string | null;
  countryCode: string | null;
  dismissedAt: Date | null;
  syncStatus: string;
  isFestival: boolean;
}

function sameCity(
  a: Pick<ConfirmedRunShow, "city" | "state">,
  b: Pick<ConfirmedRunShow, "city" | "state">
): boolean {
  if (a.city.trim().toLowerCase() !== b.city.trim().toLowerCase()) return false;
  const stateA = a.state?.trim().toUpperCase();
  const stateB = b.state?.trim().toUpperCase();
  return !stateA || !stateB || stateA === stateB ||
    stateA.length !== 2 || stateB.length !== 2;
}

export function newYearSuggestionsForConfirmedShows(
  rows: RunEvidence[],
  shows: ConfirmedRunShow[]
): RunEvidence[] {
  const confirmed = shows.filter((show) =>
    show.countryCode === "US" &&
    show.dismissedAt === null &&
    (show.syncStatus === "active" ||
      (!show.isFestival && show.syncStatus === "outside_nyc")) &&
    show.city.trim() !== "" &&
    show.city.trim().toLowerCase() !== "unknown"
  );
  const cities: Array<Pick<ConfirmedRunShow, "city" | "state">> = [];
  for (const show of [...confirmed, ...rows]) {
    if (!cities.some((city) => sameCity(city, show))) cities.push(show);
  }
  if (cities.length < 2) return [];
  return rows.filter((row) =>
    !confirmed.some((show) =>
      show.date.toISOString().slice(0, 10) === row.date &&
      sameCity(show, row)
    )
  );
}
