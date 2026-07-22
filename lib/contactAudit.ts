import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
} from "jose";
import { db } from "@/lib/db";
import {
  type AgentMutationEnvironment,
  isValidAgentMutationAuthorization,
} from "@/lib/agentMutationAuthorization";
import { validateAuditSubmissionPayload } from "@/lib/contactAgentPayloadValidation.mjs";
import {
  normalizeManagerRole,
  normalizeResearchEmail,
  normalizeResearchSourceUrl,
} from "@/lib/contactResearch";
import {
  AuditedContactSheetPostWriteError,
  recoverAuditedContactSheetPostWriteError,
  rollbackAuditedContactInSheet,
  updateAuditedContactInSheet,
} from "@/lib/sheets";
import {
  contactAuditResolutionEligibility,
  contactAuditResolutionClaimStaleBefore,
  contactStillMatchesAuditSnapshot,
} from "@/lib/contactAuditResolutionPolicy";
import { CLEAR_AGENT_DIRECT_OUTREACH_PROVENANCE } from "@/lib/directOutreachProvenance";

export { contactStillMatchesAuditSnapshot } from "@/lib/contactAuditResolutionPolicy";

export const CONTACT_AUDIT_DEFAULT_CLAIM_LIMIT = 1;
export const CONTACT_AUDIT_MAX_CLAIM_LIMIT = 10;
export const CONTACT_AUDIT_CLAIM_TTL_MS = 60 * 60 * 1_000;
export const CONTACT_AUDIT_OIDC_AUDIENCE = "photo-admin-contact-audit";
export const CONTACT_AUDIT_OIDC_ISSUER =
  "https://token.actions.githubusercontent.com";
export const CONTACT_AUDIT_WORKFLOW_REF =
  "zspherez/photo-admin/.github/workflows/contact-audit.yml@refs/heads/main";
export const CONTACT_AUDIT_REQUEST_ACTIVE_STATUSES = [
  "pending",
  "running",
] as const;

const CONFIDENCE_VALUES = new Set(["high", "medium", "low"]);
const FINDING_VALUES = new Set([
  "current",
  "changed",
  "stale",
  "ambiguous",
  "unverified",
]);
const githubActionsJwks = createRemoteJWKSet(
  new URL(`${CONTACT_AUDIT_OIDC_ISSUER}/.well-known/jwks`)
);

type ContactAuditConfidence = "high" | "medium" | "low";
export type ContactAuditFinding =
  | "current"
  | "changed"
  | "stale"
  | "ambiguous"
  | "unverified";
export type ContactAuditResolution = "approved" | "rejected";

export interface ContactAuditResolutionResult {
  ok: boolean;
  status?: "resolved" | "already_resolved";
  resolution?: ContactAuditResolution;
  error?: string;
}

export interface ContactAuditRequestResult {
  id: string;
  status: string;
  requestedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  runId: string | null;
  attemptCount: number;
  lastAttemptAt: Date | null;
  lastWorkflowRunId: string | null;
  lastError: string | null;
  created: boolean;
}

export interface ContactAuditAlternativeInput {
  email: string;
  normalizedEmail: string;
  name: string | null;
  role: "management";
  sourceUrls: string[];
  evidence: string;
  confidence: ContactAuditConfidence;
}

export interface ContactAuditSubmission {
  claimToken: string;
  finding: ContactAuditFinding;
  sourceUrls: string[];
  evidence: string;
  confidence: ContactAuditConfidence;
  notes: string | null;
  alternatives: ContactAuditAlternativeInput[];
  rosterReview: ContactAuditRosterReviewInput[];
}

export interface ContactAuditRosterReviewInput {
  rosterEntryId: string;
  assessment:
    | "current"
    | "stale"
    | "coexisting"
    | "conflicting"
    | "unverified";
  notes: string;
}

export interface ContactAuditRosterPayload {
  snapshotId: string | null;
  snapshotAt: Date | null;
  completeness: "complete" | "legacy_single_contact";
  contacts: Array<{
    rosterEntryId: string;
    contactId: string | null;
    isTarget: boolean;
    email: string | null;
    phone: string | null;
    directOutreachNote: string | null;
    name: string | null;
    role: string | null;
    source: string | null;
    notes: string | null;
    isFullTeam: boolean | null;
  }>;
}

export class ContactAuditValidationError extends Error {}

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

