export const DEFAULT_COUNTRY_CODE = "US";

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
const validCountryCodes = new Set(
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(
    " "
  )
);

function countryKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const countryCodesByName = new Map<string, string>();

for (const code of validCountryCodes) {
  const name = regionNames.of(code);
  if (name) countryCodesByName.set(countryKey(name), code);
}

for (const [name, code] of Object.entries({
  america: "US",
  england: "GB",
  "great britain": "GB",
  "south korea": "KR",
  "united kingdom": "GB",
  "united states": "US",
  "united states of america": "US",
  uk: "GB",
  usa: "US",
})) {
  countryCodesByName.set(countryKey(name), code);
}

function sanitizedCountry(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > 100 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

export function normalizeCountryCode(value: unknown): string | null {
  const country = sanitizedCountry(value);
  if (!country) return null;
  const upper = country.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper) && validCountryCodes.has(upper)) {
    return upper;
  }
  return countryCodesByName.get(countryKey(country)) ?? null;
}

export function countryNameForCode(value: unknown): string | null {
  const code = normalizeCountryCode(value);
  return code ? (regionNames.of(code) ?? code) : null;
}

export function normalizeCountry(value: unknown): {
  countryCode: string | null;
  countryName: string | null;
} {
  const countryName = sanitizedCountry(value);
  if (!countryName) {
    return { countryCode: null, countryName: null };
  }
  const countryCode = normalizeCountryCode(countryName);
  return {
    countryCode,
    countryName: countryCode
      ? countryNameForCode(countryCode)
      : countryName,
  };
}

export function countryLabel(country: {
  countryCode: string | null;
  countryName: string | null;
}): string {
  const name = countryNameForCode(country.countryCode);
  if (name) return name;
  const fallback = sanitizedCountry(country.countryName);
  return fallback
    ? `${fallback} (country code unknown)`
    : "Unknown country";
}
