export const PROFESSIONAL_CONTACT_LIMITS = {
  organization: 200,
  website: 500,
  locationContext: 300,
  notes: 2_000,
  namesText: 7_000,
  personName: 120,
  people: 50,
} as const;

export interface ProfessionalContactRequestInput {
  organizationName: string;
  normalizedOrganization: string;
  website: string | null;
  locationContext: string | null;
  notes: string | null;
  personNames: string[];
}

function normalizedText(value: unknown, field: string, maxLength: number) {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!normalized) throw new Error(`${field} is required`);
  if (/[\u0000-\u001f\u007f-\u009f]/.test(normalized)) {
    throw new Error(`${field} contains unsupported control characters`);
  }
  if (normalized.length > maxLength) {
    throw new Error(`${field} must be at most ${maxLength} characters`);
  }
  return normalized;
}

function optionalText(value: unknown, field: string, maxLength: number) {
  if (value == null || value === "") return null;
  return normalizedText(value, field, maxLength);
}

export function normalizeProfessionalIdentity(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeWebsite(value: unknown): string | null {
  const raw = optionalText(
    value,
    "website",
    PROFESSIONAL_CONTACT_LIMITS.website,
  );
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("website must be a valid public HTTPS URL");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !hostname.includes(".") ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    /^\d+(?:\.\d+){3}$/.test(hostname) ||
    hostname.includes(":")
  ) {
    throw new Error("website must be a valid public HTTPS URL");
  }
  url.hash = "";
  return url.toString();
}

export function normalizeProfessionalPersonNames(value: unknown): string[] {
  if (typeof value !== "string") throw new Error("person names must be text");
  if (value.length > PROFESSIONAL_CONTACT_LIMITS.namesText) {
    throw new Error(
      `person names must be at most ${PROFESSIONAL_CONTACT_LIMITS.namesText} characters`,
    );
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const name = normalizedText(
      line,
      "person name",
      PROFESSIONAL_CONTACT_LIMITS.personName,
    );
    if (/@|https?:\/\/|www\./i.test(name)) {
      throw new Error(`person name is invalid: ${name}`);
    }
    const key = normalizeProfessionalIdentity(name);
    if (key.length < 2 || !/\p{L}/u.test(key)) {
      throw new Error(`person name is invalid: ${name}`);
    }
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  if (names.length === 0) throw new Error("at least one person name is required");
  if (names.length > PROFESSIONAL_CONTACT_LIMITS.people) {
    throw new Error(
      `no more than ${PROFESSIONAL_CONTACT_LIMITS.people} people may be submitted`,
    );
  }
  return names;
}

export function parseProfessionalContactRequestInput(
  value: Record<string, unknown>,
): ProfessionalContactRequestInput {
  const organizationName = normalizedText(
    value.organizationName,
    "organization name",
    PROFESSIONAL_CONTACT_LIMITS.organization,
  );
  const normalizedOrganization = normalizeProfessionalIdentity(organizationName);
  if (normalizedOrganization.length < 2) {
    throw new Error("organization name is invalid");
  }
  return {
    organizationName,
    normalizedOrganization,
    website: normalizeWebsite(value.website),
    locationContext: optionalText(
      value.locationContext,
      "location/context",
      PROFESSIONAL_CONTACT_LIMITS.locationContext,
    ),
    notes: optionalText(
      value.notes,
      "notes",
      PROFESSIONAL_CONTACT_LIMITS.notes,
    ),
    personNames: normalizeProfessionalPersonNames(value.personNames),
  };
}
