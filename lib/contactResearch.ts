import { createHash, randomUUID } from "node:crypto";
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
import {
  directOutreachInstructionsStorage,
  readGlobalAgentRulesInTransaction,
  readStoredDirectOutreachInstructions,
} from "@/lib/agentRules";
import {
  canonicalDirectOutreachInstructionExcerpt,
  DIRECT_OUTREACH_INSTRUCTION_EXCERPT_MAX_LENGTH,
} from "@/lib/directOutreachInstruction";
import {
  assertAgentSafeSourceUrl,
  assertNoPhoneLikeNumber,
} from "@/lib/phoneSafety";
import {
  festivalLeadTimeSql,
  festivalLeadTimeWhere,
} from "@/lib/festivalEligibility";
import {
  type AgentMutationEnvironment,
  isValidAgentMutationAuthorization,
} from "@/lib/agentMutationAuthorization";
import {
  assertPublicHttpsSourceUrl,
  validateResearchSubmissionPayload,
} from "@/lib/contactAgentPayloadValidation.mjs";
import {
  appConfig,
  buildWorkflowRef,
  CONTACT_RESEARCH_WORKFLOW_FILE,
  resolveContactResearchTrustConfig,
  type WorkflowTrustConfig,
} from "@/lib/appConfig";

export const CONTACT_RESEARCH_WINDOW_DAYS = 90;
export const CONTACT_RESEARCH_DEFAULT_CLAIM_LIMIT = 3;
export const CONTACT_RESEARCH_MAX_CLAIM_LIMIT = 10;
export const CONTACT_RESEARCH_CLAIM_TTL_MS = 60 * 60 * 1_000;
export const CONTACT_RESEARCH_OIDC_AUDIENCE =
  "photo-admin-contact-research";
export const CONTACT_RESEARCH_OIDC_ISSUER =
  "https://token.actions.githubusercontent.com";
/**
 * Repository/workflow identity trusted to mutate contact research state via
 * GitHub Actions OIDC. Defaults to this deployment's workflow; override with
 * REPOSITORY_SLUG / CONTACT_RESEARCH_WORKFLOW_REF env vars to fork safely.
 * Resolves to `null` when an override is malformed so
 * `isTrustedContactResearchOidcClaims` fails closed instead of trusting an
 * invalid value.
 */
export const CONTACT_RESEARCH_TRUST_CONFIG: WorkflowTrustConfig | null =
  resolveContactResearchTrustConfig();
export const CONTACT_RESEARCH_WORKFLOW_REF =
  CONTACT_RESEARCH_TRUST_CONFIG?.workflowRef ??
  buildWorkflowRef(appConfig.repository, CONTACT_RESEARCH_WORKFLOW_FILE);

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

export interface DirectOutreachEvidenceInput {
  sourceUrl: string;
  quote: string;
}

export interface TrustedDirectOutreachInput {
  instructionVersion: number;
  instructionExcerpt: string;
  managerName: string;
  managerCompany: string | null;
  note: string;
  evidence: DirectOutreachEvidenceInput[];
}

export type ContactResearchSubmission =
  | {
      outcome: "candidates";
      claimToken: string;
      notes: string | null;
      candidates: ContactResearchCandidateInput[];
      directOutreach: TrustedDirectOutreachInput | null;
    }
  | {
      outcome: "exhausted";
      claimToken: string;
      notes: string | null;
      candidates: [];
    }
  | {
      outcome: "skipped";
      claimToken: string;
      notes: string;
      ruleVersion: number;
      ruleText: string;
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

export type ContactResearchTransactionRunner = <T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>
) => Promise<T>;

export const CONTACT_RESEARCH_RETRY_SKIP_REASONS = [
  "status_changed",
  "effective_approval",
  "active_contact",
  "intentional_skip",
  "pending_direct_outreach",
  "no_eligible_show",
] as const;

export type ContactResearchRetrySkipReason =
  (typeof CONTACT_RESEARCH_RETRY_SKIP_REASONS)[number];

export interface ContactResearchBulkRetryResult {
  requeued: number;
  skipped: Record<ContactResearchRetrySkipReason, number>;
}

export type ContactResearchQueryRunner = <T>(
  query: Prisma.Sql
) => Promise<T>;

export type ArtistContactResearchMutationFailure =
  | "artist_not_found"
  | "active_contact"
  | "ineligible"
  | "empty_instructions"
  | "job_not_found"
  | "already_skipped"
  | "not_skipped";

export type ArtistContactResearchMutationResult =
  | {
      ok: true;
      jobId: string;
      status: string;
    }
  | {
      ok: false;
      reason: ArtistContactResearchMutationFailure;
    };

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

const DIRECT_OUTREACH_KEYS = new Set([
  "instructionVersion",
  "instructionExcerpt",
  "managerName",
  "managerCompany",
  "note",
  "evidence",
]);

export function isContactResearchApprovalEffective(
  normalizedEmail: string,
  contacts: ReadonlyArray<{
    email: string | null;
    state: "active" | "quarantined";
  }>
): boolean {
  return contacts.some(
    (contact) =>
      contact.state === "active" &&
      contact.email?.trim().toLowerCase() === normalizedEmail
  );
}

async function supersedeObsoleteContactResearchApprovals(
  tx: Prisma.TransactionClient,
  scope: {
    artistIds?: readonly string[];
    jobIds?: readonly string[];
  } = {}
): Promise<void> {
  if (scope.artistIds?.length === 0 || scope.jobIds?.length === 0) return;
  const approvals = await tx.contactResearchCandidate.findMany({
    where: {
      status: "approved",
      ...(scope.artistIds || scope.jobIds
        ? {
            job: {
              ...(scope.artistIds
                ? { artistId: { in: [...scope.artistIds] } }
                : {}),
              ...(scope.jobIds ? { id: { in: [...scope.jobIds] } } : {}),
            },
          }
        : {}),
    },
    select: {
      id: true,
      normalizedEmail: true,
      job: { select: { artistId: true } },
    },
  });
  if (approvals.length === 0) return;
  const contacts = await tx.contact.findMany({
    where: {
      artistId: {
        in: Array.from(
          new Set(approvals.map((candidate) => candidate.job.artistId))
        ),
      },
      ...ACTIVE_EMAIL_CONTACT_WHERE,
    },
    select: { artistId: true, email: true, state: true },
  });
  const contactsByArtist = new Map<
    string,
    Array<{
      email: string | null;
      state: "active" | "quarantined";
    }>
  >();
  for (const contact of contacts) {
    const current = contactsByArtist.get(contact.artistId) ?? [];
    current.push(contact);
    contactsByArtist.set(contact.artistId, current);
  }
  const obsolete = approvals.filter(
    (candidate) =>
      !isContactResearchApprovalEffective(
        candidate.normalizedEmail,
        contactsByArtist.get(candidate.job.artistId) ?? []
      )
  );
  if (obsolete.length === 0) return;
  await tx.contactResearchCandidate.updateMany({
    where: { id: { in: obsolete.map((candidate) => candidate.id) } },
    // Preserve reviewedAt as the approval time; updatedAt records supersession.
    data: { status: "superseded" },
  });
}
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
  if (!EMAIL_PATTERN.test(email)) {
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

  assertPublicHttpsSourceUrl(raw, "source URL");
  url.hash = "";
  return url.toString();
}

function normalizedIdentityText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeDirectOutreachIdentity(
  artistId: string,
  managerName: string
): string {
  return createHash("sha256")
    .update(`${artistId}\u0000${normalizedIdentityText(managerName)}`)
    .digest("hex");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeDirectOutreachEvidence(
  value: unknown,
  managerName: string,
): DirectOutreachEvidenceInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("direct outreach needs at least one evidence quote");
  }
  if (value.length > 5) {
    throw new Error("direct outreach may have at most 5 evidence quotes");
  }
  const normalizedManagerName = normalizedIdentityText(managerName);
  const escapedManagerName = escapeRegExp(normalizedManagerName);
  const positiveRelationship = new RegExp(
    `(?:managed by|manager|management) ${escapedManagerName}\\b|\\b${escapedManagerName} (?:manages|management|is (?:the )?.*manager)\\b`,
  );
  const negativeRelationship =
    /\b(?:not|no longer|former|formerly|previous|previously|ex|unconfirmed|rumou?r|denied|denies|incorrect)\b/;
  const evidence = value.map((entry, index) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry)
    ) {
      throw new Error(
        `direct outreach evidence ${index + 1} must be an object`,
      );
    }
    const input = entry as Record<string, unknown>;
    if (Object.keys(input).sort().join(",") !== "quote,sourceUrl") {
      throw new Error(
        `direct outreach evidence ${index + 1} must contain exactly sourceUrl and quote`,
      );
    }
    const sourceUrl = normalizeResearchSourceUrl(input.sourceUrl);
    assertAgentSafeSourceUrl(
      sourceUrl,
      `direct outreach evidence ${index + 1} sourceUrl`,
    );
    const quote = requiredString(
      input.quote,
      2_000,
      `direct outreach evidence ${index + 1} quote`,
    );
    assertNoPhoneLikeNumber(
      quote,
      `direct outreach evidence ${index + 1} quote`,
    );
    const normalizedQuote = normalizedIdentityText(quote);
    if (
      negativeRelationship.test(normalizedQuote) ||
      !positiveRelationship.test(normalizedQuote)
    ) {
      throw new Error(
        `direct outreach evidence ${index + 1} must be a positive published manager statement`,
      );
    }
    return { sourceUrl, quote };
  });
  return Array.from(
    new Map(
      evidence.map((entry) => [
        `${entry.sourceUrl}\u0000${entry.quote}`,
        entry,
      ]),
    ).values(),
  );
}