function parseSourceUrls(
  value: unknown,
  field: string,
  maximum: number
): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} needs at least one source URL`);
  }
  if (value.length > maximum) {
    throw new Error(`${field} may have at most ${maximum} source URLs`);
  }
  return Array.from(new Set(value.map(normalizeResearchSourceUrl)));
}

export function parseContactAuditClaimLimit(value: unknown): number {
  if (value == null) return CONTACT_AUDIT_DEFAULT_CLAIM_LIMIT;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > CONTACT_AUDIT_MAX_CLAIM_LIMIT
  ) {
    throw new Error(
      `limit must be an integer from 1 to ${CONTACT_AUDIT_MAX_CLAIM_LIMIT}`
    );
  }
  return value;
}

export function parseContactAuditSubmission(
  value: unknown,
  existingEmail?: string | null,
  requiredRosterEntryIds?: readonly string[]
): ContactAuditSubmission {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("request body must be an object");
  }
  const input = value as Record<string, unknown>;
  const claimToken = requiredString(input.claimToken, 200, "claimToken");
  const finding = requiredString(input.finding, 20, "finding");
  if (!FINDING_VALUES.has(finding)) {
    throw new Error(
      "finding must be current, changed, stale, ambiguous, or unverified"
    );
  }
  const confidence = requiredString(input.confidence, 20, "confidence");
  if (!CONFIDENCE_VALUES.has(confidence)) {
    throw new Error("confidence must be high, medium, or low");
  }
  const sourceUrls = parseSourceUrls(input.sourceUrls, "result", 10);
  const alternativeValues = input.alternatives ?? [];
  if (!Array.isArray(alternativeValues)) {
    throw new Error("alternatives must be an array");
  }
  if (alternativeValues.length > 10) {
    throw new Error("at most 10 alternative contacts may be submitted");
  }

  const normalizedExistingEmail = existingEmail?.trim().toLowerCase() ?? null;
  const alternativesByEmail = new Map<
    string,
    ContactAuditAlternativeInput
  >();
  for (const alternativeValue of alternativeValues) {
    if (
      typeof alternativeValue !== "object" ||
      alternativeValue === null ||
      Array.isArray(alternativeValue)
    ) {
      throw new Error("each alternative must be an object");
    }
    const alternative = alternativeValue as Record<string, unknown>;
    const normalizedEmail = normalizeResearchEmail(alternative.email);
    if (normalizedEmail === normalizedExistingEmail) {
      throw new Error("an alternative must differ from the audited email");
    }
    const alternativeConfidence = requiredString(
      alternative.confidence,
      20,
      "alternative confidence"
    );
    if (!CONFIDENCE_VALUES.has(alternativeConfidence)) {
      throw new Error(
        "alternative confidence must be high, medium, or low"
      );
    }
    alternativesByEmail.set(normalizedEmail, {
      email: normalizedEmail,
      normalizedEmail,
      name: optionalString(alternative.name, 200, "alternative name"),
      role: normalizeManagerRole(alternative.role),
      sourceUrls: parseSourceUrls(
        alternative.sourceUrls,
        "alternative",
        5
      ),
      evidence: requiredString(
        alternative.evidence,
        4_000,
        "alternative evidence"
      ),
      confidence: alternativeConfidence as ContactAuditConfidence,
    });
  }
  const alternatives = [...alternativesByEmail.values()];
  if (finding === "current" && alternatives.length > 0) {
    throw new Error(
      "a current contact cannot include plausible alternatives; use ambiguous"
    );
  }
  if (finding === "stale" && alternatives.length > 0) {
    throw new Error("a stale finding cannot include alternative contacts");
  }
  if (finding === "changed" && alternatives.length === 0) {
    throw new Error("changed findings require an alternative contact");
  }

  const rosterReviewValues = input.rosterReview ?? [];
  if (!Array.isArray(rosterReviewValues)) {
    throw new Error("rosterReview must be an array");
  }
  const rosterReviewById = new Map<string, ContactAuditRosterReviewInput>();
  for (const reviewValue of rosterReviewValues) {
    if (
      typeof reviewValue !== "object" ||
      reviewValue === null ||
      Array.isArray(reviewValue)
    ) {
      throw new Error("each roster review must be an object");
    }
    const review = reviewValue as Record<string, unknown>;
    const rosterEntryId = requiredString(
      review.rosterEntryId,
      100,
      "roster review entry id"
    );
    const assessment = requiredString(
      review.assessment,
      20,
      "roster review assessment"
    );
    if (
      ![
        "current",
        "stale",
        "coexisting",
        "conflicting",
        "unverified",
      ].includes(assessment)
    ) {
      throw new Error(
        "roster review assessment must be current, stale, coexisting, conflicting, or unverified"
      );
    }
    if (rosterReviewById.has(rosterEntryId)) {
      throw new Error("each roster contact must be reviewed exactly once");
    }
    rosterReviewById.set(rosterEntryId, {
      rosterEntryId,
      assessment: assessment as ContactAuditRosterReviewInput["assessment"],
      notes: requiredString(review.notes, 1_000, "roster review notes"),
    });
  }
  if (requiredRosterEntryIds?.length) {
    const requiredIds = new Set(requiredRosterEntryIds);
    if (
      rosterReviewById.size !== requiredIds.size ||
      [...rosterReviewById.keys()].some((id) => !requiredIds.has(id))
    ) {
      throw new Error(
        "rosterReview must inventory every snapshotted artist contact exactly once"
      );
    }
  }

  const submission: ContactAuditSubmission = {
    claimToken,
    finding: finding as ContactAuditFinding,
    sourceUrls,
    evidence: requiredString(input.evidence, 4_000, "evidence"),
    confidence: confidence as ContactAuditConfidence,
    notes: optionalString(input.notes, 4_000, "notes"),
    alternatives,
    rosterReview: [...rosterReviewById.values()],
  };
  validateAuditSubmissionPayload(value);
  return submission;
}

export function validateContactAuditAlternativeEmails(
  alternatives: readonly Pick<ContactAuditAlternativeInput, "normalizedEmail">[],
  storedEmails: readonly (string | null | undefined)[]
): void {
  const normalizedStoredEmails = new Set(
    storedEmails.flatMap((email) => {
      const normalized = email?.trim().toLowerCase();
      return normalized ? [normalized] : [];
    })
  );
  const duplicate = alternatives.find((alternative) =>
    normalizedStoredEmails.has(alternative.normalizedEmail)
  );
  if (duplicate) {
    throw new ContactAuditValidationError(
      `${duplicate.normalizedEmail} is already stored as a contact for this artist. Existing roster contacts must remain separate and cannot be proposed as replacements.`
    );
  }
}

export function buildContactAuditRosterPayload(job: {
  id: string;
  contactId: string | null;
  targetRosterEntryId: string | null;
  snapshotEmail: string | null;
  snapshotPhone: string | null;
  snapshotDirectOutreachNote: string | null;
  snapshotName: string | null;
  snapshotRole: string | null;
  snapshotSource: string | null;
  snapshotNotes: string | null;
  snapshotIsFullTeam: boolean | null;
  rosterSnapshot: {
    id: string;
    createdAt: Date;
    entries: Array<{
      id: string;
      snapshotContactId: string;
      snapshotEmail: string | null;
      snapshotPhone: string | null;
      snapshotDirectOutreachNote: string | null;
      snapshotName: string | null;
      snapshotRole: string | null;
      snapshotSource: string | null;
      snapshotNotes: string | null;
      snapshotIsFullTeam: boolean;
    }>;
  } | null;
}): ContactAuditRosterPayload {
  if (
    job.rosterSnapshot &&
    job.targetRosterEntryId &&
    job.rosterSnapshot.entries.some(
      (entry) => entry.id === job.targetRosterEntryId
    )
  ) {
    return {
      snapshotId: job.rosterSnapshot.id,
      snapshotAt: job.rosterSnapshot.createdAt,
      completeness: "complete",
      contacts: job.rosterSnapshot.entries.map((entry) => ({
        rosterEntryId: entry.id,
        contactId: entry.snapshotContactId,
        isTarget: entry.id === job.targetRosterEntryId,
        email: entry.snapshotEmail,
        phone: entry.snapshotPhone,
        directOutreachNote: entry.snapshotDirectOutreachNote,
        name: entry.snapshotName,
        role: entry.snapshotRole,
        source: entry.snapshotSource,
        notes: entry.snapshotNotes,
        isFullTeam: entry.snapshotIsFullTeam,
      })),
    };
  }
  return {
    snapshotId: null,
    snapshotAt: null,
    completeness: "legacy_single_contact",
    contacts: [
      {
        rosterEntryId: `legacy-${job.id}`,
        contactId: job.contactId,
        isTarget: true,
        email: job.snapshotEmail,
        phone: job.snapshotPhone,
        directOutreachNote: job.snapshotDirectOutreachNote,
        name: job.snapshotName,
        role: job.snapshotRole,
        source: job.snapshotSource,
        notes: job.snapshotNotes,
        isFullTeam: job.snapshotIsFullTeam,
      },
    ],
  };
}

interface ContactAuditAuthorizationOptions {
  environment?: AgentMutationEnvironment;
  staticToken?: string;
  verifyGithubActionsToken?: (token: string) => Promise<boolean>;
}

function isContactAuditAuthorizationOptions(
  value:
    | ContactAuditAuthorizationOptions
    | string
    | readonly (string | undefined)[]
): value is ContactAuditAuthorizationOptions {
  return typeof value === "object" && !Array.isArray(value);
}

export async function isValidContactAuditAuthorization(
  authorization: string | null,
  optionsOrStaticToken:
    | ContactAuditAuthorizationOptions
    | string
    | readonly (string | undefined)[] = {},
  legacyVerifier?: (token: string) => Promise<boolean>
): Promise<boolean> {
  const hasOptions = isContactAuditAuthorizationOptions(optionsOrStaticToken);
  const options = hasOptions ? optionsOrStaticToken : undefined;
  const staticSecrets = hasOptions
    ? optionsOrStaticToken.staticToken ?? process.env.CONTACT_AUDIT_AGENT_TOKEN
    : optionsOrStaticToken;
  return isValidAgentMutationAuthorization(authorization, {
    environment: options?.environment,
    staticSecrets,
    verifyOidcToken:
      options?.verifyGithubActionsToken ??
      legacyVerifier ??
      verifyGithubActionsContactAuditToken,
  });
}

export function isTrustedContactAuditOidcClaims(
  payload: JWTPayload
): boolean {
  return (
    payload.aud === CONTACT_AUDIT_OIDC_AUDIENCE &&
    payload.repository === "zspherez/photo-admin" &&
    payload.repository_owner === "zspherez" &&
    payload.ref === "refs/heads/main" &&
    payload.workflow_ref === CONTACT_AUDIT_WORKFLOW_REF &&
    (payload.event_name === "workflow_dispatch" ||
      payload.event_name === "schedule")
  );
}

export type ContactAuditOidcEventName = "workflow_dispatch" | "schedule";

function contactAuditOidcEventName(
  payload: JWTPayload
): ContactAuditOidcEventName | null {
  if (!isTrustedContactAuditOidcClaims(payload)) return null;
  return payload.event_name as ContactAuditOidcEventName;
}

async function verifyGithubActionsContactAuditEvent(
  token: string
): Promise<ContactAuditOidcEventName | null> {
  if (token.split(".").length !== 3) return null;
  try {
    const { payload } = await jwtVerify(token, githubActionsJwks, {
      issuer: CONTACT_AUDIT_OIDC_ISSUER,
      audience: CONTACT_AUDIT_OIDC_AUDIENCE,
      maxTokenAge: "10m",
    });
    return contactAuditOidcEventName(payload);
  } catch {
    return null;
  }
}

export async function getTrustedContactAuditOidcEvent(
  authorization: string | null,
  verifyEvent: (
    token: string
  ) => Promise<ContactAuditOidcEventName | null> =
    verifyGithubActionsContactAuditEvent
): Promise<ContactAuditOidcEventName | null> {
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length);
  return token ? verifyEvent(token) : null;
}

export async function verifyGithubActionsContactAuditToken(
  token: string
): Promise<boolean> {
  return (await verifyGithubActionsContactAuditEvent(token)) !== null;
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

function normalizeWorkflowRunId(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value)) {
    throw new ContactAuditValidationError(
      "workflowRunId must be a GitHub Actions run id"
    );
  }
  return value;
}

function contactAuditRequestSelect() {
  return {
    id: true,
    status: true,
    requestedAt: true,
    startedAt: true,
    completedAt: true,
    runId: true,
    attemptCount: true,
    lastAttemptAt: true,
    lastWorkflowRunId: true,
    lastError: true,
  } as const;
}

async function adoptLegacyContactAuditRun(
  tx: Prisma.TransactionClient
): Promise<boolean> {
  const legacyRun = await tx.contactAuditRun.findFirst({
    where: {
      status: "running",
      request: null,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      createdAt: true,
    },
  });
  if (!legacyRun) return false;
  await tx.contactAuditRequest.create({
    data: {
      id: randomUUID(),
      status: "running",
      requestedAt: legacyRun.createdAt,
      startedAt: legacyRun.createdAt,
      runId: legacyRun.id,
    },
  });
  return true;
}

async function ensureLegacyContactAuditRequest(): Promise<void> {
  await withSerializableRetry(async (tx) => {
    const active = await tx.contactAuditRequest.findFirst({
      where: { status: { in: [...CONTACT_AUDIT_REQUEST_ACTIVE_STATUSES] } },
      select: { id: true },
    });
    if (!active) await adoptLegacyContactAuditRun(tx);
  });
}

export async function requestContactAudit(
  now: Date = new Date()
): Promise<ContactAuditRequestResult> {
  return withSerializableRetry(async (tx) => {
    const existing = await tx.contactAuditRequest.findFirst({
      where: { status: { in: [...CONTACT_AUDIT_REQUEST_ACTIVE_STATUSES] } },
      orderBy: { requestedAt: "asc" },
      select: contactAuditRequestSelect(),
    });
    if (existing) return { ...existing, created: false };

    if (await adoptLegacyContactAuditRun(tx)) {
      const adopted = await tx.contactAuditRequest.findFirstOrThrow({
        where: { status: { in: [...CONTACT_AUDIT_REQUEST_ACTIVE_STATUSES] } },
        orderBy: { requestedAt: "asc" },
        select: contactAuditRequestSelect(),
      });
      return { ...adopted, created: false };
    }

    const created = await tx.contactAuditRequest.create({
      data: {
        id: randomUUID(),
        status: "pending",
        requestedAt: now,
      },
      select: contactAuditRequestSelect(),
    });
    return { ...created, created: true };
  });
}

export async function prepareContactAudit(
  workflowRunIdValue: unknown,
  now: Date = new Date(),
  options: { requestIfMissing?: boolean } = {}
): Promise<{
  requested: boolean;
  requestId: string | null;
  runId: string | null;
  resumed: boolean;
  contactCount: number;
  claimable: number;
}> {
  const workflowRunId = normalizeWorkflowRunId(workflowRunIdValue);
  return withSerializableRetry(async (tx) => {
    let request = await tx.contactAuditRequest.findFirst({
      where: { status: { in: [...CONTACT_AUDIT_REQUEST_ACTIVE_STATUSES] } },
      orderBy: { requestedAt: "asc" },
      select: {
        id: true,
        startedAt: true,
        runId: true,
        run: {
          select: {
            id: true,
            status: true,
            contactCount: true,
            jobs: {
              select: {
                status: true,
                claimExpiresAt: true,
              },
            },
          },
        },
      },
    });
    if (!request && (await adoptLegacyContactAuditRun(tx))) {
      request = await tx.contactAuditRequest.findFirst({
        where: { status: { in: [...CONTACT_AUDIT_REQUEST_ACTIVE_STATUSES] } },
        orderBy: { requestedAt: "asc" },
        select: {
          id: true,
          startedAt: true,
          runId: true,
          run: {
            select: {
              id: true,
              status: true,
              contactCount: true,
              jobs: {
                select: {
                  status: true,
                  claimExpiresAt: true,
                },
              },
            },
          },
        },
      });
    }
    if (!request && options.requestIfMissing) {
      const created = await tx.contactAuditRequest.create({
        data: {
          id: randomUUID(),
          status: "pending",
          requestedAt: now,
        },
        select: {
          id: true,
          startedAt: true,
          runId: true,
        },
      });
      request = { ...created, run: null };
    }
    if (!request) {
      return {
        requested: false,
        requestId: null,
        runId: null,
        resumed: false,
        contactCount: 0,
        claimable: 0,
      };
    }

    if (request.run) {
      const incomplete = request.run.jobs.filter(
        (job) => job.status !== "complete"
      );
      if (incomplete.length > 0) {
        const claimable = incomplete.filter(
          (job) =>
            job.status === "pending" ||
            !job.claimExpiresAt ||
            job.claimExpiresAt <= now
        ).length;
        await tx.contactAuditRequest.update({
          where: { id: request.id },
          data: {
            status: "running",
            startedAt: request.startedAt ?? now,
            attemptCount: { increment: 1 },
            lastAttemptAt: now,
            lastWorkflowRunId: workflowRunId,
            lastError: null,
          },
        });
        return {
          requested: true,
          requestId: request.id,
          runId: request.run.id,
          resumed: true,
          contactCount: request.run.contactCount,
          claimable,
        };
      }
      if (request.run.status !== "complete") {
        await tx.contactAuditRun.update({
          where: { id: request.run.id },
          data: { status: "complete", completedAt: now },
        });
      }
      await tx.contactAuditRequest.update({
        where: { id: request.id },
        data: {
          status: "completed",
          startedAt: request.startedAt ?? now,
          completedAt: now,
          attemptCount: { increment: 1 },
          lastAttemptAt: now,
          lastWorkflowRunId: workflowRunId,
          lastError: null,
        },
      });
      return {
        requested: true,
        requestId: request.id,
        runId: request.run.id,
        resumed: true,
        contactCount: request.run.contactCount,
        claimable: 0,
      };
    }

    const contacts = await tx.contact.findMany({
      where: { state: "active" },
      orderBy: [{ artistId: "asc" }, { id: "asc" }],
      select: {
        id: true,
        artistId: true,
        email: true,
        phone: true,
        directOutreachNote: true,
        name: true,
        role: true,
        source: true,
        notes: true,
        isFullTeam: true,
        artist: { select: { name: true } },
      },
    });
    const runId = randomUUID();
    await tx.contactAuditRun.create({
      data: {
        id: runId,
        status: contacts.length === 0 ? "complete" : "running",
        contactCount: contacts.length,
        completedAt: contacts.length === 0 ? now : null,
      },
    });
    if (contacts.length > 0) {
      const rosterByArtist = new Map<
        string,
        {
          id: string;
          artistName: string;
          entryIdByContactId: Map<string, string>;
        }
      >();
      for (const contact of contacts) {
        if (!rosterByArtist.has(contact.artistId)) {
          rosterByArtist.set(contact.artistId, {
            id: randomUUID(),
            artistName: contact.artist.name,
            entryIdByContactId: new Map(),
          });
        }
        rosterByArtist
          .get(contact.artistId)!
          .entryIdByContactId.set(contact.id, randomUUID());
      }
      await tx.contactAuditRosterSnapshot.createMany({
        data: [...rosterByArtist.entries()].map(([artistId, roster]) => ({
          id: roster.id,
          runId,
          snapshotArtistId: artistId,
          snapshotArtistName: roster.artistName,
          createdAt: now,
        })),
      });
      await tx.contactAuditRosterEntry.createMany({
        data: contacts.map((contact) => {
          const roster = rosterByArtist.get(contact.artistId)!;
          return {
            id: roster.entryIdByContactId.get(contact.id)!,
            rosterSnapshotId: roster.id,
            snapshotContactId: contact.id,
            snapshotEmail: contact.email,
            snapshotPhone: contact.phone,
            snapshotDirectOutreachNote: contact.directOutreachNote,
            snapshotName: contact.name,
            snapshotRole: contact.role,
            snapshotSource: contact.source,
            snapshotNotes: contact.notes,
            snapshotIsFullTeam: contact.isFullTeam,
            createdAt: now,
          };
        }),
      });
      await tx.contactAuditJob.createMany({
        data: contacts.map((contact) => {
          const roster = rosterByArtist.get(contact.artistId)!;
          return {
            id: randomUUID(),
            runId,
            contactId: contact.id,
            artistId: contact.artistId,
            rosterSnapshotId: roster.id,
            targetRosterEntryId: roster.entryIdByContactId.get(contact.id)!,
            snapshotArtistName: contact.artist.name,
            snapshotEmail: contact.email,
            snapshotPhone: contact.phone,
            snapshotDirectOutreachNote: contact.directOutreachNote,
            snapshotName: contact.name,
            snapshotRole: contact.role,
            snapshotSource: contact.source,
            snapshotNotes: contact.notes,
            snapshotIsFullTeam: contact.isFullTeam,
          };
        }),
      });
    }
    await tx.contactAuditRequest.update({
      where: { id: request.id },
      data: {
        status: contacts.length === 0 ? "completed" : "running",
        startedAt: now,
        completedAt: contacts.length === 0 ? now : null,
        runId,
        attemptCount: { increment: 1 },
        lastAttemptAt: now,
        lastWorkflowRunId: workflowRunId,
        lastError: null,
      },
    });
    return {
      requested: true,
      requestId: request.id,
      runId,
      resumed: false,
      contactCount: contacts.length,
      claimable: contacts.length,
    };
  }, { timeout: 30_000 });
}

export async function noteContactAuditPrepareFailure(
  workflowRunIdValue: unknown,
  error: unknown,
  now: Date = new Date()
): Promise<boolean> {
  const workflowRunId = normalizeWorkflowRunId(workflowRunIdValue);
  const message = (
    error instanceof Error ? error.message : String(error)
  ).trim().slice(0, 4_000) || "Contact audit preflight failed";
  return withSerializableRetry(async (tx) => {
    const request = await tx.contactAuditRequest.findFirst({
      where: { status: { in: [...CONTACT_AUDIT_REQUEST_ACTIVE_STATUSES] } },
      orderBy: { requestedAt: "asc" },
      select: { id: true },
    });
    if (!request) return false;
    await tx.contactAuditRequest.update({
      where: { id: request.id },
      data: {
        status: "pending",
        lastAttemptAt: now,
        lastWorkflowRunId: workflowRunId,
        lastError: message,
      },
    });
    return true;
  });
}

export async function recordContactAuditWorkflowFailure(
  runIdValue: unknown,
  workflowRunIdValue: unknown,
  error: unknown,
  now: Date = new Date()
): Promise<boolean> {
  let runId: string;
  let message: string;
  try {
    runId = requiredString(runIdValue, 100, "runId");
    message = requiredString(error, 4_000, "error");
  } catch (caught) {
    throw new ContactAuditValidationError(
      caught instanceof Error ? caught.message : String(caught)
    );
  }
  const workflowRunId = normalizeWorkflowRunId(workflowRunIdValue);
  return withSerializableRetry(async (tx) => {
    const request = await tx.contactAuditRequest.findFirst({
      where: {
        runId,
        status: { in: [...CONTACT_AUDIT_REQUEST_ACTIVE_STATUSES] },
        lastWorkflowRunId: workflowRunId,
      },
      select: { id: true },
    });
    if (!request) return false;
    await tx.contactAuditJob.updateMany({
      where: { runId, status: "claimed" },
      data: {
        status: "pending",
        claimedAt: null,
        claimExpiresAt: null,
        claimToken: null,
      },
    });
    await tx.contactAuditRequest.update({
      where: { id: request.id },
      data: {
        status: "pending",
        lastAttemptAt: now,
        lastError: message,
      },
    });
    return true;
  });
}

export async function claimContactAuditJobs(
  limit: number,
  now: Date = new Date()
) {
  const claimLimit = parseContactAuditClaimLimit(limit);
  const claimExpiresAt = new Date(now.getTime() + CONTACT_AUDIT_CLAIM_TTL_MS);
  await ensureLegacyContactAuditRequest();
  return db.$transaction(
    async (tx) => {
      const selected = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT job."id"
        FROM "ContactAuditJob" job
        JOIN "ContactAuditRun" run ON run."id" = job."runId"
        JOIN "ContactAuditRequest" request ON request."runId" = run."id"
        WHERE run."status" = 'running'
          AND request."status" = 'running'
          AND (
            job."status" = 'pending'
            OR (
              job."status" = 'claimed'
              AND (
                job."claimExpiresAt" IS NULL
                OR job."claimExpiresAt" <= ${now}
              )
            )
          )
        ORDER BY job."createdAt" ASC
        LIMIT ${claimLimit}
        FOR UPDATE OF job SKIP LOCKED
      `);
      const tokenById = new Map<string, string>();
      for (const row of selected) {
        const claimToken = randomUUID();
        tokenById.set(row.id, claimToken);
        await tx.contactAuditJob.update({
          where: { id: row.id },
          data: {
            status: "claimed",
            claimToken,
            claimedAt: now,
            claimExpiresAt,
            attemptCount: { increment: 1 },
          },
        });
      }
      if (selected.length === 0) return [];
      const jobs = await tx.contactAuditJob.findMany({
        where: { id: { in: selected.map((row) => row.id) } },
        select: {
          id: true,
          runId: true,
          contactId: true,
          attemptCount: true,
          targetRosterEntryId: true,
          snapshotArtistName: true,
          snapshotEmail: true,
          snapshotPhone: true,
          snapshotDirectOutreachNote: true,
          snapshotName: true,
          snapshotRole: true,
          snapshotSource: true,
          snapshotNotes: true,
          snapshotIsFullTeam: true,
          rosterSnapshot: {
            select: {
              id: true,
              createdAt: true,
              entries: {
                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                select: {
                  id: true,
                  snapshotContactId: true,
                  snapshotEmail: true,
                  snapshotPhone: true,
                  snapshotDirectOutreachNote: true,
                  snapshotName: true,
                  snapshotRole: true,
                  snapshotSource: true,
                  snapshotNotes: true,
                  snapshotIsFullTeam: true,
                },
              },
            },
          },
        },
      });
      const jobsById = new Map(jobs.map((job) => [job.id, job]));
      return selected.flatMap((row) => {
        const job = jobsById.get(row.id);
        if (!job) return [];
        const contactRoster = buildContactAuditRosterPayload(job);
        return [
          {
            id: job.id,
            runId: job.runId,
            claimToken: tokenById.get(job.id)!,
            claimExpiresAt,
            attemptCount: job.attemptCount,
            contact: {
              artistName: job.snapshotArtistName,
              email: job.snapshotEmail,
              phone: job.snapshotPhone,
              directOutreachNote: job.snapshotDirectOutreachNote,
              name: job.snapshotName,
              role: job.snapshotRole,
              source: job.snapshotSource,
              notes: job.snapshotNotes,
              isFullTeam:
                contactRoster.contacts.find((contact) => contact.isTarget)
                  ?.isFullTeam ?? null,
            },
            contactRoster,
          },
        ];
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
  );
}

