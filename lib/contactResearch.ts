import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
} from "jose";
import { db } from "@/lib/db";
import {
  addDateOnlyDays,
  easternDateOnly,
  easternTodayStoredDate,
  parseDateOnly,
} from "@/lib/calendarDate";
import { activeListenSignalWhere } from "@/lib/listenSignal";
import { appendContactToSheet, parseSheetEmails } from "@/lib/sheets";
import { constantTimeEqual } from "@/lib/auth";
import { readGlobalAgentRulesInTransaction } from "@/lib/agentRules";

export const CONTACT_RESEARCH_WINDOW_DAYS = 90;
export const CONTACT_RESEARCH_DEFAULT_CLAIM_LIMIT = 3;
export const CONTACT_RESEARCH_MAX_CLAIM_LIMIT = 10;
export const CONTACT_RESEARCH_CLAIM_TTL_MS = 60 * 60 * 1_000;
export const CONTACT_RESEARCH_OIDC_AUDIENCE =
  "photo-admin-contact-research";
export const CONTACT_RESEARCH_OIDC_ISSUER =
  "https://token.actions.githubusercontent.com";
export const CONTACT_RESEARCH_WORKFLOW_REF =
  "zspherez/photo-admin/.github/workflows/contact-research.yml@refs/heads/main";

const EMAIL_PATTERN = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const CONFIDENCE_VALUES = new Set(["high", "medium", "low"]);
const OFFICIAL_SOURCE_TYPES = new Set([
  "website",
  "instagram",
  "facebook",
  "soundcloud",
]);
const OFFICIAL_MANAGEMENT_LABELS = new Set(["mgmt", "management"]);
const MAILBOX_PREFIX_CHARACTER =
  /[\p{L}\p{N}\p{M}.!#$%&'*+/=?^_`{|}~@-]/u;
const MAILBOX_SUFFIX_CHARACTER = /[\p{L}\p{N}\p{M}_@+-]/u;
const MAILBOX_DOMAIN_LABEL_CHARACTER = /[\p{L}\p{N}\p{M}]/u;
const githubActionsJwks = createRemoteJWKSet(
  new URL(`${CONTACT_RESEARCH_OIDC_ISSUER}/.well-known/jwks`)
);

export interface ContactResearchCandidateInput {
  email: string;
  normalizedEmail: string;
  name: string | null;
  role: "management";
  sourceUrls: string[];
  evidence: string;
  confidence: "high" | "medium" | "low";
  needsApproval: boolean;
  officialSourceType:
    | "website"
    | "instagram"
    | "facebook"
    | "soundcloud"
    | null;
  officialSourceUrl: string | null;
  officialManagementLabel: "mgmt" | "management" | null;
  officialSourceEvidence: string | null;
}

export type ContactResearchSubmission =
  | {
      outcome: "candidates";
      claimToken: string;
      notes: string | null;
      candidates: ContactResearchCandidateInput[];
    }
  | {
      outcome: "exhausted";
      claimToken: string;
      notes: string | null;
      candidates: [];
    };

export interface ContactResearchQueueResult {
  eligible: number;
  enqueued: number;
  reprioritized: number;
  completed: number;
  inactivated: number;
}

export interface ContactResearchPreparationResult
  extends ContactResearchQueueResult {
  claimable: number;
}

export interface ContactResearchPriorityInput {
  interested: boolean;
  hasActiveSignal: boolean;
  popularity: number | null;
  daysUntilShow: number;
}

const ACTIVE_EMAIL_CONTACT_WHERE = {
  state: "active",
  email: { not: null },
} satisfies Prisma.ContactWhereInput;

function optionalString(
  value: unknown,
  maxLength: number,
  field: string
): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) {
    throw new Error(`${field} must be at most ${maxLength} characters`);
  }
  return normalized;
}

function requiredString(
  value: unknown,
  maxLength: number,
  field: string
): string {
  const normalized = optionalString(value, maxLength, field);
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

export function normalizeResearchEmail(value: unknown): string {
  const raw = requiredString(value, 320, "email");
  const email = raw.toLowerCase();
  const parsed = parseSheetEmails(raw);
  if (
    parsed.isFullTeam ||
    parsed.emails.length !== 1 ||
    parsed.emails[0] !== email ||
    !EMAIL_PATTERN.test(email)
  ) {
    throw new Error("email is invalid");
  }
  return email;
}

export function isManagerContact(contact: {
  email: string | null;
  role: string | null;
  state?: "active" | "quarantined";
}): boolean {
  return Boolean(
    contact.email?.trim() && contact.state !== "quarantined"
  );
}

export function needsManagerContactResearch(
  contacts: Array<{
    email: string | null;
    role: string | null;
    state?: "active" | "quarantined";
  }>
): boolean {
  return !contacts.some(isManagerContact);
}

export function festivalManagerResearchJobDisposition(
  status: string | null
): "create" | "requeue" | "existing" {
  if (status === null) return "create";
  if (["complete", "exhausted", "inactive"].includes(status)) {
    return "requeue";
  }
  return "existing";
}

export function normalizeManagerRole(value: unknown): "management" {
  const role = requiredString(value, 100, "role").toLowerCase();
  if (role !== "manager" && role !== "management") {
    throw new Error("role must be manager or management");
  }
  return "management";
}

export function normalizeResearchSourceUrl(value: unknown): string {
  const raw = requiredString(value, 2_048, "source URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("source URL is invalid");
  }

  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password
  ) {
    throw new Error("source URL must be a public HTTP(S) URL");
  }
  url.hash = "";
  return url.toString();
}

interface OfficialManagementSource {
  officialSourceType: ContactResearchCandidateInput["officialSourceType"];
  officialSourceUrl: string | null;
  officialManagementLabel:
    | ContactResearchCandidateInput["officialManagementLabel"];
  officialSourceEvidence: string | null;
}

function officialSourceHostAllowed(
  type: NonNullable<ContactResearchCandidateInput["officialSourceType"]>,
  url: string
): boolean {
  if (type === "website") return true;
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  if (type === "instagram") {
    return host === "instagram.com" || host.endsWith(".instagram.com");
  }
  if (type === "facebook") {
    return host === "facebook.com" || host.endsWith(".facebook.com");
  }
  return host === "soundcloud.com" || host.endsWith(".soundcloud.com");
}