export function normalizeTrustedDirectOutreach(
  value: unknown
): TrustedDirectOutreachInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("directOutreach must be an object");
  }
  const input = value as Record<string, unknown>;
  const unexpected = Object.keys(input).filter(
    (key) => !DIRECT_OUTREACH_KEYS.has(key)
  );
  if (unexpected.length > 0) {
    throw new Error(
      `directOutreach contains unsupported field: ${unexpected[0]}`
    );
  }
  if (
    typeof input.instructionVersion !== "number" ||
    !Number.isSafeInteger(input.instructionVersion) ||
    input.instructionVersion < 1
  ) {
    throw new Error(
      "direct outreach instructionVersion must be a positive integer",
    );
  }
  const instructionExcerpt = requiredString(
    input.instructionExcerpt,
    DIRECT_OUTREACH_INSTRUCTION_EXCERPT_MAX_LENGTH,
    "direct outreach instructionExcerpt",
  );
  assertNoPhoneLikeNumber(
    instructionExcerpt,
    "direct outreach instructionExcerpt",
  );
  const managerName = requiredString(
    input.managerName,
    200,
    "direct outreach managerName"
  );
  const normalizedManagerName = normalizedIdentityText(managerName);
  if (normalizedManagerName.length < 2) {
    throw new Error(
      "direct outreach managerName must identify a named manager"
    );
  }
  const managerCompany = optionalString(
    input.managerCompany,
    200,
    "direct outreach managerCompany"
  );
  const note = requiredString(
    input.note,
    900,
    "direct outreach note",
  );
  assertNoPhoneLikeNumber(managerName, "direct outreach managerName");
  if (managerCompany !== null) {
    assertNoPhoneLikeNumber(
      managerCompany,
      "direct outreach managerCompany",
    );
  }
  assertNoPhoneLikeNumber(note, "direct outreach note");
  return {
    instructionVersion: input.instructionVersion,
    instructionExcerpt,
    managerName,
    managerCompany,
    note,
    evidence: normalizeDirectOutreachEvidence(input.evidence, managerName),
  };
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

