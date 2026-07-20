import { createHash } from "node:crypto";
import { normalizeCountry } from "@/lib/country";

export type VenueNycStatus = "inside_nyc" | "outside_nyc" | "unknown";

export interface EdmtrainVenueInput {
  id: number;
  name: string;
  location?: string | null;
  state?: string | null;
  address?: string | null;
  country?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

export interface CachedEdmtrainVenue {
  id: number;
  address: string | null;
  location: string | null;
  city: string | null;
  state: string | null;
  countryCode: string | null;
  countryName: string | null;
  latitude: number | null;
  longitude: number | null;
  nycStatus: string;
  nycStatusReason: string;
  classificationVersion: number;
  sourceFingerprint: string | null;
}

export interface ResolvedEdmtrainVenue {
  id: number;
  name: string;
  address: string | null;
  location: string | null;
  city: string | null;
  state: string | null;
  countryCode: string | null;
  countryName: string | null;
  latitude: number | null;
  longitude: number | null;
  nycStatus: VenueNycStatus;
  nycStatusReason: string;
  geographySource: "edmtrain";
  classificationVersion: number;
  sourceFingerprint: string;
  reused: boolean;
}

export const EDMTRAIN_VENUE_CLASSIFICATION_VERSION = 1;

const NYC_LOCALITIES = new Set([
  "astoria",
  "bronx",
  "brooklyn",
  "flushing",
  "long island city",
  "manhattan",
  "new york",
  "new york city",
  "queens",
  "staten island",
  "the bronx",
]);

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/\s+/g, " ");
  return cleaned && cleaned.length <= 500 ? cleaned : null;
}

function localityKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizedState(value: string | null): string | null {
  const key = value ? localityKey(value) : "";
  if (key === "ny" || key === "new york") return "NY";
  return value;
}

function finiteCoordinate(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function addressParts(address: string | null): string[] {
  if (!address) return [];
  return address
    .split(",")
    .map((part) => cleanText(part))
    .filter((part): part is string => part !== null);
}

function stateFromAddress(parts: string[]): string | null {
  const region = parts.length >= 3 ? parts[parts.length - 1] : null;
  if (!region) return null;
  return cleanText(region.replace(/\b\d{5}(?:-\d{4})?\b.*$/, ""));
}

function providerGeography(venue: EdmtrainVenueInput) {
  const location = cleanText(venue.location);
  const locationParts = (location ?? "")
    .split(",")
    .map((part) => cleanText(part));
  const address = cleanText(venue.address);
  const parsedAddress = addressParts(address);
  const city =
    locationParts[0] ??
    (parsedAddress.length >= 3 ? parsedAddress[parsedAddress.length - 2] : null);
  const state = normalizedState(
    locationParts[1] ?? cleanText(venue.state) ?? stateFromAddress(parsedAddress)
  );
  return {
    address,
    location,
    city,
    state,
    ...normalizeCountry(venue.country),
    latitude: finiteCoordinate(venue.latitude),
    longitude: finiteCoordinate(venue.longitude),
  };
}

function validCoordinatePair(
  latitude: number | null,
  longitude: number | null
): boolean {
  return (
    latitude !== null &&
    longitude !== null &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180 &&
    !(latitude === 0 && longitude === 0)
  );
}

export function classifyEdmtrainVenueGeography(
  venue: EdmtrainVenueInput
): { status: VenueNycStatus; reason: string } {
  const geography = providerGeography(venue);
  if (geography.countryCode && geography.countryCode !== "US") {
    return { status: "outside_nyc", reason: "provider_country_outside_us" };
  }
  if (
    geography.state &&
    localityKey(geography.state) !== "ny" &&
    localityKey(geography.state) !== "new york"
  ) {
    return { status: "outside_nyc", reason: "provider_state_outside_new_york" };
  }
  if (
    geography.countryCode === "US" &&
    geography.state === "NY" &&
    geography.city
  ) {
    return NYC_LOCALITIES.has(localityKey(geography.city))
      ? { status: "inside_nyc", reason: "provider_nyc_locality" }
      : { status: "outside_nyc", reason: "provider_non_nyc_locality" };
  }
  if (
    validCoordinatePair(geography.latitude, geography.longitude) &&
    (geography.latitude! < 40.4774 ||
      geography.latitude! > 40.9176 ||
      geography.longitude! < -74.2591 ||
      geography.longitude! > -73.7002)
  ) {
    return {
      status: "outside_nyc",
      reason: "provider_coordinates_outside_nyc_envelope",
    };
  }
  return { status: "unknown", reason: "insufficient_provider_geography" };
}

function venueFingerprint(venue: EdmtrainVenueInput): string {
  const geography = providerGeography(venue);
  return createHash("sha256")
    .update(
      JSON.stringify([
        cleanText(venue.name),
        geography.address,
        geography.location,
        geography.city,
        geography.state,
        geography.countryCode,
        geography.countryName,
        geography.latitude,
        geography.longitude,
      ])
    )
    .digest("hex");
}

function validCachedStatus(value: string): value is VenueNycStatus {
  return value === "inside_nyc" || value === "outside_nyc" || value === "unknown";
}

export function resolveEdmtrainVenue(
  venue: EdmtrainVenueInput,
  cached?: CachedEdmtrainVenue
): ResolvedEdmtrainVenue {
  const geography = providerGeography(venue);
  const sourceFingerprint = venueFingerprint(venue);
  const reuse =
    cached?.id === venue.id &&
    cached.classificationVersion === EDMTRAIN_VENUE_CLASSIFICATION_VERSION &&
    cached.sourceFingerprint === sourceFingerprint &&
    validCachedStatus(cached.nycStatus);
  const classification = reuse
    ? {
        status: cached.nycStatus as VenueNycStatus,
        reason: cached.nycStatusReason,
      }
    : classifyEdmtrainVenueGeography(venue);
  const resolvedGeography = reuse
    ? {
        address: cached.address,
        location: cached.location,
        city: cached.city,
        state: cached.state,
        countryCode: cached.countryCode,
        countryName: cached.countryName,
        latitude: cached.latitude,
        longitude: cached.longitude,
      }
    : geography;

  return {
    id: venue.id,
    name: cleanText(venue.name) ?? "Unknown venue",
    ...resolvedGeography,
    nycStatus: classification.status,
    nycStatusReason: classification.reason,
    geographySource: "edmtrain",
    classificationVersion: EDMTRAIN_VENUE_CLASSIFICATION_VERSION,
    sourceFingerprint,
    reused: reuse,
  };
}