function containsExactMailboxToken(
  value: string,
  candidateEmail: string
): boolean {
  const normalizedValue = value.toLowerCase();
  const normalizedCandidateEmail = candidateEmail.toLowerCase();
  let matchIndex = normalizedValue.indexOf(normalizedCandidateEmail);

  while (matchIndex !== -1) {
    const precedingCharacter = Array.from(
      normalizedValue.slice(0, matchIndex)
    ).at(-1);
    const suffix = normalizedValue.slice(
      matchIndex + normalizedCandidateEmail.length
    );
    const followingCharacters = Array.from(suffix);
    const followingCharacter = followingCharacters[0];
    const continuesDomain =
      followingCharacter === "." &&
      followingCharacters[1] !== undefined &&
      MAILBOX_DOMAIN_LABEL_CHARACTER.test(followingCharacters[1]);

    if (
      (!precedingCharacter ||
        !MAILBOX_PREFIX_CHARACTER.test(precedingCharacter)) &&
      (!followingCharacter ||
        (!MAILBOX_SUFFIX_CHARACTER.test(followingCharacter) &&
          !continuesDomain))
    ) {
      return true;
    }

    matchIndex = normalizedValue.indexOf(
      normalizedCandidateEmail,
      matchIndex + normalizedCandidateEmail.length
    );
  }

  return false;
}

export function normalizeOfficialManagementSource(
  value: unknown,
  candidateEmail: string,
  sourceUrls: readonly string[]
): OfficialManagementSource {
  if (value == null) {
    return {
      officialSourceType: null,
      officialSourceUrl: null,
      officialManagementLabel: null,
      officialSourceEvidence: null,
    };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("officialSource must be an object");
  }
  const source = value as Record<string, unknown>;
  const type = requiredString(
    source.type,
    30,
    "official source type"
  ).toLowerCase();
  if (!OFFICIAL_SOURCE_TYPES.has(type)) {
    throw new Error("official source type is invalid");
  }
  const url = normalizeResearchSourceUrl(source.url);
  if (!sourceUrls.includes(url)) {
    throw new Error(
      "official source URL must be included in sourceUrls"
    );
  }
  if (
    !officialSourceHostAllowed(
      type as NonNullable<
        ContactResearchCandidateInput["officialSourceType"]
      >,
      url
    )
  ) {
    throw new Error("official source URL does not match its source type");
  }
  const label = requiredString(
    source.managementLabel,
    20,
    "official management label"
  ).toLowerCase();
  if (!OFFICIAL_MANAGEMENT_LABELS.has(label)) {
    throw new Error(
      "official management label must be MGMT or management"
    );
  }
  const evidence = requiredString(
    source.evidence,
    4_000,
    "official source evidence"
  );
  if (!containsExactMailboxToken(evidence, candidateEmail)) {
    throw new Error(
      "official source evidence must contain the exact candidate email"
    );
  }
  return {
    officialSourceType:
      type as NonNullable<
        ContactResearchCandidateInput["officialSourceType"]
      >,
    officialSourceUrl: url,
    officialManagementLabel:
      label as NonNullable<
        ContactResearchCandidateInput["officialManagementLabel"]
      >,
    officialSourceEvidence: evidence,
  };
}

export function isOfficialManagementAutoApprovalEligible(
  candidate: ContactResearchCandidateInput
): boolean {
  return (
    candidate.needsApproval === false &&
    candidate.officialSourceType !== null &&
    candidate.officialSourceUrl !== null &&
    candidate.officialManagementLabel !== null &&
    candidate.officialSourceEvidence !== null
  );
}

export function normalizeContactResearchUserNotes(
  value: unknown
): string | null {
  return optionalString(value, 4_000, "research notes");
}

export function normalizeContactResearchDomain(value: unknown): string {
  const raw = requiredString(value, 320, "company domain").toLowerCase();
  let domain = raw;
  if (raw.includes("@")) domain = raw.slice(raw.lastIndexOf("@") + 1);
  if (raw.includes("://")) {
    try {
      domain = new URL(raw).hostname.toLowerCase();
    } catch {
      throw new Error("company domain is invalid");
    }
  }
  domain = domain.replace(/^www\./, "").replace(/\.$/, "");
  if (
    domain.length > 253 ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
      domain
    )
  ) {
    throw new Error("company domain is invalid");
  }
  return domain;
}

function normalizedLookupWords(value: string | null): string[] {
  return (value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 2);
}

function compactLookupValue(value: string | null): string {
  return normalizedLookupWords(value).join("");
}

export interface KnownContactLookupInput {
  managerName: string | null;
  company: string | null;
  domain: string | null;
}

export function parseKnownContactLookup(
  value: unknown
): KnownContactLookupInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("known contact lookup must be an object");
  }
  const input = value as Record<string, unknown>;
  const managerName = optionalString(
    input.managerName,
    200,
    "manager name"
  );
  const company = optionalString(input.company, 200, "company");
  const domain =
    input.domain == null || input.domain === ""
      ? null
      : normalizeContactResearchDomain(input.domain);
  if (!managerName && !domain) {
    throw new Error("manager name or company domain is required");
  }
  if (managerName && managerName.length < 2) {
    throw new Error("manager name must be at least 2 characters");
  }
  if (company && company.length < 3) {
    throw new Error("company must be at least 3 characters");
  }
  return { managerName, company, domain };
}

export interface KnownContactLookupRow {
  email: string;
  name: string | null;
  evidence: string | null;
  source: "active_contact" | "research_candidate";
  status: "active" | "pending" | "approved";
  artists: string[];
  sourceUrls: string[];
}

function knownContactMatchScore(
  row: KnownContactLookupRow,
  input: KnownContactLookupInput
): { score: number; reasons: string[] } {
  const email = row.email.toLowerCase();
  const [localPart, emailDomain = ""] = email.split("@");
  const managerWords = normalizedLookupWords(input.managerName);
  const managerCompact = managerWords.join("");
  const firstName = managerWords[0] ?? "";
  const lastName = managerWords.at(-1) ?? "";
  const localCompact = compactLookupValue(localPart);
  const searchable = [
    row.name,
    row.evidence,
    row.artists.join(" "),
  ]
    .filter(Boolean)
    .join(" ");
  const searchableCompact = compactLookupValue(searchable);
  const companyCompact = compactLookupValue(input.company);
  const genericLocalParts = new Set([
    "admin",
    "artists",
    "contact",
    "hello",
    "info",
    "management",
    "manager",
    "mgmt",
    "office",
    "team",
  ]);
  const reasons: string[] = [];
  let score = 0;

  if (input.domain && emailDomain === input.domain) {
    score += 20;
    reasons.push("same company domain");
  }
  if (managerCompact && searchableCompact.includes(managerCompact)) {
    score += 100;
    reasons.push("manager name appears in stored contact evidence");
  }
  if (firstName && localCompact === firstName) {
    score += 90;
    reasons.push("email local-part matches manager first name");
  }
  if (lastName && localCompact === lastName) {
    score += 80;
    reasons.push("email local-part matches manager last name");
  }
  if (
    firstName &&
    lastName &&
    (localCompact === `${firstName}${lastName}` ||
      localCompact === `${firstName[0]}${lastName}`)
  ) {
    score += 110;
    reasons.push("email local-part matches manager name pattern");
  }
  if (companyCompact && searchableCompact.includes(companyCompact)) {
    score += 35;
    reasons.push("company appears in stored contact evidence");
  }
  if (row.source === "active_contact") {
    score += 15;
    reasons.push("already present in active contact list");
  } else if (row.status === "approved") {
    score += 10;
    reasons.push("previously approved research candidate");
  } else {
    reasons.push("non-rejected prior research candidate");
  }
  if (genericLocalParts.has(localCompact)) {
    score -= 35;
    reasons.push("generic inbox");
  }

  return { score, reasons };
}