export function normalizeArtistResearchSkipReason(value: unknown): string {
  return requiredString(value, 4_000, "skip reason");
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
  artistIds: string[];
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
      existing.artistIds = Array.from(
        new Set([...existing.artistIds, ...row.artistIds])
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
      orderBy: [{ updatedAt: "desc" }],
      take: 100,
      select: {
        email: true,
        name: true,
        notes: true,
        artist: { select: { id: true, name: true } },
      },
    }),
    db.contactResearchCandidate.findMany({
      where: {
        status: { in: ["pending", "approved"] },
        OR: candidateFilters,
      },
      orderBy: [{ updatedAt: "desc" }],
      take: 100,
      select: {
        email: true,
        name: true,
        evidence: true,
        status: true,
        sourceUrls: true,
        job: { select: { artist: { select: { id: true, name: true } } } },
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
              artistIds: [contact.artist.id],
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
      artistIds: [candidate.job.artist.id],
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
  if (
    outcome !== "candidates" &&
    outcome !== "exhausted" &&
    outcome !== "skipped"
  ) {
    throw new Error("outcome must be candidates, exhausted, or skipped");
  }
  const claimToken = requiredString(input.claimToken, 200, "claimToken");
  const notes = optionalString(input.notes, 4_000, "notes");
  if (outcome === "exhausted") {
    if (input.directOutreach != null) {
      throw new Error("exhausted outcomes cannot include direct outreach");
    }
    validateResearchSubmissionPayload(value);
    return { outcome, claimToken, notes, candidates: [] };
  }
  if (outcome === "skipped") {
    if (input.directOutreach != null) {
      throw new Error("skipped outcomes cannot include direct outreach");
    }
    if (Array.isArray(input.candidates) && input.candidates.length > 0) {
      throw new Error("skipped outcomes cannot include candidates");
    }
    if (
      typeof input.ruleVersion !== "number" ||
      !Number.isSafeInteger(input.ruleVersion) ||
      input.ruleVersion < 1
    ) {
      throw new Error("ruleVersion must be a positive integer");
    }
    const submission: ContactResearchSubmission = {
      outcome,
      claimToken,
      notes: normalizeArtistResearchSkipReason(notes),
      ruleVersion: input.ruleVersion,
      ruleText: requiredString(input.ruleText, 8_000, "ruleText"),
      candidates: [],
    };
    validateResearchSubmissionPayload(value);
    return submission;
  }
  const directOutreach =
    input.directOutreach == null
      ? null
      : normalizeTrustedDirectOutreach(input.directOutreach);
  if (directOutreach !== null && notes !== null) {
    assertNoPhoneLikeNumber(notes, "notes");
  }
  const candidateValues = input.candidates ?? [];
  if (!Array.isArray(candidateValues)) {
    throw new Error("candidates must be an array");
  }
  if (candidateValues.length === 0 && directOutreach === null) {
    throw new Error("at least one candidate or direct outreach is required");
  }
  if (candidateValues.length > 10) {
    throw new Error("at most 10 candidates may be submitted");
  }

  const candidatesByEmail = new Map<string, ContactResearchCandidateInput>();
  for (const candidateValue of candidateValues) {
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
    const needsApproval =
      candidate.needsApproval === false &&
      officialSource.officialSourceType !== null
        ? false
        : true;
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

  const submission: ContactResearchSubmission = {
    outcome,
    claimToken,
    notes,
    candidates: [...candidatesByEmail.values()],
    directOutreach,
  };
  validateResearchSubmissionPayload(value);
  return submission;
}

export function isTrustedAgentSkipRuleProvenance(
  claimedRuleVersion: number | null,
  claimedRules: string | null,
  ruleVersion: number,
  ruleText: string
): boolean {
  const snapshot = claimedRules?.trim() ?? "";
  const matchingRule = ruleText.trim();
  const snapshotLines = snapshot
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    claimedRuleVersion !== null &&
    claimedRuleVersion >= 1 &&
    claimedRuleVersion === ruleVersion &&
    snapshot.length > 0 &&
    matchingRule.length > 0 &&
    (snapshot === matchingRule || snapshotLines.includes(matchingRule))
  );
}

function hasVerbatimInstructionExcerpt(
  snapshot: string,
  excerpt: string,
): boolean {
  let index = snapshot.indexOf(excerpt);
  while (index !== -1) {
    const before = snapshot[index - 1];
    const after = snapshot[index + excerpt.length];
    const startsAtBoundary =
      before === undefined || !/[\p{L}\p{N}]/u.test(before);
    const endsAtBoundary =
      after === undefined || !/[\p{L}\p{N}]/u.test(after);
    if (startsAtBoundary && endsAtBoundary) return true;
    index = snapshot.indexOf(excerpt, index + 1);
  }
  return false;
}

export function isTrustedDirectOutreachInstructionProvenance(
  claimedRuleVersion: number | null,
  claimedRules: Prisma.JsonValue | null,
  directOutreach: TrustedDirectOutreachInput,
): boolean {
  if (
    claimedRuleVersion === null ||
    claimedRuleVersion < 1 ||
    claimedRuleVersion !== directOutreach.instructionVersion
  ) {
    return false;
  }
  try {
    const snapshot = readStoredDirectOutreachInstructions(
      claimedRules ?? [],
    );
    const excerpt = directOutreach.instructionExcerpt.trim();
    return (
      snapshot.length > 0 &&
      excerpt.length > 0 &&
      hasVerbatimInstructionExcerpt(snapshot, excerpt)
    );
  } catch {
    return false;
  }
}

async function persistTrustedDirectOutreachProposal(
  tx: Prisma.TransactionClient,
  job: { id: string },
  directOutreach: TrustedDirectOutreachInput,
): Promise<void> {
  const normalizedManagerName = normalizedIdentityText(
    directOutreach.managerName,
  );
  const ruleId = `instruction-${createHash("sha256")
    .update(directOutreach.instructionExcerpt)
    .digest("hex")
    .slice(0, 32)}`;
  const canonicalRule = canonicalDirectOutreachInstructionExcerpt(
    directOutreach.instructionExcerpt,
  );
  const existing =
    await tx.contactResearchDirectOutreachProposal.findUnique({
      where: {
        jobId_ruleId_normalizedManagerName: {
          jobId: job.id,
          ruleId,
          normalizedManagerName,
        },
      },
      select: { id: true, status: true },
    });
  if (existing && existing.status !== "pending") return;
  const data = {
    ruleVersion: directOutreach.instructionVersion,
    canonicalRule,
    managerName: directOutreach.managerName,
    managerCompany: directOutreach.managerCompany,
    note: `Direct outreach: ${directOutreach.note}`,
    sourceUrls: directOutreach.evidence.map(
      (evidence) => evidence.sourceUrl,
    ),
    evidenceQuotes: directOutreach.evidence.map(
      (evidence) => evidence.quote,
    ),
  };
  if (existing) {
    await tx.contactResearchDirectOutreachProposal.update({
      where: { id: existing.id },
      data,
    });
    return;
  }
  await tx.contactResearchDirectOutreachProposal.create({
    data: {
      jobId: job.id,
      ruleId,
      normalizedManagerName,
      status: "pending",
      ...data,
    },
  });
}

async function applyApprovedDirectOutreach(
  tx: Prisma.TransactionClient,
  job: { id: string; artistId: string },
  proposal: {
    ruleVersion: number;
    canonicalRule: string;
    managerName: string;
    managerCompany: string | null;
    note: string;
    sourceUrls: string[];
    evidenceQuotes: string[];
  },
): Promise<{ id: string }> {
  const directOutreachIdentity = normalizeDirectOutreachIdentity(
    job.artistId,
    proposal.managerName,
  );
  const provenance = {
    directOutreachNote: proposal.note,
    directOutreachIdentity,
    directOutreachSourceJobId: job.id,
    directOutreachRuleVersion: proposal.ruleVersion,
    directOutreachRuleText: proposal.canonicalRule,
    directOutreachManagerName: proposal.managerName,
    directOutreachManagerCompany: proposal.managerCompany,
    directOutreachEvidenceUrls: proposal.sourceUrls,
    directOutreachEvidence: proposal.evidenceQuotes.join("\n"),
  };
  const existingIdentity = await tx.contact.findUnique({
    where: { directOutreachIdentity },
    select: { id: true },
  });
  if (existingIdentity) {
    await tx.contact.update({
      where: { id: existingIdentity.id },
      data: { ...provenance, state: "active" },
    });
    return existingIdentity;
  }

  const attachableContacts = await tx.contact.findMany({
    where: {
      artistId: job.artistId,
      state: "active",
      directOutreachIdentity: null,
      directOutreachNote: null,
    },
    select: {
      id: true,
      name: true,
    },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
  });
  const normalizedManagerName = normalizedIdentityText(
    proposal.managerName,
  );
  const matchingContact = attachableContacts.find(
    (contact) =>
      contact.name !== null &&
      normalizedIdentityText(contact.name) === normalizedManagerName
  );
  if (matchingContact) {
    await tx.contact.update({
      where: { id: matchingContact.id },
      data: provenance,
    });
    return matchingContact;
  }

  return tx.contact.create({
    data: {
      artistId: job.artistId,
      email: null,
      phone: null,
      name: proposal.managerName,
      role: "management",
      source: "agent",
      state: "active",
      ...provenance,
    },
    select: { id: true },
  });
}

interface ContactResearchAuthorizationOptions {
  environment?: AgentMutationEnvironment;
  staticToken?: string;
  verifyGithubActionsToken?: (token: string) => Promise<boolean>;
}

function isContactResearchAuthorizationOptions(
  value:
    | ContactResearchAuthorizationOptions
    | string
    | readonly (string | undefined)[]
): value is ContactResearchAuthorizationOptions {
  return typeof value === "object" && !Array.isArray(value);
}

export async function isValidContactResearchAuthorization(
  authorization: string | null,
  optionsOrStaticToken:
    | ContactResearchAuthorizationOptions
    | string
    | readonly (string | undefined)[] = {},
  legacyVerifier?: (token: string) => Promise<boolean>
): Promise<boolean> {
  const hasOptions =
    isContactResearchAuthorizationOptions(optionsOrStaticToken);
  const options = hasOptions ? optionsOrStaticToken : undefined;
  const staticSecrets = hasOptions
    ? optionsOrStaticToken.staticToken ??
      process.env.CONTACT_RESEARCH_AGENT_TOKEN
    : optionsOrStaticToken;
  return isValidAgentMutationAuthorization(authorization, {
    environment: options?.environment,
    staticSecrets,
    verifyOidcToken:
      options?.verifyGithubActionsToken ??
      legacyVerifier ??
      verifyGithubActionsContactResearchToken,
  });
}

export function isTrustedContactResearchOidcClaims(
  payload: JWTPayload,
  configuration: WorkflowTrustConfig | null = CONTACT_RESEARCH_TRUST_CONFIG
): boolean {
  if (!configuration) return false;
  return (
    payload.aud === CONTACT_RESEARCH_OIDC_AUDIENCE &&
    payload.repository === configuration.repository &&
    payload.repository_owner === configuration.owner &&
    payload.ref === "refs/heads/main" &&
    payload.workflow_ref === configuration.workflowRef &&
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
      maxTokenAge: "10m",
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
  now: Date = new Date(),
  runTransaction: ContactResearchTransactionRunner = (work) =>
    withSerializableRetry(work, { timeout: 30_000 })
): Promise<ContactResearchQueueResult> {
  const today = easternTodayStoredDate(now);
  const end = parseDateOnly(
    addDateOnlyDays(easternDateOnly(now), CONTACT_RESEARCH_WINDOW_DAYS)
  );
  const activeSignalWhere = activeListenSignalWhere(now);
  return runTransaction(async (tx) => {
    const rows = await tx.showArtist.findMany({
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
          researchSkips: {
            none: { clearedAt: null },
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
    const requestedRows = await tx.contactResearchJob.findMany({
      where: {
        requestedShow: {
          date: { gte: today },
          syncStatus: "active",
          AND: [festivalLeadTimeWhere(now)],
        },
        artist: {
          contacts: { none: ACTIVE_EMAIL_CONTACT_WHERE },
          researchSkips: { none: { clearedAt: null } },
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
        Math.round(
          (row.show.date.getTime() - today.getTime()) / 86_400_000
        )
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
    await supersedeObsoleteContactResearchApprovals(tx);
    const completed = await tx.contactResearchJob.updateMany({
      where: {
        status: { in: ["pending", "claimed", "exhausted"] },
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
      status: { in: ["pending", "claimed", "exhausted"] },
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
      select: {
        id: true,
        artistId: true,
        status: true,
        candidates: {
          where: { status: "superseded" },
          take: 1,
          select: { id: true },
        },
      },
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
      if (
        job.status === "complete" ||
        job.status === "inactive" ||
        (job.status === "exhausted" && job.candidates.length > 0)
      ) {
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
          WHEN job."status" IN ('complete', 'inactive')
            OR (
              job."status" = 'exhausted'
              AND EXISTS (
                SELECT 1
                FROM "ContactResearchCandidate" candidate_history
                WHERE candidate_history."jobId" = job."id"
                  AND candidate_history."status" = 'superseded'
              )
            )
          THEN 'pending'
          ELSE job."status"
        END,
        "priority" = EXCLUDED."priority",
        "nextShowAt" = EXCLUDED."nextShowAt",
        "completedAt" = CASE
          WHEN job."status" IN ('complete', 'inactive')
            OR (
              job."status" = 'exhausted'
              AND EXISTS (
                SELECT 1
                FROM "ContactResearchCandidate" candidate_history
                WHERE candidate_history."jobId" = job."id"
                  AND candidate_history."status" = 'superseded'
              )
            )
          THEN NULL
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
  });
}

export async function enqueueFestivalManagerResearch(
  showId: string,
  now: Date = new Date(),
  runTransaction: ContactResearchTransactionRunner = (work) =>
    withSerializableRetry(work)
): Promise<{
  eligible: number;
  enqueued: number;
  alreadyQueued: number;
}> {
  const today = easternTodayStoredDate(now);
  return runTransaction(async (tx) => {
    const festival = await tx.show.findFirst({
      where: {
        id: showId,
        isFestival: true,
        syncStatus: "active",
        date: { gte: today },
        AND: [festivalLeadTimeWhere(now)],
      },
      select: {
        id: true,
        date: true,
        artists: {
          where: {
            artist: {
              contacts: { none: ACTIVE_EMAIL_CONTACT_WHERE },
              researchSkips: { none: { clearedAt: null } },
            },
          },
          select: {
            artistId: true,
            artist: {
              select: {
                popularity: true,
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

    const artistIds = festival.artists.map((row) => row.artistId);
    await supersedeObsoleteContactResearchApprovals(tx, { artistIds });
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

    for (const row of festival.artists) {
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
            completedAt: null,
            agentNotes: null,
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
      eligible: festival.artists.length,
      enqueued,
      alreadyQueued,
    };
  });
}

export async function prepareContactResearchQueue(
  now: Date = new Date(),
  options: { refreshQueue?: boolean } = {},
): Promise<ContactResearchPreparationResult> {
  await reclaimExpiredContactResearchClaims(now);
  const refreshed =
    options.refreshQueue === false
      ? {
          eligible: 0,
          enqueued: 0,
          reprioritized: 0,
          completed: 0,
          inactivated: 0,
        }
      : await refreshContactResearchQueue(now);
  const claimable = await countClaimableContactResearchJobs(now);
  return { ...refreshed, claimable };
}

export async function reclaimExpiredContactResearchClaims(
  now: Date = new Date(),
): Promise<number> {
  const reclaimed = await db.contactResearchJob.updateMany({
    where: {
      status: "claimed",
      OR: [
        { claimExpiresAt: null },
        { claimExpiresAt: { lte: now } },
      ],
    },
    data: {
      status: "pending",
      claimToken: null,
      claimedAt: null,
      claimExpiresAt: null,
    },
  });
  return reclaimed.count;
}

export function countClaimableContactResearchJobs(
  now: Date = new Date(),
): Promise<number> {
  return db.contactResearchJob.count({
    where: {
      artist: {
        researchSkips: { none: { clearedAt: null } },
      },
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
  now: Date = new Date(),
  runTransaction: ContactResearchTransactionRunner = (work) =>
    withSerializableRetry(work)
) {
  const claimLimit = parseContactResearchClaimLimit(limit);
  const claimExpiresAt = new Date(now.getTime() + CONTACT_RESEARCH_CLAIM_TTL_MS);
  const today = easternTodayStoredDate(now);
  const end = parseDateOnly(
    addDateOnlyDays(easternDateOnly(now), CONTACT_RESEARCH_WINDOW_DAYS)
  );
  return runTransaction(
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
        AND NOT EXISTS (
          SELECT 1
          FROM "ArtistResearchSkip" research_skip
          WHERE research_skip."artistId" = job."artistId"
            AND research_skip."clearedAt" IS NULL
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "ContactResearchDirectOutreachProposal" direct_outreach
          WHERE direct_outreach."jobId" = job."id"
            AND direct_outreach."status" = 'pending'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "ContactResearchCandidate" candidate
          JOIN "Contact" approved_contact
            ON approved_contact."artistId" = job."artistId"
           AND approved_contact."state" = 'active'
           AND approved_contact."email" IS NOT NULL
           AND LOWER(BTRIM(approved_contact."email"))
             = candidate."normalizedEmail"
          WHERE candidate."jobId" = job."id"
            AND candidate."status" = 'approved'
        )
        AND EXISTS (
          SELECT 1
          FROM "ShowArtist" show_artist
          JOIN "Show" show
            ON show."id" = show_artist."showId"
          WHERE show_artist."artistId" = job."artistId"
            AND show."date" >= ${today}
            AND show."syncStatus" = 'active'
            AND ${festivalLeadTimeSql(now)}
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
      if (selected.length === 0) return [];
      await supersedeObsoleteContactResearchApprovals(tx, {
        jobIds: selected.map((row) => row.id),
      });
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
            claimedDirectOutreachRules:
              directOutreachInstructionsStorage(
                globalAgentRules.directOutreachInstructions,
              ),
          },
        });
      }
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
                  directOutreachNote: true,
                  directOutreachRuleVersion: true,
                  directOutreachRuleText: true,
                  directOutreachManagerName: true,
                  directOutreachManagerCompany: true,
                  directOutreachEvidenceUrls: true,
                  directOutreachEvidence: true,
                  name: true,
                  role: true,
                  source: true,
                },
              },
              shows: {
                where: {
                  show: {
                    date: { gte: easternTodayStoredDate(now) },
                    syncStatus: "active",
                    AND: [festivalLeadTimeWhere(now)],
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
              directOutreachInstructions:
                readStoredDirectOutreachInstructions(
                  job.claimedDirectOutreachRules ?? [],
                ),
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
    }
  );
}

export async function submitContactResearchResult(
  jobId: string,
  value: unknown,
  now: Date = new Date(),
  runTransaction: ContactResearchTransactionRunner = (work) =>
    withSerializableRetry(work)
): Promise<{
  accepted: boolean;
  status:
    | "review"
    | "exhausted"
    | "complete"
    | "skipped"
    | "conflict"
    | "invalid_rule_provenance";
  autoApproved: number;
}> {
  const submission = parseContactResearchSubmission(value);
  const stored = await runTransaction(async (tx) => {
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
        claimedAgentRules: true,
        claimedAgentRulesVersion: true,
        claimedDirectOutreachRules: true,
      },
    });
    if (!job) {
      return {
        accepted: false,
        status: "conflict" as const,
        autoApproved: 0,
      };
    }

    const trustedDirectOutreachInstruction =
      submission.outcome === "candidates" &&
      submission.directOutreach !== null
        ? isTrustedDirectOutreachInstructionProvenance(
            job.claimedAgentRulesVersion,
            job.claimedDirectOutreachRules,
            submission.directOutreach,
          )
        : null;
    if (
      submission.outcome === "candidates" &&
      submission.directOutreach !== null &&
      !trustedDirectOutreachInstruction
    ) {
      return {
        accepted: false,
        status: "invalid_rule_provenance" as const,
        autoApproved: 0,
      };
    }

    if (submission.outcome === "skipped") {
      if (
        !isTrustedAgentSkipRuleProvenance(
          job.claimedAgentRulesVersion,
          job.claimedAgentRules,
          submission.ruleVersion,
          submission.ruleText,
        )
      ) {
        return {
          accepted: false,
          status: "invalid_rule_provenance" as const,
          autoApproved: 0,
        };
      }
      await tx.artistResearchSkip.create({
        data: {
          artistId: job.artistId,
          source: "agent",
          reason: submission.notes,
          sourceJobId: job.id,
          agentRuleVersion: submission.ruleVersion,
          agentRuleText: submission.ruleText,
          setAt: now,
        },
      });
      await tx.contactResearchJob.update({
        where: { id: jobId },
        data: {
          status: "skipped",
          agentNotes: submission.notes,
          claimToken: null,
          claimedAt: null,
          claimExpiresAt: null,
          completedAt: null,
        },
      });
      return {
        accepted: true,
        status: "skipped" as const,
        autoApproved: 0,
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
        autoApproved: 0,
      };
    }

    await supersedeObsoleteContactResearchApprovals(tx, {
      jobIds: [jobId],
    });
    if (
      submission.directOutreach !== null &&
      trustedDirectOutreachInstruction
    ) {
      await persistTrustedDirectOutreachProposal(
        tx,
        job,
        submission.directOutreach,
      );
    }

    const autoApproveCandidates: Array<{
      id: string;
      input: ContactResearchCandidateInput;
    }> = [];
    for (const candidate of submission.candidates) {
      const existingCandidate =
        await tx.contactResearchCandidate.findUnique({
          where: {
            jobId_normalizedEmail: {
              jobId,
              normalizedEmail: candidate.normalizedEmail,
            },
          },
          select: { status: true },
        });
      const approvalContact =
        existingCandidate?.status === "approved"
          ? await tx.contact.findUnique({
              where: {
                artistId_email: {
                  artistId: job.artistId,
                  email: candidate.normalizedEmail,
                },
              },
            })
          : null;
      const preserveApproval =
        existingCandidate?.status === "approved" &&
        approvalContact !== null &&
        isContactResearchApprovalEffective(
          candidate.normalizedEmail,
          [approvalContact]
        );
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
          // Rediscovery starts a fresh review after supersession.
          ...(!preserveApproval
            ? { status: "pending", reviewedAt: null }
            : {}),
        },
      });
      if (
        !preserveApproval &&
        isOfficialManagementAutoApprovalEligible(candidate)
      ) {
        autoApproveCandidates.push({
          id: storedCandidate.id,
          input: candidate,
        });
      }
    }
    for (const candidate of autoApproveCandidates) {
      const existing = await tx.contact.findUnique({
        where: {
          artistId_email: {
            artistId: job.artistId,
            email: candidate.input.normalizedEmail,
          },
        },
      });
      if (existing) {
        await tx.contact.update({
          where: { id: existing.id },
          data: {
            state: "active",
            name: existing.name ?? candidate.input.name,
            role: "management",
          },
        });
      } else {
        await tx.contact.create({
          data: {
            artistId: job.artistId,
            email: candidate.input.normalizedEmail,
            name: candidate.input.name,
            role: "management",
            source: "agent",
            state: "active",
          },
        });
      }
    }
    if (autoApproveCandidates.length > 0) {
      const approvedIds = autoApproveCandidates.map(
        (candidate) => candidate.id
      );
      const updated = await tx.contactResearchCandidate.updateMany({
        where: {
          id: { in: approvedIds },
          status: "pending",
        },
        data: { status: "approved", reviewedAt: now },
      });
      if (updated.count !== approvedIds.length) {
        throw new ContactResearchCandidateConflictError();
      }
    }
    const status = await resolveContactResearchJob(
      tx,
      jobId,
      job.artistId,
      now,
      submission.notes
    );
    return {
      accepted: true,
      status,
      autoApproved: autoApproveCandidates.length,
    };
  });
  if (!stored.accepted) {
    return {
      accepted: false,
      status: stored.status,
      autoApproved: 0,
    };
  }
  return {
    accepted: true,
    status: stored.status,
    autoApproved: stored.autoApproved,
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
      const retryable =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === "P2002" ||
          error.code === "P2034" ||
          (error.code === "P2010" &&
            error.meta !== null &&
            typeof error.meta === "object" &&
            Reflect.get(error.meta, "code") === "40001"));
      if (retryable && attempt < 3) continue;
      throw error;
    }
  }
  throw new Error("Unable to complete serializable transaction");
}

class ContactResearchCandidateConflictError extends Error {}

async function directOutreachProposalState(
  tx: Prisma.TransactionClient,
  jobId: string,
): Promise<{ pending: number; total: number }> {
  const delegate = (
    tx as unknown as {
      contactResearchDirectOutreachProposal?: {
        findMany: (args: {
          where: { jobId: string };
          select: { status: true };
        }) => Promise<Array<{ status: string }>>;
      };
    }
  ).contactResearchDirectOutreachProposal;
  if (!delegate) return { pending: 0, total: 0 };
  const proposals = await delegate.findMany({
    where: { jobId },
    select: { status: true },
  });
  return {
    pending: proposals.filter((proposal) => proposal.status === "pending")
      .length,
    total: proposals.length,
  };
}

async function resolveContactResearchJob(
  tx: Prisma.TransactionClient,
  jobId: string,
  artistId: string,
  now: Date,
  agentNotes?: string | null
): Promise<"review" | "complete" | "exhausted"> {
  const candidates = await tx.contactResearchCandidate.findMany({
    where: { jobId, status: { in: ["pending", "approved"] } },
    select: { status: true, normalizedEmail: true },
  });
  const activeContacts = await tx.contact.findMany({
    where: { artistId, ...ACTIVE_EMAIL_CONTACT_WHERE },
    select: { email: true, state: true },
  });
  const pending = candidates.filter(
    (candidate) => candidate.status === "pending"
  ).length;
  const approved = candidates.filter(
    (candidate) =>
      candidate.status === "approved" &&
      isContactResearchApprovalEffective(
        candidate.normalizedEmail,
        activeContacts
      )
  ).length;
  const directOutreach = await directOutreachProposalState(tx, jobId);
  const status =
    pending > 0 || directOutreach.pending > 0
      ? "review"
      : approved > 0
        ? "complete"
        : directOutreach.total > 0
          ? "review"
          : "exhausted";
  await tx.contactResearchJob.update({
    where: { id: jobId },
    data: {
      status,
      ...(agentNotes !== undefined ? { agentNotes } : {}),
      completedAt: status === "complete" ? now : null,
      claimToken: null,
      claimedAt: null,
      claimExpiresAt: null,
    },
  });
  return status;
}

export async function approveContactResearchDirectOutreach(
  proposalId: string,
  now: Date = new Date(),
  runTransaction: ContactResearchTransactionRunner = (work) =>
    withSerializableRetry(work),
): Promise<{ ok: boolean; contactId?: string; error?: string }> {
  return runTransaction(async (tx) => {
    const proposal =
      await tx.contactResearchDirectOutreachProposal.findFirst({
        where: {
          id: proposalId,
          status: "pending",
          job: { status: "review" },
        },
        include: {
          job: { select: { id: true, artistId: true } },
        },
      });
    if (!proposal) {
      return { ok: false, error: "Direct outreach is no longer reviewable" };
    }
    const contact = await applyApprovedDirectOutreach(
      tx,
      proposal.job,
      proposal,
    );
    const reviewed =
      await tx.contactResearchDirectOutreachProposal.updateMany({
        where: { id: proposal.id, status: "pending" },
        data: {
          status: "approved",
          contactId: contact.id,
          reviewedAt: now,
        },
      });
    if (reviewed.count !== 1) {
      throw new ContactResearchCandidateConflictError();
    }
    await resolveContactResearchJob(
      tx,
      proposal.jobId,
      proposal.job.artistId,
      now,
    );
    return { ok: true, contactId: contact.id };
  });
}

export async function rejectContactResearchDirectOutreach(
  proposalId: string,
  now: Date = new Date(),
  runTransaction: ContactResearchTransactionRunner = (work) =>
    withSerializableRetry(work),
): Promise<{ ok: boolean; error?: string }> {
  return runTransaction(async (tx) => {
    const proposal =
      await tx.contactResearchDirectOutreachProposal.findFirst({
        where: {
          id: proposalId,
          status: "pending",
          job: { status: "review" },
        },
        select: {
          id: true,
          jobId: true,
          job: { select: { artistId: true } },
        },
      });
    if (!proposal) {
      return { ok: false, error: "Direct outreach is no longer reviewable" };
    }
    const reviewed =
      await tx.contactResearchDirectOutreachProposal.updateMany({
        where: { id: proposal.id, status: "pending" },
        data: {
          status: "rejected",
          contactId: null,
          reviewedAt: now,
        },
      });
    if (reviewed.count !== 1) {
      throw new ContactResearchCandidateConflictError();
    }
    await resolveContactResearchJob(
      tx,
      proposal.jobId,
      proposal.job.artistId,
      now,
    );
    return { ok: true };
  });
}

export async function approveContactResearchCandidates(
  candidateIds: readonly string[],
  now: Date = new Date(),
  runTransaction: ContactResearchTransactionRunner = (work) =>
    withSerializableRetry(work)
): Promise<{
  ok: boolean;
  approvedCount?: number;
  error?: string;
}> {
  const uniqueCandidateIds = Array.from(new Set(candidateIds));
  if (uniqueCandidateIds.length === 0) {
    return { ok: false, error: "No candidates were selected" };
  }
  let approved:
    | {
        ok: true;
        approvedCount: number;
      }
    | { ok: false; error: string };
  try {
    approved = await runTransaction(async (tx) => {
      const candidates = await tx.contactResearchCandidate.findMany({
        where: { id: { in: uniqueCandidateIds } },
        include: {
          job: {
            select: { id: true, artistId: true, status: true },
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
        return {
          ok: false as const,
          error: "Candidate is no longer reviewable",
        };
      }
      const jobIds = new Set(candidates.map((candidate) => candidate.jobId));
      if (jobIds.size !== 1) {
        return {
          ok: false as const,
          error: "Candidates must belong to the same research job",
        };
      }
      const updated = await tx.contactResearchCandidate.updateMany({
        where: {
          id: { in: uniqueCandidateIds },
          status: "pending",
        },
        data: { status: "approved", reviewedAt: now },
      });
      if (updated.count !== uniqueCandidateIds.length) {
        throw new ContactResearchCandidateConflictError();
      }
      const candidateById = new Map(
        candidates.map((candidate) => [candidate.id, candidate])
      );
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
        if (existing) {
          await tx.contact.update({
            where: { id: existing.id },
            data: {
              state: "active",
              name: existing.name ?? candidate.name,
              role: "management",
            },
          });
        } else {
          await tx.contact.create({
            data: {
              artistId: candidate.job.artistId,
              email: candidate.normalizedEmail,
              name: candidate.name,
              role: "management",
              source: "agent",
              state: "active",
            },
          });
        }
      }

      await resolveContactResearchJob(
        tx,
        candidates[0].jobId,
        candidates[0].job.artistId,
        now
      );

      return {
        ok: true as const,
        approvedCount: uniqueCandidateIds.length,
      };
    });
  } catch (error) {
    if (error instanceof ContactResearchCandidateConflictError) {
      return { ok: false, error: "Candidate is no longer reviewable" };
    }
    throw error;
  }
  if (!approved.ok) return approved;

  return {
    ok: true,
    approvedCount: approved.approvedCount,
  };
}

export async function approveContactResearchCandidate(
  candidateId: string,
  now: Date = new Date(),
  runTransaction: ContactResearchTransactionRunner = (work) =>
    withSerializableRetry(work)
): Promise<{ ok: boolean; error?: string }> {
  const result = await approveContactResearchCandidates(
    [candidateId],
    now,
    runTransaction
  );
  return {
    ok: result.ok,
    ...(result.error ? { error: result.error } : {}),
  };
}

export async function rejectContactResearchCandidate(
  candidateId: string,
  now: Date = new Date(),
  runTransaction: ContactResearchTransactionRunner = (work) =>
    withSerializableRetry(work)
): Promise<{ ok: boolean; exhausted: boolean; error?: string }> {
  try {
    return await runTransaction(async (tx) => {
      const candidate = await tx.contactResearchCandidate.findFirst({
        where: {
          id: candidateId,
          status: "pending",
          job: { status: "review" },
        },
        select: {
          id: true,
          jobId: true,
          job: { select: { artistId: true } },
        },
      });
      if (!candidate) {
        return {
          ok: false,
          exhausted: false,
          error: "Candidate is no longer reviewable",
        };
      }
      const updated = await tx.contactResearchCandidate.updateMany({
        where: { id: candidate.id, status: "pending" },
        data: { status: "rejected", reviewedAt: now },
      });
      if (updated.count !== 1) {
        throw new ContactResearchCandidateConflictError();
      }
      const status = await resolveContactResearchJob(
        tx,
        candidate.jobId,
        candidate.job.artistId,
        now
      );
      return { ok: true, exhausted: status === "exhausted" };
    });
  } catch (error) {
    if (error instanceof ContactResearchCandidateConflictError) {
      return {
        ok: false,
        exhausted: false,
        error: "Candidate is no longer reviewable",
      };
    }
    throw error;
  }
}

export async function updateContactResearchJobUserNotes(
  jobId: string,
  value: unknown
): Promise<boolean> {
  const result = await updateContactResearchUserNotes(
    { jobId },
    value,
    new Date(),
    null,
    (work) => withSerializableRetry(work)
  );
  return result.ok;
}

export async function skipContactResearchArtist(
  jobId: string,
  value: unknown,
  now: Date = new Date(),
  runTransaction: ContactResearchTransactionRunner = (work) =>
    withSerializableRetry(work)
): Promise<boolean> {
  const result = await skipContactResearchTarget(
    { jobId },
    value,
    now,
    null,
    runTransaction
  );
  return result.ok;
}

export async function unskipContactResearchArtist(
  jobId: string,
  now: Date = new Date(),
  runTransaction: ContactResearchTransactionRunner = (work) =>
    withSerializableRetry(work)
): Promise<boolean> {
  const result = await unskipContactResearchTarget(
    { jobId },
    now,
    null,
    runTransaction
  );
  return result.ok;
}

type ContactResearchMutationTarget =
  | { jobId: string }
  | { artistId: string };

async function materializeArtistContactResearchJob(
  tx: Prisma.TransactionClient,
  artistId: string,
  now: Date,
  requestedShowId: string | null
): Promise<
  | { ok: true; job: { id: string; artistId: string; status: string } }
  | { ok: false; reason: ArtistContactResearchMutationFailure }
> {
  const existing = await tx.contactResearchJob.findUnique({
    where: { artistId },
    select: { id: true, artistId: true, status: true },
  });
  if (existing) return { ok: true, job: existing };

  const artist = await tx.artist.findUnique({
    where: { id: artistId },
    select: {
      id: true,
      contacts: {
        where: ACTIVE_EMAIL_CONTACT_WHERE,
        take: 1,
        select: { id: true },
      },
    },
  });
  if (!artist) return { ok: false, reason: "artist_not_found" };
  if (artist.contacts.length > 0) {
    return { ok: false, reason: "active_contact" };
  }

  const today = easternTodayStoredDate(now);
  const end = parseDateOnly(
    addDateOnlyDays(easternDateOnly(now), CONTACT_RESEARCH_WINDOW_DAYS)
  );
  const requestedShow = requestedShowId
    ? await tx.showArtist.findFirst({
        where: {
          artistId,
          showId: requestedShowId,
          show: {
            isFestival: true,
            syncStatus: "active",
            date: { gte: today },
            AND: [festivalLeadTimeWhere(now)],
          },
        },
        select: {
          showId: true,
          show: { select: { date: true } },
        },
      })
    : null;
  const regularShow =
    requestedShow ??
    (await tx.showArtist.findFirst({
      where: {
        artistId,
        show: {
          isFestival: false,
          syncStatus: "active",
          date: { gte: today, lte: end },
        },
      },
      orderBy: { show: { date: "asc" } },
      select: {
        showId: true,
        show: { select: { date: true } },
      },
    }));
  if (!regularShow) return { ok: false, reason: "ineligible" };

  const job = await tx.contactResearchJob.upsert({
    where: { artistId },
    create: {
      artistId,
      requestedShowId: requestedShow?.showId ?? null,
      status: "inactive",
      nextShowAt: regularShow.show.date,
    },
    update: {},
    select: { id: true, artistId: true, status: true },
  });
  return { ok: true, job };
}

async function resolveContactResearchMutationJob(
  tx: Prisma.TransactionClient,
  target: ContactResearchMutationTarget,
  now: Date,
  requestedShowId: string | null
): Promise<
  | { ok: true; job: { id: string; artistId: string; status: string } }
  | { ok: false; reason: ArtistContactResearchMutationFailure }
> {
  if ("artistId" in target) {
    return materializeArtistContactResearchJob(
      tx,
      target.artistId,
      now,
      requestedShowId
    );
  }
  const job = await tx.contactResearchJob.findUnique({
    where: { id: target.jobId },
    select: { id: true, artistId: true, status: true },
  });
  return job
    ? { ok: true, job }
    : { ok: false, reason: "job_not_found" };
}

async function updateContactResearchUserNotes(
  target: ContactResearchMutationTarget,
  value: unknown,
  now: Date,
  requestedShowId: string | null,
  runTransaction: ContactResearchTransactionRunner
): Promise<ArtistContactResearchMutationResult> {
  const userNotes = normalizeContactResearchUserNotes(value);
  return runTransaction(async (tx) => {
    if ("artistId" in target && userNotes === null) {
      const existing = await tx.contactResearchJob.findUnique({
        where: { artistId: target.artistId },
        select: { id: true, artistId: true, status: true },
      });
      if (!existing) {
        return { ok: false, reason: "empty_instructions" } as const;
      }
    }
    const resolved = await resolveContactResearchMutationJob(
      tx,
      target,
      now,
      requestedShowId
    );
    if (!resolved.ok) return resolved;
    const { job } = resolved;
    const status = job.status === "claimed" ? "pending" : job.status;
    await tx.contactResearchJob.update({
      where: { id: job.id },
      data: {
        userNotes,
        ...(job.status === "claimed"
          ? {
              status,
              claimToken: null,
              claimedAt: null,
              claimExpiresAt: null,
            }
          : {}),
      },
    });
    return { ok: true, jobId: job.id, status };
  });
}

async function skipContactResearchTarget(
  target: ContactResearchMutationTarget,
  value: unknown,
  now: Date,
  requestedShowId: string | null,
  runTransaction: ContactResearchTransactionRunner
): Promise<ArtistContactResearchMutationResult> {
  const reason = normalizeArtistResearchSkipReason(value);
  return runTransaction(async (tx) => {
    const resolved = await resolveContactResearchMutationJob(
      tx,
      target,
      now,
      requestedShowId
    );
    if (!resolved.ok) return resolved;
    const { job } = resolved;
    const activeSkip = await tx.artistResearchSkip.findFirst({
      where: { artistId: job.artistId, clearedAt: null },
      select: { id: true },
    });
    if (activeSkip) {
      return { ok: false, reason: "already_skipped" } as const;
    }
    await tx.artistResearchSkip.create({
      data: {
        artistId: job.artistId,
        source: "manual",
        reason,
        setAt: now,
      },
    });
    await tx.contactResearchJob.update({
      where: { id: job.id },
      data: {
        status: "skipped",
        claimToken: null,
        claimedAt: null,
        claimExpiresAt: null,
        completedAt: null,
      },
    });
    return { ok: true, jobId: job.id, status: "skipped" };
  });
}

async function unskipContactResearchTarget(
  target: ContactResearchMutationTarget,
  now: Date,
  requestedShowId: string | null,
  runTransaction: ContactResearchTransactionRunner
): Promise<ArtistContactResearchMutationResult> {
  const today = easternTodayStoredDate(now);
  const end = parseDateOnly(
    addDateOnlyDays(easternDateOnly(now), CONTACT_RESEARCH_WINDOW_DAYS)
  );
  return runTransaction(async (tx) => {
    const job = await tx.contactResearchJob.findUnique({
      where:
        "artistId" in target
          ? { artistId: target.artistId }
          : { id: target.jobId },
      select: {
        id: true,
        artistId: true,
        status: true,
        requestedShowId: true,
        artist: {
          select: {
            contacts: {
              where: ACTIVE_EMAIL_CONTACT_WHERE,
              take: 1,
              select: { id: true },
            },
          },
        },
      },
    });
    if (!job) return { ok: false, reason: "job_not_found" } as const;
    const activeSkip = await tx.artistResearchSkip.findFirst({
      where: { artistId: job.artistId, clearedAt: null },
      select: { id: true },
    });
    if (!activeSkip) {
      return { ok: false, reason: "not_skipped" } as const;
    }

    const hasActiveContact = job.artist.contacts.length > 0;
    if (hasActiveContact) {
      return { ok: false, reason: "active_contact" } as const;
    }
    const suppliedRequestedShowId =
      "artistId" in target ? requestedShowId : null;
    const jobArtistId = job.artistId;

    async function eligibleFestival(showId: string) {
      return tx.showArtist.findFirst({
        where: {
          artistId: jobArtistId,
          showId,
          show: {
            isFestival: true,
            syncStatus: "active",
            date: { gte: today },
            AND: [festivalLeadTimeWhere(now)],
          },
        },
        select: { showId: true },
      });
    }

    const eligibleStoredRequestedShow = job.requestedShowId
      ? await eligibleFestival(job.requestedShowId)
      : null;
    const eligibleSuppliedRequestedShow =
      suppliedRequestedShowId
        ? suppliedRequestedShowId === job.requestedShowId
          ? eligibleStoredRequestedShow
          : await eligibleFestival(suppliedRequestedShowId)
        : null;
    if (suppliedRequestedShowId && !eligibleSuppliedRequestedShow) {
      return { ok: false, reason: "ineligible" } as const;
    }
    const restoredRequestedShowId = eligibleStoredRequestedShow
      ? job.requestedShowId
      : eligibleSuppliedRequestedShow
        ? suppliedRequestedShowId
        : null;

    const eligibleRegularShow =
      restoredRequestedShowId || suppliedRequestedShowId
        ? null
        : await tx.showArtist.findFirst({
          where: {
            artistId: job.artistId,
            show: {
              isFestival: false,
              syncStatus: "active",
              date: { gte: today, lte: end },
            },
          },
          select: { showId: true },
        });
    if (!restoredRequestedShowId && !eligibleRegularShow) {
      return { ok: false, reason: "ineligible" } as const;
    }

    if (
      restoredRequestedShowId &&
      restoredRequestedShowId !== job.requestedShowId
    ) {
      await tx.contactResearchJob.update({
        where: { id: job.id },
        data: { requestedShowId: restoredRequestedShowId },
      });
    }
    await tx.artistResearchSkip.update({
      where: { id: activeSkip.id },
      data: {
        clearedAt: now,
        clearedBy: "manual",
      },
    });
    await tx.contactResearchJob.update({
      where: { id: job.id },
      data: {
        status: "pending",
        completedAt: null,
        claimToken: null,
        claimedAt: null,
        claimExpiresAt: null,
      },
    });
    return {
      ok: true,
      jobId: job.id,
      status: "pending",
    };
  });
}

export async function updateContactResearchArtistUserNotes(
  artistId: string,
  value: unknown,
  options: {
    now?: Date;
    requestedShowId?: string | null;
    runTransaction?: ContactResearchTransactionRunner;
  } = {}
): Promise<ArtistContactResearchMutationResult> {
  return updateContactResearchUserNotes(
    { artistId },
    value,
    options.now ?? new Date(),
    options.requestedShowId ?? null,
    options.runTransaction ?? ((work) => withSerializableRetry(work))
  );
}

export async function skipContactResearchArtistByArtistId(
  artistId: string,
  value: unknown,
  options: {
    now?: Date;
    requestedShowId?: string | null;
    runTransaction?: ContactResearchTransactionRunner;
  } = {}
): Promise<ArtistContactResearchMutationResult> {
  return skipContactResearchTarget(
    { artistId },
    value,
    options.now ?? new Date(),
    options.requestedShowId ?? null,
    options.runTransaction ?? ((work) => withSerializableRetry(work))
  );
}

export async function unskipContactResearchArtistByArtistId(
  artistId: string,
  options: {
    now?: Date;
    requestedShowId?: string | null;
    runTransaction?: ContactResearchTransactionRunner;
  } = {}
): Promise<ArtistContactResearchMutationResult> {
  return unskipContactResearchTarget(
    { artistId },
    options.now ?? new Date(),
    options.requestedShowId ?? null,
    options.runTransaction ?? ((work) => withSerializableRetry(work))
  );
}

export async function retryContactResearchJob(
  jobId: string,
  now: Date = new Date(),
  runTransaction: ContactResearchTransactionRunner = (work) =>
    withSerializableRetry(work)
): Promise<boolean> {
  return (
    (await retryEligibleContactResearchJobs(
      Prisma.sql`job."id" = ${jobId}
        AND job."status" IN ('exhausted', 'review')`,
      now,
      runTransaction,
      [jobId]
    )) === 1
  );
}

export type ContactResearchCleanupStatus =
  | "pending"
  | "review"
  | "complete"
  | "skipped"
  | "inactive";

export function contactResearchCleanupStatus(input: {
  hasActiveSkip: boolean;
  hasPendingCandidate: boolean;
  hasPendingDirectOutreach: boolean;
  hasDirectOutreachHistory: boolean;
  hasActiveEmailContact: boolean;
  hasEffectiveApproval: boolean;
  eligible: boolean;
}): ContactResearchCleanupStatus {
  if (input.hasActiveSkip) return "skipped";
  if (
    input.hasPendingCandidate ||
    input.hasPendingDirectOutreach
  ) {
    return "review";
  }
  if (input.hasActiveEmailContact || input.hasEffectiveApproval) {
    return "complete";
  }
  if (input.hasDirectOutreachHistory) return "review";
  return input.eligible ? "pending" : "inactive";
}

export async function reconcileContactResearchJobAfterProbeCleanup(
  tx: Prisma.TransactionClient,
  jobId: string,
  now: Date
): Promise<ContactResearchCleanupStatus> {
  const job = await tx.contactResearchJob.findUnique({
    where: { id: jobId },
    select: {
      artistId: true,
      requestedShowId: true,
      artist: {
        select: {
          contacts: {
            where: ACTIVE_EMAIL_CONTACT_WHERE,
            select: { email: true, state: true },
          },
          researchSkips: {
            where: { clearedAt: null },
            take: 1,
            select: { id: true },
          },
        },
      },
      candidates: {
        where: { status: { in: ["pending", "approved"] } },
        select: { status: true, normalizedEmail: true },
      },
      directOutreachProposals: {
        select: { status: true },
      },
    },
  });
  if (!job) {
    throw new Error(`Contact research job ${jobId} no longer exists`);
  }
  const today = easternTodayStoredDate(now);
  const end = parseDateOnly(
    addDateOnlyDays(easternDateOnly(now), CONTACT_RESEARCH_WINDOW_DAYS)
  );
  const eligibleShow = await tx.showArtist.findFirst({
    where: {
      artistId: job.artistId,
      show: {
        date: { gte: today },
        syncStatus: "active",
        AND: [festivalLeadTimeWhere(now)],
        OR: [
          {
            isFestival: false,
            date: { lte: end },
          },
          ...(job.requestedShowId
            ? [{ id: job.requestedShowId }]
            : []),
        ],
      },
    },
    select: { showId: true },
  });
  const hasEffectiveApproval = job.candidates.some(
    (candidate) =>
      candidate.status === "approved" &&
      isContactResearchApprovalEffective(
        candidate.normalizedEmail,
        job.artist.contacts
      )
  );
  const status = contactResearchCleanupStatus({
    hasActiveSkip: job.artist.researchSkips.length > 0,
    hasPendingCandidate: job.candidates.some(
      (candidate) => candidate.status === "pending"
    ),
    hasPendingDirectOutreach: job.directOutreachProposals.some(
      (proposal) => proposal.status === "pending"
    ),
    hasDirectOutreachHistory: job.directOutreachProposals.length > 0,
    hasActiveEmailContact: job.artist.contacts.length > 0,
    hasEffectiveApproval,
    eligible: eligibleShow !== null,
  });
  await tx.contactResearchJob.update({
    where: { id: jobId },
    data: {
      status,
      completedAt: status === "complete" ? now : null,
      claimToken: null,
      claimedAt: null,
      claimExpiresAt: null,
    },
  });
  return status;
}

type ContactResearchRetryEligibilityReason =
  | "eligible"
  | ContactResearchRetrySkipReason;

interface ContactResearchRetryEligibilityRow {
  id: string;
  reason: ContactResearchRetryEligibilityReason;
}

interface ContactResearchRetryTarget {
  id: string;
  artistId: string;
}

function contactResearchRetryEligibilityRowsSql(
  status: "exhausted" | "review",
  now: Date,
  jobIds?: readonly string[]
): Prisma.Sql {
  const today = easternTodayStoredDate(now);
  const end = parseDateOnly(
    addDateOnlyDays(easternDateOnly(now), CONTACT_RESEARCH_WINDOW_DAYS)
  );
  const scope = jobIds
    ? jobIds.length > 0
      ? Prisma.sql`job."id" IN (${Prisma.join([...jobIds])})`
      : Prisma.sql`FALSE`
    : Prisma.sql`job."status" = ${status}`;
  return Prisma.sql`
    SELECT
      job."id",
      CASE
        WHEN job."status" <> ${status} THEN 'status_changed'
        WHEN EXISTS (
          SELECT 1
          FROM "ContactResearchCandidate" candidate
          JOIN "Contact" approved_contact
            ON approved_contact."artistId" = job."artistId"
           AND approved_contact."state" = 'active'
           AND approved_contact."email" IS NOT NULL
           AND LOWER(BTRIM(approved_contact."email"))
             = candidate."normalizedEmail"
          WHERE candidate."jobId" = job."id"
            AND candidate."status" = 'approved'
        ) THEN 'effective_approval'
        WHEN EXISTS (
          SELECT 1
          FROM "Contact" contact
          WHERE contact."artistId" = job."artistId"
            AND contact."state" = 'active'
            AND contact."email" IS NOT NULL
        ) THEN 'active_contact'
        WHEN EXISTS (
          SELECT 1
          FROM "ArtistResearchSkip" research_skip
          WHERE research_skip."artistId" = job."artistId"
            AND research_skip."clearedAt" IS NULL
        ) THEN 'intentional_skip'
        WHEN EXISTS (
          SELECT 1
          FROM "ContactResearchDirectOutreachProposal" direct_outreach
          WHERE direct_outreach."jobId" = job."id"
            AND direct_outreach."status" = 'pending'
        ) THEN 'pending_direct_outreach'
        WHEN NOT EXISTS (
          SELECT 1
          FROM "ShowArtist" show_artist
          JOIN "Show" show
            ON show."id" = show_artist."showId"
          WHERE show_artist."artistId" = job."artistId"
            AND show."date" >= ${today}
            AND show."syncStatus" = 'active'
            AND ${festivalLeadTimeSql(now)}
            AND (
              (
                show."isFestival" = false
                AND show."date" <= ${end}
              )
              OR (
                show."isFestival" = true
                AND job."requestedShowId" = show."id"
              )
            )
        ) THEN 'no_eligible_show'
        ELSE 'eligible'
      END AS "reason"
    FROM "ContactResearchJob" job
    WHERE ${scope}
  `;
}

function emptyContactResearchRetrySkipped(): Record<
  ContactResearchRetrySkipReason,
  number
> {
  return Object.fromEntries(
    CONTACT_RESEARCH_RETRY_SKIP_REASONS.map((reason) => [reason, 0])
  ) as Record<ContactResearchRetrySkipReason, number>;
}

function addContactResearchRetrySkip(
  skipped: Record<ContactResearchRetrySkipReason, number>,
  reason: ContactResearchRetryEligibilityReason
): void {
  if (reason === "eligible") return;
  skipped[reason] += 1;
}

async function lockContactResearchRetryTargets(
  tx: Prisma.TransactionClient,
  status: "exhausted" | "review"
): Promise<ContactResearchRetryTarget[]> {
  const targets = await tx.$queryRaw<ContactResearchRetryTarget[]>(Prisma.sql`
    SELECT job."id", job."artistId"
    FROM "ContactResearchJob" job
    WHERE job."status" = ${status}
    ORDER BY job."id"
    FOR UPDATE
  `);
  if (targets.length === 0) return [];
  const jobIds = targets.map((target) => target.id);
  const artistIds = Array.from(
    new Set(targets.map((target) => target.artistId))
  );
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT artist."id"
    FROM "Artist" artist
    WHERE artist."id" IN (${Prisma.join(artistIds)})
    ORDER BY artist."id"
    FOR UPDATE
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT contact."id"
    FROM "Contact" contact
    WHERE contact."artistId" IN (${Prisma.join(artistIds)})
    ORDER BY contact."id"
    FOR UPDATE
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT research_skip."id"
    FROM "ArtistResearchSkip" research_skip
    WHERE research_skip."artistId" IN (${Prisma.join(artistIds)})
    ORDER BY research_skip."id"
    FOR UPDATE
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT direct_outreach."id"
    FROM "ContactResearchDirectOutreachProposal" direct_outreach
    WHERE direct_outreach."jobId" IN (${Prisma.join(jobIds)})
    ORDER BY direct_outreach."id"
    FOR UPDATE
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT candidate."id"
    FROM "ContactResearchCandidate" candidate
    WHERE candidate."jobId" IN (${Prisma.join(jobIds)})
    ORDER BY candidate."id"
    FOR UPDATE
  `);
  return targets;
}

export async function countRetryableExhaustedContactResearchJobs(
  now: Date = new Date(),
  runQuery: ContactResearchQueryRunner = (query) => db.$queryRaw(query)
): Promise<number> {
  const rows = await runQuery<Array<{ count: number }>>(Prisma.sql`
    SELECT COUNT(*)::integer AS "count"
    FROM (${contactResearchRetryEligibilityRowsSql("exhausted", now)}) retry_eligibility
    WHERE retry_eligibility."reason" = 'eligible'
  `);
  return rows[0]?.count ?? 0;
}

async function retryContactResearchJobsByStatus(
  status: "exhausted" | "review",
  now: Date = new Date(),
  runTransaction: ContactResearchTransactionRunner = (work) =>
    withSerializableRetry(work)
): Promise<number> {
  return retryEligibleContactResearchJobs(
    Prisma.sql`job."status" = ${status}`,
    now,
    runTransaction
  );
}

async function retryEligibleContactResearchJobs(
  statusWhere: Prisma.Sql,
  now: Date,
  runTransaction: ContactResearchTransactionRunner,
  jobIds?: readonly string[]
): Promise<number> {
  const today = easternTodayStoredDate(now);
  const end = parseDateOnly(
    addDateOnlyDays(easternDateOnly(now), CONTACT_RESEARCH_WINDOW_DAYS)
  );
  return runTransaction(async (tx) => {
    await supersedeObsoleteContactResearchApprovals(
      tx,
      jobIds ? { jobIds } : {}
    );
    return tx.$executeRaw(Prisma.sql`
      UPDATE "ContactResearchJob" AS job
      SET
        "status" = 'pending',
        "completedAt" = NULL,
        "claimToken" = NULL,
        "claimedAt" = NULL,
        "claimExpiresAt" = NULL,
        "updatedAt" = ${now}
      WHERE ${statusWhere}
      AND NOT EXISTS (
        SELECT 1
        FROM "Contact" contact
        WHERE contact."artistId" = job."artistId"
          AND contact."state" = 'active'
          AND contact."email" IS NOT NULL
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "ArtistResearchSkip" research_skip
        WHERE research_skip."artistId" = job."artistId"
          AND research_skip."clearedAt" IS NULL
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "ContactResearchDirectOutreachProposal" direct_outreach
        WHERE direct_outreach."jobId" = job."id"
          AND direct_outreach."status" = 'pending'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "ContactResearchCandidate" candidate
        JOIN "Contact" approved_contact
          ON approved_contact."artistId" = job."artistId"
         AND approved_contact."state" = 'active'
         AND approved_contact."email" IS NOT NULL
         AND LOWER(BTRIM(approved_contact."email"))
           = candidate."normalizedEmail"
        WHERE candidate."jobId" = job."id"
          AND candidate."status" = 'approved'
      )
      AND (
        job."status" <> 'review'
        OR NOT EXISTS (
          SELECT 1
          FROM "ContactResearchCandidate" candidate_history
          WHERE candidate_history."jobId" = job."id"
            AND candidate_history."status" = 'superseded'
        )
      )
      AND EXISTS (
        SELECT 1
        FROM "ShowArtist" show_artist
        JOIN "Show" show
          ON show."id" = show_artist."showId"
        WHERE show_artist."artistId" = job."artistId"
          AND show."date" >= ${today}
          AND show."syncStatus" = 'active'
          AND ${festivalLeadTimeSql(now)}
          AND (
            (
              show."isFestival" = false
              AND show."date" <= ${end}
            )
            OR (
              show."isFestival" = true
              AND job."requestedShowId" = show."id"
            )
          )
      )
    `);
  });
}

export async function retryAllExhaustedContactResearchJobs(
  now: Date = new Date(),
  runTransaction: ContactResearchTransactionRunner = (work) =>
    withSerializableRetry(work)
): Promise<ContactResearchBulkRetryResult> {
  return runTransaction(async (tx) => {
    const targets = await lockContactResearchRetryTargets(tx, "exhausted");
    if (targets.length === 0) {
      return {
        requeued: 0,
        skipped: emptyContactResearchRetrySkipped(),
      };
    }
    const initialRows =
      await tx.$queryRaw<ContactResearchRetryEligibilityRow[]>(
        contactResearchRetryEligibilityRowsSql(
          "exhausted",
          now,
          targets.map((target) => target.id)
        )
      );
    const skipped = emptyContactResearchRetrySkipped();
    const eligibleIds: string[] = [];
    for (const row of initialRows) {
      if (row.reason === "eligible") {
        eligibleIds.push(row.id);
      } else {
        addContactResearchRetrySkip(skipped, row.reason);
      }
    }
    if (eligibleIds.length === 0) {
      return { requeued: 0, skipped };
    }

    await supersedeObsoleteContactResearchApprovals(tx, {
      jobIds: eligibleIds,
    });
    const requeuedRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      WITH retry_eligibility AS (
        ${contactResearchRetryEligibilityRowsSql(
          "exhausted",
          now,
          eligibleIds
        )}
      )
      UPDATE "ContactResearchJob" AS job
      SET
        "status" = 'pending',
        "completedAt" = NULL,
        "claimToken" = NULL,
        "claimedAt" = NULL,
        "claimExpiresAt" = NULL,
        "updatedAt" = ${now}
      FROM retry_eligibility
      WHERE job."id" = retry_eligibility."id"
        AND retry_eligibility."reason" = 'eligible'
      RETURNING job."id"
    `);
    const requeuedIds = new Set(requeuedRows.map((row) => row.id));
    const remainingIds = eligibleIds.filter((id) => !requeuedIds.has(id));
    if (remainingIds.length > 0) {
      const remainingRows =
        await tx.$queryRaw<ContactResearchRetryEligibilityRow[]>(
          contactResearchRetryEligibilityRowsSql(
            "exhausted",
            now,
            remainingIds
          )
        );
      const remainingById = new Map(
        remainingRows.map((row) => [row.id, row.reason])
      );
      for (const id of remainingIds) {
        addContactResearchRetrySkip(
          skipped,
          remainingById.get(id) ?? "status_changed"
        );
      }
    }
    return {
      requeued: requeuedRows.length,
      skipped,
    };
  });
}

export function retryAllReviewContactResearchJobs(
  now: Date = new Date(),
  runTransaction?: ContactResearchTransactionRunner
): Promise<number> {
  return retryContactResearchJobsByStatus("review", now, runTransaction);
}
