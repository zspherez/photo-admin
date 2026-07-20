import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
} from "jose";
import { db } from "@/lib/db";
import { constantTimeEqual } from "@/lib/auth";
import {
  normalizeManagerRole,
  normalizeResearchEmail,
  normalizeResearchSourceUrl,
} from "@/lib/contactResearch";
import { updateContactInSheet } from "@/lib/sheets";
import { CONTACT_AUDIT_RESOLUTION_CLAIM_TTL_MS } from "@/lib/contactAuditResolutionPolicy";

export const CONTACT_AUDIT_DEFAULT_CLAIM_LIMIT = 1;
export const CONTACT_AUDIT_MAX_CLAIM_LIMIT = 10;
export const CONTACT_AUDIT_CLAIM_TTL_MS = 60 * 60 * 1_000;
export const CONTACT_AUDIT_OIDC_AUDIENCE = "photo-admin-contact-audit";
export const CONTACT_AUDIT_OIDC_ISSUER =
  "https://token.actions.githubusercontent.com";
export const CONTACT_AUDIT_WORKFLOW_REF =
  "zspherez/photo-admin/.github/workflows/contact-audit.yml@refs/heads/main";

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
  existingEmail?: string | null
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
  if (
    (finding === "changed" || finding === "ambiguous") &&
    alternatives.length === 0
  ) {
    throw new Error(`${finding} findings require an alternative contact`);
  }

  return {
    claimToken,
    finding: finding as ContactAuditFinding,
    sourceUrls,
    evidence: requiredString(input.evidence, 4_000, "evidence"),
    confidence: confidence as ContactAuditConfidence,
    notes: optionalString(input.notes, 4_000, "notes"),
    alternatives,
  };
}

export async function isValidContactAuditAuthorization(
  authorization: string | null,
  secrets:
    | string
    | readonly (string | undefined)[]
    = [process.env.CONTACT_AUDIT_AGENT_TOKEN, process.env.CRON_SECRET],
  verifyGithubActionsToken: (
    token: string
  ) => Promise<boolean> = verifyGithubActionsContactAuditToken
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

export function isTrustedContactAuditOidcClaims(
  payload: JWTPayload
): boolean {
  return (
    payload.repository === "zspherez/photo-admin" &&
    payload.repository_owner === "zspherez" &&
    payload.ref === "refs/heads/main" &&
    payload.workflow_ref === CONTACT_AUDIT_WORKFLOW_REF &&
    payload.event_name === "workflow_dispatch"
  );
}

export async function verifyGithubActionsContactAuditToken(
  token: string
): Promise<boolean> {
  if (token.split(".").length !== 3) return false;
  try {
    const { payload } = await jwtVerify(token, githubActionsJwks, {
      issuer: CONTACT_AUDIT_OIDC_ISSUER,
      audience: CONTACT_AUDIT_OIDC_AUDIENCE,
    });
    return isTrustedContactAuditOidcClaims(payload);
  } catch {
    return false;
  }
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

export async function prepareContactAudit(
  now: Date = new Date()
): Promise<{
  runId: string;
  resumed: boolean;
  contactCount: number;
  claimable: number;
}> {
  return withSerializableRetry(async (tx) => {
    const running = await tx.contactAuditRun.findFirst({
      where: { status: "running" },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        contactCount: true,
        jobs: {
          select: {
            status: true,
            claimExpiresAt: true,
          },
        },
      },
    });
    if (running) {
      const incomplete = running.jobs.filter(
        (job) => job.status !== "complete"
      );
      if (incomplete.length > 0) {
        const claimable = incomplete.filter(
          (job) =>
            job.status === "pending" ||
            !job.claimExpiresAt ||
            job.claimExpiresAt <= now
        ).length;
        return {
          runId: running.id,
          resumed: true,
          contactCount: running.contactCount,
          claimable,
        };
      }
      await tx.contactAuditRun.update({
        where: { id: running.id },
        data: { status: "complete", completedAt: now },
      });
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
      await tx.contactAuditJob.createMany({
        data: contacts.map((contact) => ({
          id: randomUUID(),
          runId,
          contactId: contact.id,
          artistId: contact.artistId,
          snapshotArtistName: contact.artist.name,
          snapshotEmail: contact.email,
          snapshotPhone: contact.phone,
          snapshotDirectOutreachNote: contact.directOutreachNote,
          snapshotName: contact.name,
          snapshotRole: contact.role,
          snapshotSource: contact.source,
          snapshotNotes: contact.notes,
        })),
      });
    }
    return {
      runId,
      resumed: false,
      contactCount: contacts.length,
      claimable: contacts.length,
    };
  }, { timeout: 30_000 });
}

export async function claimContactAuditJobs(
  limit: number,
  now: Date = new Date()
) {
  const claimLimit = parseContactAuditClaimLimit(limit);
  const claimExpiresAt = new Date(now.getTime() + CONTACT_AUDIT_CLAIM_TTL_MS);
  return db.$transaction(
    async (tx) => {
      const selected = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT job."id"
        FROM "ContactAuditJob" job
        JOIN "ContactAuditRun" run ON run."id" = job."runId"
        WHERE run."status" = 'running'
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
          attemptCount: true,
          snapshotArtistName: true,
          snapshotEmail: true,
          snapshotPhone: true,
          snapshotDirectOutreachNote: true,
          snapshotName: true,
          snapshotRole: true,
          snapshotSource: true,
          snapshotNotes: true,
        },
      });
      const jobsById = new Map(jobs.map((job) => [job.id, job]));
      return selected.flatMap((row) => {
        const job = jobsById.get(row.id);
        return job
          ? [
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
                },
              },
            ]
          : [];
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
        snapshotEmail: true,
      },
    });
    if (!job) return { accepted: false, runComplete: false };
    let submission: ContactAuditSubmission;
    try {
      submission = parseContactAuditSubmission(value, job.snapshotEmail);
    } catch (error) {
      throw new ContactAuditValidationError(
        error instanceof Error ? error.message : String(error)
      );
    }
    if (submission.claimToken !== job.claimToken) {
      return { accepted: false, runComplete: false };
    }

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