export function rankKnownContactEmails(
  rows: KnownContactLookupRow[],
  input: KnownContactLookupInput
) {
  const byEmail = new Map<
    string,
    KnownContactLookupRow & {
      score: number;
      matchReasons: string[];
      sources: KnownContactLookupRow["source"][];
    }
  >();
  for (const row of rows) {
    const match = knownContactMatchScore(row, input);
    const existing = byEmail.get(row.email);
    if (existing) {
      existing.score = Math.max(existing.score, match.score);
      existing.matchReasons = Array.from(
        new Set([...existing.matchReasons, ...match.reasons])
      );
      existing.sources = Array.from(
        new Set([...existing.sources, row.source])
      );
      existing.artists = Array.from(
        new Set([...existing.artists, ...row.artists])
      );
      existing.sourceUrls = Array.from(
        new Set([...existing.sourceUrls, ...row.sourceUrls])
      );
      if (!existing.name && row.name) existing.name = row.name;
      if (!existing.evidence && row.evidence) {
        existing.evidence = row.evidence;
      }
      continue;
    }
    byEmail.set(row.email, {
      ...row,
      score: match.score,
      matchReasons: match.reasons,
      sources: [row.source],
    });
  }
  return [...byEmail.values()].sort(
    (left, right) => right.score - left.score
  );
}

export async function findKnownContactEmails(value: unknown) {
  const { managerName, company, domain } =
    parseKnownContactLookup(value);

  const managerWords = normalizedLookupWords(managerName);
  const firstName = managerWords[0] ?? null;
  const lastName = managerWords.at(-1) ?? null;
  const emailLocalCandidates = Array.from(
    new Set(
      [
        firstName,
        lastName,
        firstName && lastName ? `${firstName}.${lastName}` : null,
        firstName && lastName ? `${firstName}${lastName}` : null,
        firstName && lastName ? `${firstName[0]}${lastName}` : null,
      ].filter((candidate): candidate is string => Boolean(candidate))
    )
  );
  const contactFilters: Prisma.ContactWhereInput[] = [];
  if (domain) {
    contactFilters.push({
      email: {
        endsWith: `@${domain}`,
        mode: "insensitive",
      },
    });
  }
  for (const localPart of emailLocalCandidates) {
    contactFilters.push({
      email: {
        startsWith: `${localPart}@`,
        mode: "insensitive",
      },
    });
  }
  if (managerName) {
    contactFilters.push({
      name: { contains: managerName, mode: "insensitive" },
    });
  }
  if (company) {
    contactFilters.push(
      { name: { contains: company, mode: "insensitive" } },
      { notes: { contains: company, mode: "insensitive" } }
    );
  }
  const candidateFilters: Prisma.ContactResearchCandidateWhereInput[] =
    [];
  if (domain) {
    candidateFilters.push({
      email: {
        endsWith: `@${domain}`,
        mode: "insensitive",
      },
    });
  }
  for (const localPart of emailLocalCandidates) {
    candidateFilters.push({
      email: {
        startsWith: `${localPart}@`,
        mode: "insensitive",
      },
    });
  }
  if (managerName) {
    candidateFilters.push(
      { name: { contains: managerName, mode: "insensitive" } },
      {
        evidence: {
          contains: managerName,
          mode: "insensitive",
        },
      }
    );
  }
  if (company) {
    candidateFilters.push(
      { name: { contains: company, mode: "insensitive" } },
      {
        evidence: {
          contains: company,
          mode: "insensitive",
        },
      }
    );
  }

  const [contacts, candidates] = await Promise.all([
    db.contact.findMany({
      where: {
        state: "active",
        email: { not: null },
        ...(contactFilters.length > 0
          ? { OR: contactFilters }
          : {}),
      },
      distinct: ["email"],
      orderBy: [{ updatedAt: "desc" }],
      take: 100,
      select: {
        email: true,
        name: true,
        notes: true,
        artist: { select: { name: true } },
      },
    }),
    db.contactResearchCandidate.findMany({
      where: {
        status: { in: ["pending", "approved"] },
        OR: candidateFilters,
      },
      distinct: ["normalizedEmail"],
      orderBy: [{ updatedAt: "desc" }],
      take: 100,
      select: {
        email: true,
        name: true,
        evidence: true,
        status: true,
        sourceUrls: true,
        job: { select: { artist: { select: { name: true } } } },
      },
    }),
  ]);

  const rows: KnownContactLookupRow[] = [
    ...contacts.flatMap((contact) =>
      contact.email
        ? [
            {
              email: contact.email.trim().toLowerCase(),
              name: contact.name,
              evidence: contact.notes,
              source: "active_contact" as const,
              status: "active" as const,
              artists: [contact.artist.name],
              sourceUrls: [],
            },
          ]
        : []
    ),
    ...candidates.map((candidate) => ({
      email: candidate.email.trim().toLowerCase(),
      name: candidate.name,
      evidence: candidate.evidence,
      source: "research_candidate" as const,
      status: candidate.status as "pending" | "approved",
      artists: [candidate.job.artist.name],
      sourceUrls: candidate.sourceUrls,
    })),
  ];
  return {
    query: { managerName, company, domain },
    matches: rankKnownContactEmails(rows, {
      managerName,
      company,
      domain,
    }).slice(0, 25),
  };
}

export function parseContactResearchClaimLimit(value: unknown): number {
  if (value == null) return CONTACT_RESEARCH_DEFAULT_CLAIM_LIMIT;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > CONTACT_RESEARCH_MAX_CLAIM_LIMIT
  ) {
    throw new Error(
      `limit must be an integer from 1 to ${CONTACT_RESEARCH_MAX_CLAIM_LIMIT}`
    );
  }
  return value;
}

