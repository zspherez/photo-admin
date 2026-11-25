import {
  countryLabel,
  normalizeCountryCode,
} from "@/lib/country";
import { firstSearchParam } from "@/lib/searchParams";

export interface FestivalListView {
  includeInternational: boolean;
  dismissed: boolean;
}

export const DEFAULT_FESTIVAL_LIST_VIEW: FestivalListView = {
  includeInternational: true,
  dismissed: false,
};

// UN M49 Americas and Europe (ISO alpha-2).
const FESTIVAL_REGION_CODES = new Set(
  "AI AG AW BS BB BQ VG KY CU CW DM DO GD GP HT JM MQ MS PR BL KN LC MF VC SX TT TC VI BZ CR SV GT HN MX NI PA AR BO BV BR CL CO EC FK GF GY PY PE GS SR UY VE BM CA GL PM US BY BG CZ HU PL MD RO RU SK UA AX DK EE FO FI GG IS IE IM JE LV LT NO SJ SE GB AL AD BA HR GI GR VA IT MT ME MK PT SM RS SI ES AT BE FR DE LI LU MC NL CH".split(" ")
);

function enabledSearchParam(value: unknown): boolean {
  const normalized = firstSearchParam(value)?.toLowerCase();
  return normalized === "1" || normalized === "true";
}

export function parseFestivalListView(input: {
  includeInternational?: unknown;
  dismissed?: unknown;
}): FestivalListView {
  return {
    includeInternational: input.includeInternational === undefined ||
      input.includeInternational === null
      ? true
      : enabledSearchParam(input.includeInternational),
    dismissed: enabledSearchParam(input.dismissed),
  };
}

export function festivalListPath(
  view: FestivalListView = DEFAULT_FESTIVAL_LIST_VIEW
): string {
  const params = new URLSearchParams();
  params.set("includeInternational", view.includeInternational ? "1" : "0");
  if (view.dismissed) params.set("dismissed", "1");
  const query = params.toString();
  return query ? `/festivals?${query}` : "/festivals";
}

export type FestivalCountryCategory = "us" | "international" | "unknown";

export function festivalCountryCategory(country: {
  countryCode: string | null;
}): FestivalCountryCategory {
  const code = normalizeCountryCode(country.countryCode);
  if (code === "US") return "us";
  return code ? "international" : "unknown";
}

export function isFestivalVisible(
  festival: {
    dismissedAt: Date | null;
    countryCode: string | null;
  },
  view: FestivalListView
): boolean {
  if ((festival.dismissedAt !== null) !== view.dismissed) return false;
  const code = normalizeCountryCode(festival.countryCode);
  return code === "US" ||
    (view.includeInternational && !!code && FESTIVAL_REGION_CODES.has(code));
}

export function isFestivalInTargetRegion(festival: { countryCode: string | null }): boolean {
  const code = normalizeCountryCode(festival.countryCode);
  return !!code && FESTIVAL_REGION_CODES.has(code);
}

function normalizedGroupPart(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().trim().replace(/\s+/g, " ");
}

export function festivalGroupKey(festival: {
  id?: string;
  eventName: string | null;
  venueName: string;
  city: string;
  countryCode: string | null;
  countryName: string | null;
}): string {
  const countryCode = normalizeCountryCode(festival.countryCode);
  const country =
    countryCode ??
    (festival.countryName
      ? `unknown:${normalizedGroupPart(
          countryLabel({
            countryCode: festival.countryCode,
            countryName: festival.countryName,
          })
        )}`
      : `unknown-id:${festival.id ?? "unidentified"}`);
  return [
    normalizedGroupPart(festival.eventName ?? festival.venueName),
    normalizedGroupPart(festival.venueName),
    normalizedGroupPart(festival.city),
    country,
  ].join("|");
}