export async function submitContactAuditResult(
  jobId: string,
  value: unknown,
  now: Date = new Date()
): Promise<{ accepted: boolean; runComplete: boolean }> {
  await ensureLegacyContactAuditRequest();
  return withSerializableRetry(async (tx) => {
    const job = await tx.contactAuditJob.findFirst({
      where: {
        id: jobId,
        status: "claimed",
        claimExpiresAt: { gt: now },
      },
      select: {
        id: true,
        runId: true,
        claimToken: true,
        artistId: true,
        snapshotEmail: true,
        rosterSnapshot: {
          select: {
            entries: {
              select: {
                id: true,
                snapshotEmail: true,
              },
            },
          },
        },
      },
    });
    if (!job) return { accepted: false, runComplete: false };
    let submission: ContactAuditSubmission;
    try {
      submission = parseContactAuditSubmission(
        value,
        job.snapshotEmail,
        job.rosterSnapshot?.entries.map((entry) => entry.id)
      );
    } catch (error) {
      throw new ContactAuditValidationError(
        error instanceof Error ? error.message : String(error)
      );
    }
    if (submission.claimToken !== job.claimToken) {
      return { accepted: false, runComplete: false };
    }
    const currentContacts = job.artistId
      ? await tx.contact.findMany({
          where: {
            artistId: job.artistId,
            state: "active",
            email: { not: null },
          },
          select: { email: true },
        })
      : [];
    validateContactAuditAlternativeEmails(submission.alternatives, [
      ...(job.rosterSnapshot?.entries.map((entry) => entry.snapshotEmail) ??
        []),
      ...currentContacts.map((contact) => contact.email),
    ]);

    await tx.contactAuditAlternative.deleteMany({ where: { jobId } });
    if (submission.alternatives.length > 0) {
      await tx.contactAuditAlternative.createMany({
        data: submission.alternatives.map((alternative) => ({
          id: randomUUID(),
          jobId,
          ...alternative,
        })),
      });
    }
    await tx.contactAuditJob.update({
      where: { id: jobId },
      data: {
        status: "complete",
        finding: submission.finding,
        sourceUrls: submission.sourceUrls,
        evidence: submission.evidence,
        confidence: submission.confidence,
        agentNotes: submission.notes,
        rosterReview:
          submission.rosterReview.length > 0
            ? (submission.rosterReview as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
        verifiedAt: now,
        reviewedAt: null,
        claimToken: null,
        claimedAt: null,
        claimExpiresAt: null,
      },
    });
    const remaining = await tx.contactAuditJob.count({
      where: { runId: job.runId, status: { not: "complete" } },
    });
    const runComplete = remaining === 0;
    if (runComplete) {
      await tx.contactAuditRun.update({
        where: { id: job.runId },
        data: { status: "complete", completedAt: now },
      });
      await tx.contactAuditRequest.updateMany({
        where: {
          runId: job.runId,
          status: { in: [...CONTACT_AUDIT_REQUEST_ACTIVE_STATUSES] },
        },
        data: {
          status: "completed",
          completedAt: now,
          lastError: null,
        },
      });
    }
    return { accepted: true, runComplete };
  });
}

export async function markContactAuditReviewed(
  jobId: string,
  now: Date = new Date()
): Promise<boolean> {
  const result = await db.contactAuditJob.updateMany({
    where: {
      id: jobId,
      status: "complete",
      verifiedAt: { not: null },
    },
    data: { reviewedAt: now },
  });
  return result.count === 1;
}

type ResolutionDecision =
  | { resolution: "approved"; alternativeId: string | null }
  | { resolution: "rejected"; alternativeId: null };

type ResolutionContact = {
  id: string;
  artistId: string;
  email: string | null;
  phone: string | null;
  directOutreachNote: string | null;
  name: string | null;
  role: string | null;
  source: string | null;
  notes: string | null;
  isFullTeam: boolean;
  sourceKey: string | null;
  state: "active" | "quarantined";
  updatedAt: Date;
  artist: { name: string };
};

type ResolutionAlternative = {
  id: string;
  jobId: string;
  normalizedEmail: string;
  email: string;
  name: string | null;
  role: string;
};

type ResolutionReservation = {
  jobId: string;
  finding: "changed" | "stale" | "ambiguous";
  claimToken: string;
  contact: ResolutionContact;
  alternative: ResolutionAlternative | null;
};

interface ContactAuditSheetMutations {
  update: typeof updateAuditedContactInSheet;
  rollback: typeof rollbackAuditedContactInSheet;
}

const CONTACT_AUDIT_SHEET_MUTATIONS: ContactAuditSheetMutations = {
  update: updateAuditedContactInSheet,
  rollback: rollbackAuditedContactInSheet,
};

function isSameResolution(
  existing: {
    resolution: string | null;
    selectedAlternativeId: string | null;
  },
  decision: ResolutionDecision
): boolean {
  return (
    existing.resolution === decision.resolution &&
    existing.selectedAlternativeId === decision.alternativeId
  );
}

function resolutionError(error: unknown): string {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    return "That artist already has the proposed email address. No contact or outreach history was merged.";
  }
  return "The decision could not be saved. The contact was not changed; refresh and try again.";
}