export function parseContactResearchSubmission(
  value: unknown
): ContactResearchSubmission {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("request body must be an object");
  }
  const input = value as Record<string, unknown>;
  const outcome = input.outcome;
  if (outcome !== "candidates" && outcome !== "exhausted") {
    throw new Error("outcome must be candidates or exhausted");
  }
  const claimToken = requiredString(input.claimToken, 200, "claimToken");
  const notes = optionalString(input.notes, 4_000, "notes");
  if (outcome === "exhausted") {
    return { outcome, claimToken, notes, candidates: [] };
  }
  if (!Array.isArray(input.candidates) || input.candidates.length === 0) {
    throw new Error("at least one candidate is required");
  }
  if (input.candidates.length > 10) {
    throw new Error("at most 10 candidates may be submitted");
  }

  const candidatesByEmail = new Map<string, ContactResearchCandidateInput>();
  for (const candidateValue of input.candidates) {
    if (
      typeof candidateValue !== "object" ||
      candidateValue === null ||
      Array.isArray(candidateValue)
    ) {
      throw new Error("each candidate must be an object");
    }
    const candidate = candidateValue as Record<string, unknown>;
    const normalizedEmail = normalizeResearchEmail(candidate.email);
    const sourceValues = candidate.sourceUrls;
    if (!Array.isArray(sourceValues) || sourceValues.length === 0) {
      throw new Error("each candidate needs at least one source URL");
    }
    if (sourceValues.length > 5) {
      throw new Error("each candidate may have at most 5 source URLs");
    }
    const sourceUrls = Array.from(
      new Set(sourceValues.map(normalizeResearchSourceUrl))
    );
    const confidence = requiredString(
      candidate.confidence,
      20,
      "confidence"
    );
    if (!CONFIDENCE_VALUES.has(confidence)) {
      throw new Error("confidence must be high, medium, or low");
    }
    const officialSource = normalizeOfficialManagementSource(
      candidate.officialSource,
      normalizedEmail,
      sourceUrls
    );
    if (
      candidate.needsApproval !== undefined &&
      typeof candidate.needsApproval !== "boolean"
    ) {
      throw new Error("needsApproval must be a boolean");
    }
    const needsApproval = candidate.needsApproval ?? true;
    if (
      needsApproval === false &&
      officialSource.officialSourceType === null
    ) {
      throw new Error(
        "needsApproval may be false only for a directly published MGMT/management email"
      );
    }
    candidatesByEmail.set(normalizedEmail, {
      email: normalizedEmail,
      normalizedEmail,
      name: optionalString(candidate.name, 200, "name"),
      role: normalizeManagerRole(candidate.role),
      sourceUrls,
      evidence: requiredString(candidate.evidence, 4_000, "evidence"),
      confidence: confidence as ContactResearchCandidateInput["confidence"],
      needsApproval,
      ...officialSource,
    });
  }

  return {
    outcome,
    claimToken,
    notes,
    candidates: [...candidatesByEmail.values()],
  };
}

export async function isValidContactResearchAuthorization(
  authorization: string | null,
  secrets:
    | string
    | readonly (string | undefined)[]
    = [
      process.env.CONTACT_RESEARCH_AGENT_TOKEN,
      process.env.CRON_SECRET,
    ],
  verifyGithubActionsToken: (
    token: string
  ) => Promise<boolean> = verifyGithubActionsContactResearchToken
): Promise<boolean> {
  if (!authorization?.startsWith("Bearer ")) return false;
  const token = authorization.slice("Bearer ".length);
  if (!token) return false;
  const candidates = (Array.isArray(secrets) ? secrets : [secrets]).filter(
    (secret): secret is string => Boolean(secret)
  );
  const matches = await Promise.all(
    candidates.map((secret) => constantTimeEqual(token, secret))
  );
  return matches.some(Boolean) || verifyGithubActionsToken(token);
}

export function isTrustedContactResearchOidcClaims(
  payload: JWTPayload
): boolean {
  return (
    payload.repository === "zspherez/photo-admin" &&
    payload.repository_owner === "zspherez" &&
    payload.ref === "refs/heads/main" &&
    payload.workflow_ref === CONTACT_RESEARCH_WORKFLOW_REF &&
    (payload.event_name === "schedule" ||
      payload.event_name === "workflow_dispatch")
  );
}

export async function verifyGithubActionsContactResearchToken(
  token: string
): Promise<boolean> {
  if (token.split(".").length !== 3) return false;
  try {
    const { payload } = await jwtVerify(token, githubActionsJwks, {
      issuer: CONTACT_RESEARCH_OIDC_ISSUER,
      audience: CONTACT_RESEARCH_OIDC_AUDIENCE,
    });
    return isTrustedContactResearchOidcClaims(payload);
  } catch {
    return false;
  }
}

export function contactResearchPriority(
  input: ContactResearchPriorityInput
): number {
  const popularity = Math.max(0, Math.min(100, input.popularity ?? 0));
  const proximity = Math.max(
    0,
    CONTACT_RESEARCH_WINDOW_DAYS - Math.max(0, input.daysUntilShow)
  );
  return (
    (input.interested ? 1_000 : 0) +
    (input.hasActiveSignal ? 200 : 0) +
    popularity +
    proximity
  );
}

