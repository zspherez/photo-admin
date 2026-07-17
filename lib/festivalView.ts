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
  includeInternational: false,
  dismissed: false,
};

function enabledSearchParam(value: unknown): boolean {
  const normalized = firstSearchParam(value)?.toLowerCase();
  return normalized === "1" || normalized === "true";
}

export function parseFestivalListView(input: {
  includeInternational?: unknown;
  dismissed?: unknown;
}): FestivalListView {
  return {
    includeInternational: enabledSearchParam(input.includeInternational),
    dismissed: enabledSearchParam(input.dismissed),
  };
}

export function festivalListPath(
  view: FestivalListView = DEFAULT_FESTIVAL_LIST_VIEW
): string {
  const params = new URLSearchParams();
  if (view.includeInternational) params.set("includeInternational", "1");
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
  return (
    festivalCountryCategory(festival) === "us" ||
    view.includeInternational
  );
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
