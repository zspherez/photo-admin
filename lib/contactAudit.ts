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