export async function refreshContactResearchQueue(
  now: Date = new Date()
): Promise<ContactResearchQueueResult> {
  const today = easternTodayStoredDate(now);
  const end = parseDateOnly(
    addDateOnlyDays(easternDateOnly(now), CONTACT_RESEARCH_WINDOW_DAYS)
  );
  const activeSignalWhere = activeListenSignalWhere(now);
  const rows = await db.showArtist.findMany({
    where: {
      show: {
        date: { gte: today, lte: end },
        isFestival: false,
        syncStatus: "active",
      },
      artist: {
        contacts: {
          none: ACTIVE_EMAIL_CONTACT_WHERE,
        },
      },
    },
    select: {
      artistId: true,
      show: {
        select: {
          date: true,
          interestedAt: true,
        },
      },
      artist: {
        select: {
          popularity: true,
          listenSignals: {
            where: activeSignalWhere,
            take: 1,
            select: { id: true },
          },
        },
      },
    },
  });
  const requestedRows = await db.contactResearchJob.findMany({
    where: {
      requestedShow: {
        date: { gte: today },
        syncStatus: "active",
      },
      artist: {
        contacts: { none: ACTIVE_EMAIL_CONTACT_WHERE },
      },
    },
    select: {
      artistId: true,
      priority: true,
      nextShowAt: true,
      requestedShow: {
        select: {
          date: true,
          artists: { select: { artistId: true } },
        },
      },
    },
  });

  const eligible = new Map<
    string,
    { priority: number; nextShowAt: Date }
  >();
  for (const row of rows) {
    const daysUntilShow = Math.max(
      0,
      Math.round((row.show.date.getTime() - today.getTime()) / 86_400_000)
    );
    const priority = contactResearchPriority({
      interested: row.show.interestedAt !== null,
      hasActiveSignal: row.artist.listenSignals.length > 0,
      popularity: row.artist.popularity,
      daysUntilShow,
    });
    const current = eligible.get(row.artistId);
    if (
      !current ||
      priority > current.priority ||
      row.show.date < current.nextShowAt
    ) {
      eligible.set(row.artistId, {
        priority: Math.max(priority, current?.priority ?? 0),
        nextShowAt:
          !current || row.show.date < current.nextShowAt
            ? row.show.date
            : current.nextShowAt,
      });
    }
  }
  for (const row of requestedRows) {
    if (!row.requestedShow) continue;
    if (
      !row.requestedShow.artists.some(
        (showArtist) => showArtist.artistId === row.artistId
      )
    ) {
      continue;
    }
    const current = eligible.get(row.artistId);
    eligible.set(row.artistId, {
      priority: Math.max(2_000, row.priority, current?.priority ?? 0),
      nextShowAt:
        current && current.nextShowAt < row.requestedShow.date
          ? current.nextShowAt
          : row.requestedShow.date,
    });
  }

  const artistIds = [...eligible.keys()];
  return withSerializableRetry(async (tx) => {
    const completed = await tx.contactResearchJob.updateMany({
      where: {
        status: { in: ["pending", "claimed", "review", "exhausted"] },
        artist: {
          contacts: {
            some: ACTIVE_EMAIL_CONTACT_WHERE,
          },
        },
      },
      data: {
        status: "complete",
        completedAt: now,
        claimToken: null,
        claimedAt: null,
        claimExpiresAt: null,
      },
    });
    const ineligibleWhere: Prisma.ContactResearchJobWhereInput = {
      status: { in: ["pending", "claimed", "review"] },
      artist: {
        contacts: {
          none: ACTIVE_EMAIL_CONTACT_WHERE,
        },
      },
      ...(artistIds.length > 0
        ? { artistId: { notIn: artistIds } }
        : {}),
    };
    const inactivated = await tx.contactResearchJob.updateMany({
      where: ineligibleWhere,
      data: {
        status: "inactive",
        claimToken: null,
        claimedAt: null,
        claimExpiresAt: null,
      },
    });
    if (artistIds.length === 0) {
      return {
        eligible: 0,
        enqueued: 0,
        reprioritized: 0,
        completed: completed.count,
        inactivated: inactivated.count,
      };
    }

    const existing = await tx.contactResearchJob.findMany({
      where: { artistId: { in: artistIds } },
      select: { artistId: true, status: true },
    });
    const existingByArtist = new Map(
      existing.map((job) => [job.artistId, job])
    );
    let created = 0;
    let reopened = 0;
    let reprioritized = 0;
    for (const artistId of artistIds) {
      const job = existingByArtist.get(artistId);
      if (!job) {
        created += 1;
        continue;
      }
      if (job.status === "complete" || job.status === "inactive") {
        reopened += 1;
        continue;
      }
      if (!["pending", "claimed", "review"].includes(job.status)) continue;
      reprioritized += 1;
    }

    const values = artistIds.map((artistId) => {
      const candidate = eligible.get(artistId)!;
      return Prisma.sql`(
        ${randomUUID()},
        ${artistId},
        'pending',
        ${candidate.priority},
        ${candidate.nextShowAt},
        ${now},
        ${now}
      )`;
    });
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "ContactResearchJob" AS job (
        "id",
        "artistId",
        "status",
        "priority",
        "nextShowAt",
        "createdAt",
        "updatedAt"
      )
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("artistId") DO UPDATE SET
        "status" = CASE
          WHEN job."status" IN ('complete', 'inactive') THEN 'pending'
          ELSE job."status"
        END,
        "priority" = EXCLUDED."priority",
        "nextShowAt" = EXCLUDED."nextShowAt",
        "completedAt" = CASE
          WHEN job."status" IN ('complete', 'inactive') THEN NULL
          ELSE job."completedAt"
        END,
        "updatedAt" = EXCLUDED."updatedAt"
    `);

    return {
      eligible: artistIds.length,
      enqueued: created + reopened,
      reprioritized,
      completed: completed.count,
      inactivated: inactivated.count,
    };
  }, { timeout: 30_000 });
}

export async function enqueueFestivalManagerResearch(
  showId: string,
  now: Date = new Date()
): Promise<{
  eligible: number;
  enqueued: number;
  alreadyQueued: number;
}> {
  const today = easternTodayStoredDate(now);
  const festival = await db.show.findFirst({
    where: {
      id: showId,
      isFestival: true,
      syncStatus: "active",
      date: { gte: today },
    },
    select: {
      id: true,
      date: true,
      artists: {
        select: {
          artistId: true,
          artist: {
            select: {
              popularity: true,
              contacts: {
                where: ACTIVE_EMAIL_CONTACT_WHERE,
                select: {
                  email: true,
                  role: true,
                  state: true,
                },
              },
              listenSignals: {
                where: activeListenSignalWhere(now),
                take: 1,
                select: { id: true },
              },
            },
          },
        },
      },
    },
  });
  if (!festival) throw new Error("Festival is inactive or unavailable");

  return withSerializableRetry(async (tx) => {
    const eligibleArtists = festival.artists.filter((row) =>
      needsManagerContactResearch(row.artist.contacts)
    );
    const artistIds = eligibleArtists.map((row) => row.artistId);
    const existing =
      artistIds.length === 0
        ? []
        : await tx.contactResearchJob.findMany({
            where: { artistId: { in: artistIds } },
            select: { artistId: true, status: true },
          });
    const existingByArtist = new Map(
      existing.map((job) => [job.artistId, job.status])
    );
    let enqueued = 0;
    let alreadyQueued = 0;

    for (const row of eligibleArtists) {
      const priority =
        2_000 +
        contactResearchPriority({
          interested: true,
          hasActiveSignal: row.artist.listenSignals.length > 0,
          popularity: row.artist.popularity,
          daysUntilShow: Math.max(
            0,
            Math.round(
              (festival.date.getTime() - today.getTime()) / 86_400_000
            )
          ),
        });
      const status = existingByArtist.get(row.artistId);
      const disposition = festivalManagerResearchJobDisposition(status ?? null);
      if (disposition === "create") {
        await tx.contactResearchJob.create({
          data: {
            artistId: row.artistId,
            requestedShowId: festival.id,
            priority,
            nextShowAt: festival.date,
          },
        });
        enqueued += 1;
        continue;
      }
      if (disposition === "requeue") {
        await tx.contactResearchJob.update({
          where: { artistId: row.artistId },
          data: {
            requestedShowId: festival.id,
            status: "pending",
            priority,
            nextShowAt: festival.date,
            claimToken: null,
            claimedAt: null,
            claimExpiresAt: null,
            agentNotes: null,
            completedAt: null,
          },
        });
        enqueued += 1;
        continue;
      }
      await tx.contactResearchJob.update({
        where: { artistId: row.artistId },
        data: {
          requestedShowId: festival.id,
          priority,
          nextShowAt: festival.date,
        },
      });
      alreadyQueued += 1;
    }

    return {
      eligible: eligibleArtists.length,
      enqueued,
      alreadyQueued,
    };
  });
}

export async function prepareContactResearchQueue(
  now: Date = new Date()
): Promise<ContactResearchPreparationResult> {
  const refreshed = await refreshContactResearchQueue(now);
  const claimable = await db.contactResearchJob.count({
    where: {
      OR: [
        { status: "pending" },
        {
          status: "claimed",
          OR: [
            { claimExpiresAt: null },
            { claimExpiresAt: { lte: now } },
          ],
        },
      ],
    },
  });
  return { ...refreshed, claimable };
}

function parseGenres(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((genre): genre is string => typeof genre === "string")
      : [];
  } catch {
    return [];
  }
}

export async function claimContactResearchJobs(
  limit: number,
  now: Date = new Date()
) {
  const claimLimit = parseContactResearchClaimLimit(limit);
  const claimExpiresAt = new Date(now.getTime() + CONTACT_RESEARCH_CLAIM_TTL_MS);
  const today = easternTodayStoredDate(now);
  const end = parseDateOnly(
    addDateOnlyDays(easternDateOnly(now), CONTACT_RESEARCH_WINDOW_DAYS)
  );
  return db.$transaction(
    async (tx) => {
      const globalAgentRules =
        await readGlobalAgentRulesInTransaction(tx);
      const selected = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT job."id"
        FROM "ContactResearchJob" job
        WHERE (
          job."status" = 'pending'
          OR (
            job."status" = 'claimed'
            AND (
              job."claimExpiresAt" IS NULL
              OR job."claimExpiresAt" <= ${now}
            )
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "Contact" contact
          WHERE contact."artistId" = job."artistId"
            AND contact."state" = 'active'
            AND contact."email" IS NOT NULL
        )
        AND EXISTS (
          SELECT 1
          FROM "ShowArtist" show_artist
          JOIN "Show" show
            ON show."id" = show_artist."showId"
          WHERE show_artist."artistId" = job."artistId"
            AND show."date" >= ${today}
            AND show."syncStatus" = 'active'
            AND (
              (
                show."isFestival" = false
                AND show."date" <= ${end}
              )
              OR (
                job."requestedShowId" = show."id"
              )
            )
        )
        ORDER BY
          job."priority" DESC,
          job."nextShowAt" ASC NULLS LAST,
          job."createdAt" ASC
        LIMIT ${claimLimit}
        FOR UPDATE SKIP LOCKED
      `);
      const tokenById = new Map<string, string>();
      for (const row of selected) {
        const claimToken = randomUUID();
        tokenById.set(row.id, claimToken);
        await tx.contactResearchJob.update({
          where: { id: row.id },
          data: {
            status: "claimed",
            claimToken,
            claimedAt: now,
            claimExpiresAt,
            attemptCount: { increment: 1 },
            claimedAgentRules: globalAgentRules.instructions,
            claimedAgentRulesVersion: globalAgentRules.version,
          },
        });
      }
      if (selected.length === 0) return [];

      const jobs = await tx.contactResearchJob.findMany({
        where: { id: { in: selected.map((row) => row.id) } },
        include: {
          artist: {
            select: {
              id: true,
              name: true,
              spotifyId: true,
              edmtrainId: true,
              genres: true,
              popularity: true,
              contacts: {
                where: { state: "active" },
                select: {
                  email: true,
                  phone: true,
                  name: true,
                  role: true,
                },
              },
              shows: {
                where: {
                  show: {
                    date: { gte: easternTodayStoredDate(now) },
                    syncStatus: "active",
                  },
                },
                select: {
                  show: {
                    select: {
                      id: true,
                      date: true,
                      venueName: true,
                      city: true,
                      state: true,
                      ticketUrl: true,
                      interestedAt: true,
                      isFestival: true,
                    },
                  },
                },
              },
            },
          },
        },
      });
      const jobById = new Map(jobs.map((job) => [job.id, job]));
      return selected.flatMap((selectedJob) => {
        const job = jobById.get(selectedJob.id);
        if (!job) return [];
        const upcomingShows = job.artist.shows
          .map((row) => row.show)
          .sort((a, b) => a.date.getTime() - b.date.getTime())
          .slice(0, 8);
        return [
          {
            id: job.id,
            claimToken: tokenById.get(job.id)!,
            claimExpiresAt,
            attemptCount: job.attemptCount,
            priority: job.priority,
            globalAgentRules: {
              scope: globalAgentRules.scope,
              version: job.claimedAgentRulesVersion ?? 0,
              instructions: job.claimedAgentRules ?? "",
            },
            researchInstructions: job.userNotes,
            artist: {
              id: job.artist.id,
              name: job.artist.name,
              spotifyId: job.artist.spotifyId,
              edmtrainId: job.artist.edmtrainId,
              genres: parseGenres(job.artist.genres),
              popularity: job.artist.popularity,
              existingContacts: job.artist.contacts,
              upcomingShows,
            },
          },
        ];
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
  );
}

export async function submitContactResearchResult(
  jobId: string,
  submission: ContactResearchSubmission,
  now: Date = new Date()
): Promise<{
  accepted: boolean;
  status: "review" | "exhausted" | "complete" | "conflict";
  autoApproved: number;
  sheetErrors: string[];
}> {
  const stored = await withSerializableRetry(async (tx) => {
    const job = await tx.contactResearchJob.findFirst({
      where: {
        id: jobId,
        status: "claimed",
        claimToken: submission.claimToken,
        claimExpiresAt: { gt: now },
      },
      select: {
        id: true,
        artistId: true,
        artist: { select: { name: true } },
      },
    });
    if (!job) {
      return {
        accepted: false,
        status: "conflict" as const,
        autoApprovals: [] as ApprovedResearchContact[],
      };
    }

    if (submission.outcome === "exhausted") {
      await tx.contactResearchJob.update({
        where: { id: jobId },
        data: {
          status: "exhausted",
          agentNotes: submission.notes,
          claimToken: null,
          claimedAt: null,
          claimExpiresAt: null,
        },
      });
      return {
        accepted: true,
        status: "exhausted" as const,
        autoApprovals: [] as ApprovedResearchContact[],
      };
    }

    const autoApproveCandidates: Array<{
      id: string;
      input: ContactResearchCandidateInput;
      stored: {
        sourceUrls: string[];
      };
    }> = [];
    for (const candidate of submission.candidates) {
      const storedCandidate = await tx.contactResearchCandidate.upsert({
        where: {
          jobId_normalizedEmail: {
            jobId,
            normalizedEmail: candidate.normalizedEmail,
          },
        },
        create: {
          jobId,
          ...candidate,
        },
        update: {
          email: candidate.email,
          name: candidate.name,
          role: "management",
          sourceUrls: candidate.sourceUrls,
          evidence: candidate.evidence,
          confidence: candidate.confidence,
          needsApproval: candidate.needsApproval,
          officialSourceType: candidate.officialSourceType,
          officialSourceUrl: candidate.officialSourceUrl,
          officialManagementLabel: candidate.officialManagementLabel,
          officialSourceEvidence: candidate.officialSourceEvidence,
          status: "pending",
          reviewedAt: null,
        },
      });
      if (isOfficialManagementAutoApprovalEligible(candidate)) {
        autoApproveCandidates.push({
          id: storedCandidate.id,
          input: candidate,
          stored: storedCandidate,
        });
      }
    }
    if (autoApproveCandidates.length > 0) {
      const approvals: ApprovedResearchContact[] = [];
      for (const candidate of autoApproveCandidates) {
        const existing = await tx.contact.findUnique({
          where: {
            artistId_email: {
              artistId: job.artistId,
              email: candidate.input.normalizedEmail,
            },
          },
        });
        const contact = existing
          ? await tx.contact.update({
              where: { id: existing.id },
              data: {
                state: "active",
                name: existing.name ?? candidate.input.name,
                role: "management",
              },
            })
          : await tx.contact.create({
              data: {
                artistId: job.artistId,
                email: candidate.input.normalizedEmail,
                name: candidate.input.name,
                role: "management",
                source: "research",
                state: "active",
              },
            });
        approvals.push({
          contact,
          artistName: job.artist.name,
          candidate: candidate.stored,
          shouldAppendToSheet: !existing,
        });
      }
      const approvedIds = autoApproveCandidates.map(
        (candidate) => candidate.id
      );
      await Promise.all([
        tx.contactResearchCandidate.updateMany({
          where: { id: { in: approvedIds } },
          data: { status: "approved", reviewedAt: now },
        }),
        tx.contactResearchCandidate.updateMany({
          where: {
            jobId,
            id: { notIn: approvedIds },
            status: "pending",
          },
          data: { status: "rejected", reviewedAt: now },
        }),
        tx.contactResearchJob.update({
          where: { id: jobId },
          data: {
            status: "complete",
            agentNotes: submission.notes,
            completedAt: now,
            claimToken: null,
            claimedAt: null,
            claimExpiresAt: null,
          },
        }),
      ]);
      return {
        accepted: true,
        status: "complete" as const,
        autoApprovals: approvals,
      };
    }
    await tx.contactResearchJob.update({
      where: { id: jobId },
      data: {
        status: "review",
        agentNotes: submission.notes,
        claimToken: null,
        claimedAt: null,
        claimExpiresAt: null,
      },
    });
    return {
      accepted: true,
      status: "review" as const,
      autoApprovals: [] as ApprovedResearchContact[],
    };
  });
  if (!stored.accepted) {
    return {
      accepted: false,
      status: stored.status,
      autoApproved: 0,
      sheetErrors: [],
    };
  }
  const sheetErrors = await appendApprovedResearchContactsToSheet(
    stored.autoApprovals,
    now
  );
  return {
    accepted: true,
    status:
      stored.autoApprovals.length > 0 ? "complete" : stored.status,
    autoApproved: stored.autoApprovals.length,
    sheetErrors,
  };
}

async function withSerializableRetry<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  options: { timeout?: number } = {}
): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await db.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: options.timeout ?? 5_000,
      });
    } catch (error) {
      const code =
        error instanceof Prisma.PrismaClientKnownRequestError
          ? error.code
          : null;
      if ((code === "P2002" || code === "P2034") && attempt < 3) continue;
      throw error;
    }
  }
  throw new Error("Unable to complete serializable transaction");
}