const FLAGGED_CONTACT_AUDIT_FINDINGS = new Set([
  "changed",
  "stale",
  "ambiguous",
]);

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
  customPrice: string | null;
  notes: string | null;
  source: string | null;
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

type SheetContactUpdater = typeof updateContactInSheet;

function contactStillMatchesAuditSnapshot(
  job: {
    snapshotEmail: string | null;
    snapshotPhone: string | null;
    snapshotDirectOutreachNote: string | null;
    snapshotName: string | null;
    snapshotRole: string | null;
    snapshotSource: string | null;
  },
  contact: ResolutionContact
): boolean {
  return (
    contact.state === "active" &&
    contact.email === job.snapshotEmail &&
    contact.phone === job.snapshotPhone &&
    contact.directOutreachNote === job.snapshotDirectOutreachNote &&
    contact.name === job.snapshotName &&
    contact.role === job.snapshotRole &&
    contact.source === job.snapshotSource
  );
}

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
  const staleClaimBefore = new Date(
    now.getTime() - CONTACT_AUDIT_RESOLUTION_CLAIM_TTL_MS
  );
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
    if (
      job.status !== "complete" ||
      !job.verifiedAt ||
      !job.finding ||
      !FLAGGED_CONTACT_AUDIT_FINDINGS.has(job.finding)
    ) {
      return {
        ok: false as const,
        result: {
          ok: false,
          error: "This audit finding is not an unresolved flagged result.",
        },
      };
    }
    if (!job.contact || !contactStillMatchesAuditSnapshot(job, job.contact)) {
      return {
        ok: false as const,
        result: {
          ok: false,
          error:
            "The contact changed after this audit was saved. Run a new audit before deciding it.",
        },
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
      const duplicate = await tx.contact.findFirst({
        where: {
          artistId: job.contact.artistId,
          email: {
            equals: alternative.normalizedEmail,
            mode: "insensitive",
          },
          id: { not: job.contact.id },
        },
        select: { id: true },
      });
      if (duplicate) {
        return {
          ok: false as const,
          result: {
            ok: false,
            error:
              "That artist already has the proposed email address. Resolve the duplicate contact separately; outreach history will not be merged automatically.",
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
        contact: job.contact as ResolutionContact,
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
      const duplicate = await tx.contact.findFirst({
        where: {
          artistId: job.contact.artistId,
          email: {
            equals: alternative.normalizedEmail,
            mode: "insensitive",
          },
          id: { not: job.contact.id },
        },
        select: { id: true },
      });
      if (duplicate) {
        return {
          ok: false,
          error:
            "That artist already has the proposed email address. Resolve the duplicate contact separately; outreach history was not merged.",
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
  sheetUpdater: SheetContactUpdater = updateContactInSheet
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
  let sheetUpdate: Awaited<ReturnType<SheetContactUpdater>> | null = null;
  if (
    decision.resolution === "approved" &&
    reservation.alternative &&
    reservation.contact.source === "sheet"
  ) {
    try {
      sheetUpdate = await sheetUpdater({
        artistName: reservation.contact.artist.name,
        oldEmail: reservation.contact.email,
        newEmail: reservation.alternative.normalizedEmail,
        oldDirectOutreachNote: reservation.contact.directOutreachNote,
        newDirectOutreachNote: null,
        sourceKey: reservation.contact.sourceKey,
        managerName: reservation.alternative.name,
        role: "management",
        customPrice: reservation.contact.customPrice,
        notes: reservation.contact.notes,
      });
    } catch (error) {
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
    await sheetUpdater({
      artistName: reservation.contact.artist.name,
      oldEmail: reservation.alternative.normalizedEmail,
      newEmail: reservation.contact.email,
      oldDirectOutreachNote: null,
      newDirectOutreachNote: reservation.contact.directOutreachNote,
      sourceKey: sheetUpdate.sourceKey,
      managerName: reservation.contact.name,
      role: reservation.contact.role,
      customPrice: reservation.contact.customPrice,
      notes: reservation.contact.notes,
    });
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