async function contactAuditAlternativeAlreadyStored(
  tx: Prisma.TransactionClient,
  input: {
    artistId: string;
    targetContactId: string;
    rosterSnapshotId: string | null;
    normalizedEmail: string;
  }
): Promise<boolean> {
  const [snapshotDuplicate, currentDuplicate] = await Promise.all([
    input.rosterSnapshotId
      ? tx.contactAuditRosterEntry.findFirst({
          where: {
            rosterSnapshotId: input.rosterSnapshotId,
            snapshotContactId: { not: input.targetContactId },
            snapshotEmail: {
              equals: input.normalizedEmail,
              mode: "insensitive",
            },
          },
          select: { id: true },
        })
      : null,
    tx.contact.findFirst({
      where: {
        artistId: input.artistId,
        email: {
          equals: input.normalizedEmail,
          mode: "insensitive",
        },
        id: { not: input.targetContactId },
      },
      select: { id: true },
    }),
  ]);
  return Boolean(snapshotDuplicate || currentDuplicate);
}

async function releaseContactAuditResolutionClaim(
  jobId: string,
  claimToken: string
): Promise<void> {
  await db.contactAuditJob.updateMany({
    where: {
      id: jobId,
      resolution: null,
      resolutionClaimToken: claimToken,
    },
    data: {
      resolutionClaimToken: null,
      resolutionClaimedAt: null,
    },
  });
}