interface ApprovedResearchContact {
  contact: {
    id: string;
    email: string | null;
    name: string | null;
    role: string | null;
    customPrice: string | null;
  };
  candidate: {
    sourceUrls: string[];
  };
  artistName: string;
  shouldAppendToSheet: boolean;
}

async function appendApprovedResearchContactsToSheet(
  approvals: readonly ApprovedResearchContact[],
  now: Date
): Promise<string[]> {
  const sheetErrors: string[] = [];
  for (const approval of approvals) {
    if (!approval.shouldAppendToSheet) continue;
    try {
      const source = approval.candidate.sourceUrls.join(" ");
      const notes = `Research source: ${source}`.slice(0, 1_000);
      const appended = await appendContactToSheet({
        artistName: approval.artistName,
        email: approval.contact.email!,
        managerName: approval.contact.name,
        role: approval.contact.role,
        customPrice: approval.contact.customPrice,
        notes,
      });
      const updated = await db.contact.updateMany({
        where: {
          id: approval.contact.id,
          source: "research",
        },
        data: {
          source: "sheet",
          sourceKey: appended.sourceKey,
          sourceSyncedAt: now,
        },
      });
      if (updated.count === 1) continue;
      console.error(
        JSON.stringify({
          event: "contact_research_sheet_ownership_pending",
          contactId: approval.contact.id,
          sourceKey: appended.sourceKey,
        })
      );
      sheetErrors.push(
        `${approval.contact.email}: Sheet ownership needs reconciliation.`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        JSON.stringify({
          event: "contact_research_sheet_append_failed",
          contactId: approval.contact.id,
          error: message,
        })
      );
      sheetErrors.push(
        `${approval.contact.email}: ${message.slice(0, 160)}`
      );
    }
  }
  return sheetErrors;
}