async function reserveContactAuditResolution(
  jobId: string,
  decision: ResolutionDecision,
  now: Date
): Promise<
  | { ok: true; reservation: ResolutionReservation }
  | { ok: false; result: ContactAuditResolutionResult }
> {
  const staleClaimBefore = contactAuditResolutionClaimStaleBefore(now);
  return withSerializableRetry(async (tx) => {
    const job = await tx.contactAuditJob.findUnique({
      where: { id: jobId },
      include: {
        contact: { include: { artist: { select: { name: true } } } },
        alternatives: decision.alternativeId
          ? { where: { id: decision.alternativeId } }
          : false,
      },
    });
    if (!job) {
      return {
        ok: false as const,
        result: { ok: false, error: "This audit finding no longer exists." },
      };
    }
    if (job.resolution) {
      if (isSameResolution(job, decision)) {
        return {
          ok: false as const,
          result: {
            ok: true,
            status: "already_resolved",
            resolution: decision.resolution,
          },
        };
      }
      return {
        ok: false as const,
        result: {
          ok: false,
          error:
            "This finding was already resolved with a different decision.",
        },
      };
    }
    const eligibility = contactAuditResolutionEligibility(job, now);
    if (eligibility === "not_eligible") {
      return {
        ok: false as const,
        result: {
          ok: false,
          error: "This audit finding is not an unresolved flagged result.",
        },
      };
    }
    if (eligibility === "active_claim") {
      return {
        ok: false as const,
        result: {
          ok: false,
          error:
            "Another decision is currently being applied to this finding. Refresh before trying again.",
        },
      };
    }
    if (
      eligibility === "contact_missing" ||
      eligibility === "contact_changed" ||
      !job.contact
    ) {
      return {
        ok: false as const,
        result: {
          ok: false,
          error:
            eligibility === "contact_missing"
              ? "The audited contact no longer exists. Run a new audit before deciding it."
              : "The contact changed after this audit was saved. Run a new audit before deciding it.",
        },
      };
    }
    const contact = job.contact;

    const alternative =
      decision.alternativeId && job.alternatives
        ? job.alternatives[0] ?? null
        : null;
    if (
      decision.resolution === "approved" &&
      (job.finding === "changed" || job.finding === "ambiguous") &&
      (!alternative || alternative.jobId !== job.id)
    ) {
      return {
        ok: false as const,
        result: {
          ok: false,
          error: "Select a proposed contact from this audit finding.",
        },
      };
    }
    if (
      decision.resolution === "approved" &&
      job.finding === "stale" &&
      decision.alternativeId
    ) {
      return {
        ok: false as const,
        result: {
          ok: false,
          error: "A stale finding cannot apply a replacement contact.",
        },
      };
    }
    if (decision.resolution === "rejected" && decision.alternativeId) {
      return {
        ok: false as const,
        result: { ok: false, error: "Reject does not select an alternative." },
      };
    }
    if (alternative) {
      const duplicate = await contactAuditAlternativeAlreadyStored(tx, {
        artistId: contact.artistId,
        targetContactId: contact.id,
        rosterSnapshotId: job.rosterSnapshotId,
        normalizedEmail: alternative.normalizedEmail,
      });
      if (duplicate) {
        return {
          ok: false as const,
          result: {
            ok: false,
            error:
              "That email is already stored for this artist in the audit roster or current contacts. Existing contacts remain separate, cannot be applied as replacements, and outreach history will not be merged automatically.",
          },
        };
      }
    }

    const claimed = await tx.contactAuditJob.updateMany({
      where: {
        id: job.id,
        resolution: null,
        OR: [
          { resolutionClaimToken: null },
          { resolutionClaimedAt: { lte: staleClaimBefore } },
        ],
      },
      data: {
        resolutionClaimToken: randomUUID(),
        resolutionClaimedAt: now,
      },
    });
    if (claimed.count !== 1) {
      return {
        ok: false as const,
        result: {
          ok: false,
          error:
            "Another decision is currently being applied to this finding. Refresh before trying again.",
        },
      };
    }
    const claimedJob = await tx.contactAuditJob.findUniqueOrThrow({
      where: { id: job.id },
      select: { resolutionClaimToken: true },
    });
    return {
      ok: true as const,
      reservation: {
        jobId: job.id,
        finding: job.finding as ResolutionReservation["finding"],
        claimToken: claimedJob.resolutionClaimToken!,
        contact: contact as ResolutionContact,
        alternative: alternative as ResolutionAlternative | null,
      },
    };
  });
}