export async function approveContactResearchCandidates(
  candidateIds: readonly string[],
  now: Date = new Date()
): Promise<{
  ok: boolean;
  approvedCount?: number;
  error?: string;
  sheetErrors?: string[];
}> {
  const uniqueCandidateIds = Array.from(new Set(candidateIds));
  if (uniqueCandidateIds.length === 0) {
    return { ok: false, error: "No candidates were selected" };
  }
  const approved = await withSerializableRetry(async (tx) => {
    const candidates = await tx.contactResearchCandidate.findMany({
      where: { id: { in: uniqueCandidateIds } },
      include: {
        job: {
          include: {
            artist: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (
      candidates.length !== uniqueCandidateIds.length ||
      candidates.some(
        (candidate) =>
          candidate.status !== "pending" ||
          candidate.job.status !== "review"
      )
    ) {
      return { ok: false as const, error: "Candidate is no longer reviewable" };
    }
    const jobIds = new Set(candidates.map((candidate) => candidate.jobId));
    if (jobIds.size !== 1) {
      return {
        ok: false as const,
        error: "Candidates must belong to the same research job",
      };
    }
    const candidateById = new Map(
      candidates.map((candidate) => [candidate.id, candidate])
    );
    const approvals: ApprovedResearchContact[] = [];
    for (const candidateId of uniqueCandidateIds) {
      const candidate = candidateById.get(candidateId)!;
      const existing = await tx.contact.findUnique({
        where: {
          artistId_email: {
            artistId: candidate.job.artistId,
            email: candidate.normalizedEmail,
          },
        },
      });
      const contact = existing
        ? await tx.contact.update({
            where: { id: existing.id },
            data: {
              state: "active",
              name: existing.name ?? candidate.name,
              role: "management",
            },
          })
        : await tx.contact.create({
          data: {
            artistId: candidate.job.artistId,
            email: candidate.normalizedEmail,
            name: candidate.name,
            role: "management",
            source: "research",
            state: "active",
          },
        });
      approvals.push({
        contact,
        artistName: candidate.job.artist.name,
        candidate,
        shouldAppendToSheet: !existing,
      });
    }

    await Promise.all([
      tx.contactResearchCandidate.updateMany({
        where: { id: { in: uniqueCandidateIds } },
        data: { status: "approved", reviewedAt: now },
      }),
      tx.contactResearchCandidate.updateMany({
        where: {
          jobId: candidates[0].jobId,
          id: { notIn: uniqueCandidateIds },
          status: "pending",
        },
        data: { status: "rejected", reviewedAt: now },
      }),
      tx.contactResearchJob.update({
        where: { id: candidates[0].jobId },
        data: {
          status: "complete",
          completedAt: now,
          claimToken: null,
          claimedAt: null,
          claimExpiresAt: null,
        },
      }),
    ]);

    return {
      ok: true as const,
      approvals,
    };
  });
  if (!approved.ok) return approved;

  const sheetErrors = await appendApprovedResearchContactsToSheet(
    approved.approvals,
    now
  );
  return {
    ok: true,
    approvedCount: approved.approvals.length,
    ...(sheetErrors.length > 0 ? { sheetErrors } : {}),
  };
}

export async function approveContactResearchCandidate(
  candidateId: string,
  now: Date = new Date()
): Promise<{ ok: boolean; error?: string; sheetError?: string }> {
  const result = await approveContactResearchCandidates(
    [candidateId],
    now
  );
  return {
    ok: result.ok,
    ...(result.error ? { error: result.error } : {}),
    ...(result.sheetErrors?.length
      ? { sheetError: result.sheetErrors.join(" ") }
      : {}),
  };
}

export async function rejectContactResearchCandidate(
  candidateId: string,
  now: Date = new Date()
): Promise<{ ok: boolean; exhausted: boolean }> {
  return withSerializableRetry(async (tx) => {
    const candidate = await tx.contactResearchCandidate.findFirst({
      where: {
        id: candidateId,
        status: "pending",
        job: { status: "review" },
      },
      select: { id: true, jobId: true },
    });
    if (!candidate) return { ok: false, exhausted: false };
    await tx.contactResearchCandidate.update({
      where: { id: candidate.id },
      data: { status: "rejected", reviewedAt: now },
    });
    const remaining = await tx.contactResearchCandidate.count({
      where: { jobId: candidate.jobId, status: "pending" },
    });
    if (remaining === 0) {
      await tx.contactResearchJob.update({
        where: { id: candidate.jobId },
        data: { status: "exhausted" },
      });
    }
    return { ok: true, exhausted: remaining === 0 };
  });
}

export async function updateContactResearchJobUserNotes(
  jobId: string,
  value: unknown
): Promise<boolean> {
  const userNotes = normalizeContactResearchUserNotes(value);
  return withSerializableRetry(async (tx) => {
    const job = await tx.contactResearchJob.findUnique({
      where: { id: jobId },
      select: { id: true, status: true },
    });
    if (!job) return false;
    await tx.contactResearchJob.update({
      where: { id: job.id },
      data: {
        userNotes,
        ...(job.status === "claimed"
          ? {
              status: "pending",
              claimToken: null,
              claimedAt: null,
              claimExpiresAt: null,
            }
          : {}),
      },
    });
    return true;
  });
}

export async function retryContactResearchJob(
  jobId: string,
  now: Date = new Date()
): Promise<boolean> {
  return (
    (await retryEligibleContactResearchJobs(
      Prisma.sql`job."id" = ${jobId}
        AND job."status" IN ('exhausted', 'review')`,
      now
    )) === 1
  );
}

async function retryContactResearchJobsByStatus(
  status: "exhausted" | "review",
  now: Date = new Date()
): Promise<number> {
  return retryEligibleContactResearchJobs(
    Prisma.sql`job."status" = ${status}`,
    now
  );
}

async function retryEligibleContactResearchJobs(
  statusWhere: Prisma.Sql,
  now: Date
): Promise<number> {
  const today = easternTodayStoredDate(now);
  const end = parseDateOnly(
    addDateOnlyDays(easternDateOnly(now), CONTACT_RESEARCH_WINDOW_DAYS)
  );
  return db.$executeRaw(Prisma.sql`
    UPDATE "ContactResearchJob" AS job
    SET
      "status" = 'pending',
      "updatedAt" = ${now}
    WHERE ${statusWhere}
      AND NOT EXISTS (
        SELECT 1
        FROM "Contact" contact
        WHERE contact."artistId" = job."artistId"
          AND contact."state" = 'active'
          AND contact."email" IS NOT NULL
      )
      AND EXISTS (
        SELECT 1
        FROM "ShowArtist" show_artist
        JOIN "Show" show
          ON show."id" = show_artist."showId"
        WHERE show_artist."artistId" = job."artistId"
          AND show."date" >= ${today}
          AND show."syncStatus" = 'active'
          AND (
            (
              show."isFestival" = false
              AND show."date" <= ${end}
            )
            OR job."requestedShowId" = show."id"
          )
      )
  `);
}

export function retryAllExhaustedContactResearchJobs(): Promise<number> {
  return retryContactResearchJobsByStatus("exhausted");
}

export function retryAllReviewContactResearchJobs(): Promise<number> {
  return retryContactResearchJobsByStatus("review");
}