async function finalizeContactAuditResolution(
  reservation: ResolutionReservation,
  decision: ResolutionDecision,
  now: Date,
  sheetSourceKey: string | null
): Promise<ContactAuditResolutionResult> {
  return withSerializableRetry(async (tx) => {
    const job = await tx.contactAuditJob.findUnique({
      where: { id: reservation.jobId },
      include: {
        contact: { include: { artist: { select: { name: true } } } },
        alternatives: decision.alternativeId
          ? { where: { id: decision.alternativeId } }
          : false,
      },
    });
    if (job?.resolution) {
      return isSameResolution(job, decision)
        ? {
            ok: true,
            status: "already_resolved" as const,
            resolution: decision.resolution,
          }
        : {
            ok: false,
            error:
              "This finding was already resolved with a different decision.",
          };
    }
    if (
      !job ||
      job.resolutionClaimToken !== reservation.claimToken ||
      job.status !== "complete" ||
      job.finding !== reservation.finding ||
      !job.contact ||
      !contactStillMatchesAuditSnapshot(job, job.contact) ||
      job.contact.updatedAt.getTime() !==
        reservation.contact.updatedAt.getTime()
    ) {
      return {
        ok: false,
        error:
          "The audit finding or contact changed while the decision was being applied. No database change was saved.",
      };
    }
    const alternative =
      decision.alternativeId && job.alternatives
        ? job.alternatives[0] ?? null
        : null;
    if (
      decision.resolution === "approved" &&
      (job.finding === "changed" || job.finding === "ambiguous") &&
      (!alternative || alternative.jobId !== job.id)
    ) {
      return {
        ok: false,
        error: "The selected replacement no longer belongs to this finding.",
      };
    }
    if (alternative) {
      const duplicate = await contactAuditAlternativeAlreadyStored(tx, {
        artistId: job.contact.artistId,
        targetContactId: job.contact.id,
        rosterSnapshotId: job.rosterSnapshotId,
        normalizedEmail: alternative.normalizedEmail,
      });
      if (duplicate) {
        return {
          ok: false,
          error:
            "That email is already stored for this artist in the audit roster or current contacts. Existing contacts remain separate and were not replaced.",
        };
      }
    }

    let resolvedContact: ResolutionContact = job.contact as ResolutionContact;
    if (decision.resolution === "approved" && job.finding === "stale") {
      resolvedContact = (await tx.contact.update({
        where: { id: job.contact.id },
        data: { state: "quarantined" },
        include: { artist: { select: { name: true } } },
      })) as ResolutionContact;
    } else if (decision.resolution === "approved" && alternative) {
      resolvedContact = (await tx.contact.update({
        where: { id: job.contact.id },
        data: {
          email: alternative.normalizedEmail,
          phone: null,
          directOutreachNote: null,
          ...CLEAR_AGENT_DIRECT_OUTREACH_PROVENANCE,
          name: alternative.name,
          role: "management",
          state: "active",
          ...(job.contact.source === "sheet"
            ? {
                sourceKey: sheetSourceKey ?? job.contact.sourceKey,
                sourceSyncedAt: now,
              }
            : {}),
        },
        include: { artist: { select: { name: true } } },
      })) as ResolutionContact;
    }

    const saved = await tx.contactAuditJob.updateMany({
      where: {
        id: job.id,
        resolution: null,
        resolutionClaimToken: reservation.claimToken,
      },
      data: {
        resolution: decision.resolution,
        resolvedAt: now,
        reviewedAt: now,
        selectedAlternativeId:
          decision.resolution === "approved" ? alternative?.id ?? null : null,
        resolvedContactId: resolvedContact.id,
        resolvedArtistId: resolvedContact.artistId,
        resolvedArtistName: resolvedContact.artist.name,
        resolvedEmail: resolvedContact.email,
        resolvedPhone: resolvedContact.phone,
        resolvedDirectOutreachNote: resolvedContact.directOutreachNote,
        resolvedName: resolvedContact.name,
        resolvedRole: resolvedContact.role,
        resolvedSource: resolvedContact.source,
        resolvedState: resolvedContact.state,
        resolutionClaimToken: null,
        resolutionClaimedAt: null,
      },
    });
    if (saved.count !== 1) {
      throw new Error("Contact audit resolution claim was lost");
    }
    return {
      ok: true,
      status: "resolved",
      resolution: decision.resolution,
    };
  });
}

export async function resolveContactAuditJob(
  jobId: string,
  resolution: ContactAuditResolution,
  alternativeId: string | null,
  now: Date = new Date(),
  sheetMutations: ContactAuditSheetMutations = CONTACT_AUDIT_SHEET_MUTATIONS
): Promise<ContactAuditResolutionResult> {
  const normalizedJobId = jobId.trim();
  const normalizedAlternativeId = alternativeId?.trim() || null;
  if (!normalizedJobId) {
    return { ok: false, error: "Missing audit finding." };
  }
  const decision: ResolutionDecision =
    resolution === "approved"
      ? { resolution, alternativeId: normalizedAlternativeId }
      : { resolution: "rejected", alternativeId: null };
  const reserved = await reserveContactAuditResolution(
    normalizedJobId,
    decision,
    now
  );
  if (!reserved.ok) return reserved.result;

  const { reservation } = reserved;
  let sheetUpdate: Awaited<
    ReturnType<typeof updateAuditedContactInSheet>
  > | null = null;
  if (
    decision.resolution === "approved" &&
    reservation.alternative &&
    reservation.contact.source === "sheet" &&
    !reservation.contact.sourceKey
  ) {
    await releaseContactAuditResolutionClaim(
      reservation.jobId,
      reservation.claimToken
    );
    return {
      ok: false,
      error:
        "This Sheet-owned contact has no stable row identity. Run a complete Sheet sync before approving the replacement.",
    };
  }
  if (
    decision.resolution === "approved" &&
    reservation.alternative &&
    reservation.contact.source === "sheet" &&
    reservation.contact.sourceKey
  ) {
    try {
      sheetUpdate = await sheetMutations.update({
        artistName: reservation.contact.artist.name,
        oldEmail: reservation.contact.email,
        newEmail: reservation.alternative.normalizedEmail,
        oldDirectOutreachNote: reservation.contact.directOutreachNote,
        newDirectOutreachNote: null,
        sourceKey: reservation.contact.sourceKey,
        managerName: reservation.alternative.name,
        role: "management",
      });
    } catch (error) {
      if (error instanceof AuditedContactSheetPostWriteError) {
        const recovery = await recoverAuditedContactSheetPostWriteError(
          error,
          sheetMutations.rollback
        );
        await releaseContactAuditResolutionClaim(
          reservation.jobId,
          reservation.claimToken
        );
        const originalDetail = error.message.slice(0, 180);
        if (!recovery.rolledBack) {
          console.error(
            JSON.stringify({
              event: "contact_audit_sheet_post_write_rollback_failed",
              jobId: reservation.jobId,
              contactId: reservation.contact.id,
              sheetError: error.message,
              rollbackError: recovery.rollbackError,
            })
          );
          return {
            ok: false,
            error: `Google Sheet update verification failed after the write, and rollback failed. Reconcile the Sheet before retrying. Original error: ${originalDetail}. Rollback error: ${recovery.rollbackError.slice(0, 180)}`,
          };
        }
        return {
          ok: false,
          error: `Google Sheet update verification failed after the write; the exact Sheet changes were rolled back and the database decision was not saved. ${originalDetail}`,
        };
      }
      await releaseContactAuditResolutionClaim(
        reservation.jobId,
        reservation.claimToken
      );
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: `Google Sheet update failed; the database and decision were not changed. ${detail.slice(0, 180)}`,
      };
    }
  }

  let result: ContactAuditResolutionResult;
  try {
    result = await finalizeContactAuditResolution(
      reservation,
      decision,
      now,
      sheetUpdate?.sourceKey ?? null
    );
  } catch (error) {
    result = { ok: false, error: resolutionError(error) };
  }
  if (result.ok || !sheetUpdate || !reservation.alternative) {
    if (!result.ok) {
      await releaseContactAuditResolutionClaim(
        reservation.jobId,
        reservation.claimToken
      );
    }
    return result;
  }

  let rollbackError: string | null = null;
  try {
    await sheetMutations.rollback(sheetUpdate.rollback);
  } catch (error) {
    rollbackError = error instanceof Error ? error.message : String(error);
  }
  await releaseContactAuditResolutionClaim(
    reservation.jobId,
    reservation.claimToken
  );
  if (rollbackError) {
    console.error(
      JSON.stringify({
        event: "contact_audit_sheet_database_divergence",
        jobId: reservation.jobId,
        contactId: reservation.contact.id,
        rollbackError,
      })
    );
    return {
      ok: false,
      error: `The Sheet changed, but the database decision failed and the Sheet rollback also failed. Reconcile the Sheet before retrying. ${rollbackError.slice(0, 180)}`,
    };
  }
  return {
    ok: false,
    error: `${result.error ?? "The database decision failed."} The Sheet change was rolled back.`,
  };
}
