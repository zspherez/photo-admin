import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { db } from "@/lib/db";
import {
  appConfig,
  buildWorkflowRef,
  PROFESSIONAL_CONTACT_RESEARCH_WORKFLOW_FILE,
  resolveProfessionalContactResearchTrustConfig,
  type WorkflowTrustConfig,
} from "@/lib/appConfig";
import {
  type AgentMutationEnvironment,
  isValidAgentMutationAuthorization,
} from "@/lib/agentMutationAuthorization";
import {
  normalizeProfessionalIdentity,
  parseProfessionalContactRequestInput,
  type ProfessionalContactRequestInput,
} from "@/lib/professionalContactInput";
import {
  assertNamedBusinessEmail,
  canonicalPublicHttpsUrl,
  validateProfessionalContactProvenance,
} from "@/lib/professionalContactProvenance.mjs";

export const PROFESSIONAL_CONTACT_OIDC_AUDIENCE =
  "photo-admin-professional-contact-research";
export const PROFESSIONAL_CONTACT_OIDC_ISSUER =
  "https://token.actions.githubusercontent.com";
export const PROFESSIONAL_CONTACT_CLAIM_TTL_MS = 60 * 60 * 1_000;
export const PROFESSIONAL_CONTACT_DISPATCH_LEASE_MS = 2 * 60 * 1_000;
export const PROFESSIONAL_CONTACT_MAX_CLAIM_LIMIT = 10;
export const PROFESSIONAL_CONTACT_WORKFLOW_REF =
  resolveProfessionalContactResearchTrustConfig()?.workflowRef ??
  buildWorkflowRef(
    appConfig.repository,
    PROFESSIONAL_CONTACT_RESEARCH_WORKFLOW_FILE,
  );

export function resolveProfessionalContactDispatchTarget(
  configuration: WorkflowTrustConfig | null = TRUST_CONFIG,
  repository = appConfig.repository,
): {
  workflowFile: string;
  ref: "main";
  workflowRef: string;
} {
  if (
    !configuration ||
    configuration.repository !== repository.slug ||
    configuration.owner !== repository.owner
  ) {
    throw new Error(
      "Professional contact workflow dispatch trust is not configured",
    );
  }
  const prefix = `${repository.slug}/.github/workflows/`;
  if (
    !configuration.workflowRef.startsWith(prefix) ||
    !configuration.workflowRef.endsWith(TRUSTED_WORKFLOW_SUFFIX)
  ) {
    throw new Error(
      "Professional contact workflow dispatch ref is not allowed",
    );
  }
  const workflowFile = configuration.workflowRef.slice(
    prefix.length,
    -TRUSTED_WORKFLOW_SUFFIX.length,
  );
  if (!WORKFLOW_FILE_PATTERN.test(workflowFile)) {
    throw new Error(
      "Professional contact workflow dispatch file is invalid",
    );
  }
  return {
    workflowFile,
    ref: "main",
    workflowRef: configuration.workflowRef,
  };
}

const TRUST_CONFIG = resolveProfessionalContactResearchTrustConfig();
const TRUSTED_WORKFLOW_SUFFIX = "@refs/heads/main";
const WORKFLOW_FILE_PATTERN = /^[A-Za-z0-9_.-]+\.(?:yml|yaml)$/;
const githubActionsJwks = createRemoteJWKSet(
  new URL(`${PROFESSIONAL_CONTACT_OIDC_ISSUER}/.well-known/jwks`),
);
const DISCOVERY_METHODS = new Set([
  "official",
  "professional_profile",
  "business_directory",
  "domain_pattern",
]);
const CONFIDENCE_VALUES = new Set(["high", "medium", "low"]);

export type ProfessionalContactTransactionRunner = <T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
) => Promise<T>;

export interface ProfessionalContactCandidateInput {
  email: string;
  normalizedEmail: string;
  personName: string;
  roleTitle: string;
  organization: string;
  confidence: "high" | "medium" | "low";
  discoveryMethod:
    | "official"
    | "professional_profile"
    | "business_directory"
    | "domain_pattern";
  evidence: string;
  sourceUrls: string[];
  patternEvidence: string | null;
  patternEvidenceUrl: string | null;
  patternExamples: Array<{ email: string; personName: string }>;
}

export type ProfessionalContactSubmission =
  | {
      outcome: "candidates";
      claimToken: string;
      notes: string | null;
      candidates: ProfessionalContactCandidateInput[];
      provenance: unknown;
    }
  | {
      outcome: "exhausted";
      claimToken: string;
      notes: string;
      candidates: [];
      provenance: unknown;
    };

async function withSerializableRetry<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (
        attempt === 2 ||
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== "P2034"
      ) {
        throw error;
      }
    }
  }
  throw new Error("professional contact transaction retry failed");
}

function boundedOptionalString(
  value: unknown,
  field: string,
  maxLength: number,
): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) {
    throw new Error(`${field} must be at most ${maxLength} characters`);
  }
  if (/[\u0000-\u001f\u007f-\u009f]/.test(normalized)) {
    throw new Error(`${field} contains unsupported control characters`);
  }
  return normalized;
}

function boundedString(value: unknown, field: string, maxLength: number) {
  const normalized = boundedOptionalString(value, field, maxLength);
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function normalizeProfessionalEmail(value: unknown): {
  email: string;
  normalizedEmail: string;
} {
  const email = boundedString(value, "candidate email", 320);
  const normalizedEmail = assertNamedBusinessEmail(
    email,
    "candidate email",
  );
  return { email, normalizedEmail };
}

function normalizeSourceUrl(value: unknown, field: string): string {
  return canonicalPublicHttpsUrl(value, field);
}

function evidenceContainsIdentity(
  evidence: string,
  email: string,
  personName: string,
  roleTitle: string,
  organization: string,
): boolean {
  const normalizedEvidence = normalizeProfessionalIdentity(evidence);
  const normalizedRole = normalizeProfessionalIdentity(roleTitle);
  const personTokens = normalizeProfessionalIdentity(personName)
    .split(" ")
    .filter((token) => token.length >= 2);
  const roleTokens = normalizedRole
    .split(" ")
    .filter((token) => token.length >= 2);
  const organizationTokens = normalizeProfessionalIdentity(organization)
    .split(" ")
    .filter((token) => token.length >= 2);
  return (
    evidence.toLowerCase().includes(email.toLowerCase()) &&
    personTokens.length > 0 &&
    personTokens.every((token) => normalizedEvidence.includes(token)) &&
    roleTokens.length > 0 &&
    roleTokens.some((token) => normalizedEvidence.includes(token)) &&
    organizationTokens.length > 0 &&
    organizationTokens.every((token) => normalizedEvidence.includes(token))
  );
}

function parseCandidate(
  value: unknown,
  index: number,
  expectedPersonName?: string,
  expectedOrganization?: string,
): ProfessionalContactCandidateInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`candidates[${index}] must be an object`);
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "email",
    "personName",
    "roleTitle",
    "organization",
    "confidence",
    "discoveryMethod",
    "evidence",
    "sourceUrls",
    "patternEvidence",
    "patternEvidenceUrl",
    "patternExamples",
  ]);
  for (const key of allowed) {
    if (!(key in input)) {
      throw new Error(`candidates[${index}].${key} is required`);
    }
  }
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`candidates[${index}].${key} is not allowed`);
  }
  const { email, normalizedEmail } = normalizeProfessionalEmail(input.email);
  const personName = boundedString(
    input.personName,
    `candidates[${index}].personName`,
    120,
  );
  const organization = boundedString(
    input.organization,
    `candidates[${index}].organization`,
    200,
  );
  if (
    expectedPersonName &&
    normalizeProfessionalIdentity(personName) !==
      normalizeProfessionalIdentity(expectedPersonName)
  ) {
    throw new Error(`candidates[${index}] does not match the claimed person`);
  }
  if (
    expectedOrganization &&
    normalizeProfessionalIdentity(organization) !==
      normalizeProfessionalIdentity(expectedOrganization)
  ) {
    throw new Error(`candidates[${index}] does not match the claimed organization`);
  }
  const roleTitle = boundedString(
    input.roleTitle,
    `candidates[${index}].roleTitle`,
    200,
  );
  if (!CONFIDENCE_VALUES.has(String(input.confidence))) {
    throw new Error(`candidates[${index}].confidence is invalid`);
  }
  if (!DISCOVERY_METHODS.has(String(input.discoveryMethod))) {
    throw new Error(`candidates[${index}].discoveryMethod is invalid`);
  }
  const confidence = input.confidence as ProfessionalContactCandidateInput["confidence"];
  const discoveryMethod =
    input.discoveryMethod as ProfessionalContactCandidateInput["discoveryMethod"];
  const evidence = boundedString(
    input.evidence,
    `candidates[${index}].evidence`,
    4_000,
  );
  if (
    evidence.length < 80 ||
    !evidenceContainsIdentity(
      evidence,
      email,
      personName,
      roleTitle,
      organization,
    )
  ) {
    throw new Error(
      `candidates[${index}].evidence must substantively include the exact email and positive person/organization identity evidence`,
    );
  }
  if (!Array.isArray(input.sourceUrls) || input.sourceUrls.length < 1 || input.sourceUrls.length > 5) {
    throw new Error(`candidates[${index}].sourceUrls must contain 1 to 5 URLs`);
  }
  const sourceUrls = input.sourceUrls.map((url, sourceIndex) =>
    normalizeSourceUrl(url, `candidates[${index}].sourceUrls[${sourceIndex}]`),
  );
  if (new Set(sourceUrls).size !== sourceUrls.length) {
    throw new Error(`candidates[${index}].sourceUrls contains duplicates`);
  }
  const patternEvidence = boundedOptionalString(
    input.patternEvidence,
    `candidates[${index}].patternEvidence`,
    2_000,
  );
  const patternEvidenceUrl =
    input.patternEvidenceUrl == null
      ? null
      : normalizeSourceUrl(
          input.patternEvidenceUrl,
          `candidates[${index}].patternEvidenceUrl`,
        );
  if (!Array.isArray(input.patternExamples)) {
    throw new Error(`candidates[${index}].patternExamples must be an array`);
  }
  const patternExamples = input.patternExamples.map((example, exampleIndex) => {
    if (!example || typeof example !== "object" || Array.isArray(example)) {
      throw new Error(
        `candidates[${index}].patternExamples[${exampleIndex}] must be an object`,
      );
    }
    const record = example as Record<string, unknown>;
    if (
      Object.keys(record).some(
        (key) => key !== "email" && key !== "personName",
      )
    ) {
      throw new Error(
        `candidates[${index}].patternExamples[${exampleIndex}] contains unsupported fields`,
      );
    }
    return {
      email: assertNamedBusinessEmail(
        record.email,
        `candidates[${index}].patternExamples[${exampleIndex}].email`,
      ),
      personName: boundedString(
        record.personName,
        `candidates[${index}].patternExamples[${exampleIndex}].personName`,
        120,
      ),
    };
  });
  if (discoveryMethod === "business_directory" && confidence === "high") {
    throw new Error(
      `candidates[${index}] business-directory evidence cannot be high confidence`,
    );
  }
  if (discoveryMethod === "domain_pattern") {
    if (
      confidence !== "low" ||
      !patternEvidence ||
      patternEvidence.length < 40 ||
      !patternEvidenceUrl ||
      !sourceUrls.includes(patternEvidenceUrl) ||
      patternExamples.length < 2 ||
      patternExamples.length > 5
    ) {
      throw new Error(
        `candidates[${index}] domain-pattern inference requires low confidence and published pattern evidence from a listed source`,
      );
    }
  } else if (
    patternEvidence ||
    patternEvidenceUrl ||
    patternExamples.length > 0
  ) {
    throw new Error(
      `candidates[${index}] pattern evidence is only valid for domain-pattern inference`,
    );
  }
  return {
    email,
    normalizedEmail,
    personName,
    roleTitle,
    organization,
    confidence,
    discoveryMethod,
    evidence,
    sourceUrls,
    patternEvidence,
    patternEvidenceUrl,
    patternExamples,
  };
}

export function parseProfessionalContactSubmission(
  value: unknown,
  expected?: { personName: string; organizationName: string },
): ProfessionalContactSubmission {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request body must be an object");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "outcome",
    "claimToken",
    "notes",
    "candidates",
    "provenance",
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`${key} is not allowed`);
  }
  if (
    typeof input.claimToken !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.claimToken,
    )
  ) {
    throw new Error("claimToken must be a UUID");
  }
  if (
    !input.provenance ||
    typeof input.provenance !== "object" ||
    Array.isArray(input.provenance)
  ) {
    throw new Error("broker provenance is required");
  }
  if (input.outcome === "exhausted") {
    const notes = boundedString(input.notes, "notes", 4_000);
    if (notes.length < 80) {
      throw new Error("exhausted notes must substantively describe sources checked");
    }
    if (!Array.isArray(input.candidates) || input.candidates.length !== 0) {
      throw new Error("exhausted submissions cannot include candidates");
    }
    return {
      outcome: "exhausted",
      claimToken: input.claimToken,
      notes,
      candidates: [],
      provenance: input.provenance,
    };
  }
  if (input.outcome !== "candidates") {
    throw new Error("outcome must be candidates or exhausted");
  }
  const notes = boundedOptionalString(input.notes, "notes", 4_000);
  if (!Array.isArray(input.candidates) || input.candidates.length < 1 || input.candidates.length > 5) {
    throw new Error("candidate submissions must contain 1 to 5 candidates");
  }
  const candidates = input.candidates.map((candidate, index) =>
    parseCandidate(
      candidate,
      index,
      expected?.personName,
      expected?.organizationName,
    ),
  );
  const emails = candidates.map((candidate) => candidate.normalizedEmail);
  if (new Set(emails).size !== emails.length) {
    throw new Error("candidate submission contains duplicate email addresses");
  }
  return {
    outcome: "candidates",
    claimToken: input.claimToken,
    notes,
    candidates,
    provenance: input.provenance,
  };
}

function requestFingerprint(input: ProfessionalContactRequestInput) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        organizationName: input.normalizedOrganization,
        website: input.website,
        locationContext: input.locationContext?.toLowerCase() ?? null,
        notes: input.notes,
        people: input.personNames.map(normalizeProfessionalIdentity).sort(),
      }),
    )
    .digest("hex");
}

function submissionFingerprint(submission: ProfessionalContactSubmission) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        ...submission,
        candidates: submission.candidates
          .map((candidate) => ({
            ...candidate,
            sourceUrls: [...candidate.sourceUrls].sort(),
          }))
          .sort((a, b) => a.normalizedEmail.localeCompare(b.normalizedEmail)),
      }),
    )
    .digest("hex");
}

export async function createProfessionalContactRequest(
  value: Record<string, unknown>,
  runTransaction: ProfessionalContactTransactionRunner = withSerializableRetry,
): Promise<{
  requestId: string;
  duplicate: boolean;
  jobCount: number;
  dispatchStatus: string;
  dispatchAttemptCount: number;
  dispatchUpdatedAt: Date;
}> {
  const input = parseProfessionalContactRequestInput(value);
  const requestKey = requestFingerprint(input);
  try {
    return await runTransaction(async (tx) => {
      const existing = await tx.professionalContactRequest.findUnique({
        where: { requestKey },
        select: {
          id: true,
          _count: { select: { jobs: true } },
          dispatch: {
            select: { status: true, attemptCount: true, updatedAt: true },
          },
        },
      });
      if (existing?.dispatch) {
        return {
          requestId: existing.id,
          duplicate: true,
          jobCount: existing._count.jobs,
          dispatchStatus: existing.dispatch.status,
          dispatchAttemptCount: existing.dispatch.attemptCount,
          dispatchUpdatedAt: existing.dispatch.updatedAt,
        };
      }
      const request = await tx.professionalContactRequest.create({
        data: {
          requestKey,
          organizationName: input.organizationName,
          normalizedOrganization: input.normalizedOrganization,
          website: input.website,
          locationContext: input.locationContext,
          notes: input.notes,
          personNames: input.personNames,
          jobs: {
            create: input.personNames.map((personName) => ({
              personName,
              normalizedPersonName: normalizeProfessionalIdentity(personName),
            })),
          },
          dispatch: { create: {} },
        },
        select: {
          id: true,
          dispatch: {
            select: { status: true, attemptCount: true, updatedAt: true },
          },
        },
      });
      if (!request.dispatch) {
        throw new Error("professional contact dispatch state was not created");
      }
      await tx.professionalContactEvent.create({
        data: {
          requestId: request.id,
          kind: "request_created",
          actor: "admin",
          details: { people: input.personNames.length },
        },
      });
      return {
        requestId: request.id,
        duplicate: false,
        jobCount: input.personNames.length,
        dispatchStatus: request.dispatch.status,
        dispatchAttemptCount: request.dispatch.attemptCount,
        dispatchUpdatedAt: request.dispatch.updatedAt,
      };
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const existing = await db.professionalContactRequest.findUniqueOrThrow({
        where: { requestKey },
        select: {
          id: true,
          _count: { select: { jobs: true } },
          dispatch: {
            select: { status: true, attemptCount: true, updatedAt: true },
          },
        },
      });
      if (!existing.dispatch) {
        throw new Error("professional contact dispatch state is missing");
      }
      return {
        requestId: existing.id,
        duplicate: true,
        jobCount: existing._count.jobs,
        dispatchStatus: existing.dispatch.status,
        dispatchAttemptCount: existing.dispatch.attemptCount,
        dispatchUpdatedAt: existing.dispatch.updatedAt,
      };
    }
    throw error;
  }
}

export function parseProfessionalContactClaimLimit(value: unknown): number {
  if (value == null) return 1;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > PROFESSIONAL_CONTACT_MAX_CLAIM_LIMIT
  ) {
    throw new Error(
      `limit must be an integer from 1 to ${PROFESSIONAL_CONTACT_MAX_CLAIM_LIMIT}`,
    );
  }
  return value;
}

export async function claimProfessionalContactJobs(
  limit: number,
  now: Date = new Date(),
  runTransaction: ProfessionalContactTransactionRunner = withSerializableRetry,
) {
  const claimLimit = parseProfessionalContactClaimLimit(limit);
  const claimExpiresAt = new Date(
    now.getTime() + PROFESSIONAL_CONTACT_CLAIM_TTL_MS,
  );
  return runTransaction(async (tx) => {
    const selected = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT job."id"
      FROM "ProfessionalContactJob" job
      WHERE job."status" = 'pending'
         OR (
           job."status" = 'claimed'
           AND (
             job."claimExpiresAt" IS NULL
             OR job."claimExpiresAt" <= ${now}
           )
         )
      ORDER BY job."createdAt" ASC
      LIMIT ${claimLimit}
      FOR UPDATE SKIP LOCKED
    `);
    if (selected.length === 0) return [];
    const tokenById = new Map<string, string>();
    const provenanceTokenById = new Map<string, string>();
    for (const row of selected) {
      const claimToken = randomUUID();
      const claimProvenanceToken = randomUUID();
      tokenById.set(row.id, claimToken);
      provenanceTokenById.set(row.id, claimProvenanceToken);
      await tx.professionalContactJob.update({
        where: { id: row.id },
        data: {
          status: "claimed",
          claimToken,
          claimProvenanceToken,
          claimedAt: now,
          claimExpiresAt,
          resultFingerprint: null,
          attemptCount: { increment: 1 },
        },
      });
    }
    const jobs = await tx.professionalContactJob.findMany({
      where: { id: { in: selected.map((row) => row.id) } },
      select: {
        id: true,
        requestId: true,
        personName: true,
        attemptCount: true,
        request: {
          select: {
            organizationName: true,
            website: true,
            locationContext: true,
            notes: true,
            personNames: true,
          },
        },
        candidates: {
          orderBy: { createdAt: "desc" },
          take: 20,
          select: {
            id: true,
            email: true,
            decision: { select: { action: true } },
          },
        },
      },
    });
    const byId = new Map(jobs.map((job) => [job.id, job]));
    for (const row of selected) {
      const job = byId.get(row.id);
      if (!job) continue;
      await tx.professionalContactEvent.create({
        data: {
          requestId: job.requestId,
          jobId: job.id,
          kind: "job_claimed",
          actor: "agent",
          details: {
            attempt: job.attemptCount,
            claimExpiresAt: claimExpiresAt.toISOString(),
          },
        },
      });
    }
    return selected.flatMap((row) => {
      const job = byId.get(row.id);
      if (!job) return [];
      return [{
        jobId: job.id,
        claimToken: tokenById.get(job.id)!,
        provenanceToken: provenanceTokenById.get(job.id)!,
        claimExpiresAt,
        attemptCount: job.attemptCount,
        personName: job.personName,
        request: job.request,
        priorCandidates: job.candidates.map((candidate) => ({
          candidateId: candidate.id,
          email: candidate.email,
          reviewedState: candidate.decision?.action ?? "pending",
        })),
        policy: {
          professionalBusinessOnly: true,
          noPrivateOrPersonalAddresses: true,
          noAutomaticOutreach: true,
          humanReviewRequired: true,
        },
      }];
    });
  });
}

export function countClaimableProfessionalContactJobs(now = new Date()) {
  return db.professionalContactJob.count({
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
}

export type ProfessionalContactDispatchState =
  | "dispatched"
  | "failed"
  | "in_progress"
  | "already_dispatched"
  | "no_work"
  | "stale";

export interface ProfessionalContactDispatchResult {
  requestId: string;
  state: ProfessionalContactDispatchState;
  triggered: boolean;
  error: string | null;
  updatedAt: Date | null;
}

interface ProfessionalContactDispatchOptions {
  mode?: "submit" | "retry";
  expectedUpdatedAt?: Date;
  now?: Date;
  token?: string;
  fetchImpl?: typeof fetch;
  runTransaction?: ProfessionalContactTransactionRunner;
  trustConfig?: WorkflowTrustConfig | null;
}

function existingDispatchState(
  status: string,
): ProfessionalContactDispatchState {
  if (status === "dispatching") return "in_progress";
  if (status === "dispatched") return "already_dispatched";
  if (status === "failed") return "failed";
  return "stale";
}

async function githubDispatchError(response: Response): Promise<string> {
  let detail = "";
  try {
    const text = (await response.text()).slice(0, 2_000);
    const parsed = text ? (JSON.parse(text) as unknown) : null;
    detail =
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof Reflect.get(parsed, "message") === "string"
        ? String(Reflect.get(parsed, "message"))
        : text;
  } catch {
    detail = "";
  }
  const normalized = detail.replace(/\s+/g, " ").trim().slice(0, 240);
  return normalized
    ? `GitHub workflow dispatch returned ${response.status}: ${normalized}`
    : `GitHub workflow dispatch returned ${response.status}`;
}

export async function dispatchProfessionalContactRequest(
  requestId: string,
  options: ProfessionalContactDispatchOptions = {},
): Promise<ProfessionalContactDispatchResult> {
  const now = options.now ?? new Date();
  const mode = options.mode ?? "submit";
  const runTransaction = options.runTransaction ?? withSerializableRetry;
  const claimed = await runTransaction(async (tx) => {
    const dispatch = await tx.professionalContactDispatch.findUnique({
      where: { requestId },
      select: {
        id: true,
        requestId: true,
        status: true,
        attemptCount: true,
        leaseExpiresAt: true,
        lastError: true,
        updatedAt: true,
        request: {
          select: {
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
    if (!dispatch) {
      return {
        kind: "existing" as const,
        result: {
          requestId,
          state: "stale" as const,
          triggered: false,
          error: "Dispatch state was not found",
          updatedAt: null,
        },
      };
    }
    const hasClaimableWork = dispatch.request.jobs.some(
      (job) =>
        job.status === "pending" ||
        (job.status === "claimed" &&
          (!job.claimExpiresAt || job.claimExpiresAt <= now)),
    );
    if (!hasClaimableWork) {
      return {
        kind: "existing" as const,
        result: {
          requestId,
          state: "no_work" as const,
          triggered: false,
          error: null,
          updatedAt: dispatch.updatedAt,
        },
      };
    }
    if (mode === "submit" && dispatch.attemptCount > 0) {
      return {
        kind: "existing" as const,
        result: {
          requestId,
          state: existingDispatchState(dispatch.status),
          triggered: false,
          error: dispatch.lastError,
          updatedAt: dispatch.updatedAt,
        },
      };
    }
    if (
      mode === "retry" &&
      (!options.expectedUpdatedAt ||
        dispatch.updatedAt.getTime() !== options.expectedUpdatedAt.getTime())
    ) {
      return {
        kind: "existing" as const,
        result: {
          requestId,
          state: "stale" as const,
          triggered: false,
          error: "Dispatch state changed; refresh before retrying",
          updatedAt: dispatch.updatedAt,
        },
      };
    }
    if (
      dispatch.status === "dispatching" &&
      dispatch.leaseExpiresAt &&
      dispatch.leaseExpiresAt > now
    ) {
      return {
        kind: "existing" as const,
        result: {
          requestId,
          state: "in_progress" as const,
          triggered: false,
          error: null,
          updatedAt: dispatch.updatedAt,
        },
      };
    }
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(
      now.getTime() + PROFESSIONAL_CONTACT_DISPATCH_LEASE_MS,
    );
    const attemptNumber = dispatch.attemptCount + 1;
    const updated = await tx.professionalContactDispatch.updateMany({
      where: { id: dispatch.id, updatedAt: dispatch.updatedAt },
      data: {
        status: "dispatching",
        attemptCount: { increment: 1 },
        leaseToken,
        leaseExpiresAt,
        lastAttemptAt: now,
        lastError: null,
      },
    });
    if (updated.count !== 1) {
      return {
        kind: "existing" as const,
        result: {
          requestId,
          state: "stale" as const,
          triggered: false,
          error: "Dispatch was already claimed by another request",
          updatedAt: dispatch.updatedAt,
        },
      };
    }
    await tx.professionalContactDispatchAttempt.create({
      data: {
        dispatchId: dispatch.id,
        attemptNumber,
        status: "dispatching",
        startedAt: now,
      },
    });
    await tx.professionalContactEvent.create({
      data: {
        requestId,
        kind: "dispatch_started",
        actor: "admin",
        details: { attempt: attemptNumber, mode },
      },
    });
    return {
      kind: "claimed" as const,
      dispatchId: dispatch.id,
      attemptNumber,
      leaseToken,
    };
  });
  if (claimed.kind === "existing") return claimed.result;

  let dispatchError: string | null = null;
  try {
    const token =
      options.token ??
      process.env.PROFESSIONAL_CONTACT_RESEARCH_DISPATCH_TOKEN?.trim();
    if (!token) {
      throw new Error(
        "Professional contact worker trigger is not configured",
      );
    }
    const fetchImpl = options.fetchImpl ?? fetch;
    const dispatchTarget = resolveProfessionalContactDispatchTarget(
      Object.prototype.hasOwnProperty.call(options, "trustConfig")
        ? options.trustConfig ?? null
        : TRUST_CONFIG,
    );
    const response = await fetchImpl(
      `https://api.github.com/repos/${encodeURIComponent(
        appConfig.repository.owner,
      )}/${encodeURIComponent(
        appConfig.repository.name,
      )}/actions/workflows/${encodeURIComponent(
        dispatchTarget.workflowFile,
      )}/dispatches`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({
          ref: dispatchTarget.ref,
          inputs: { request_id: requestId },
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (response.status !== 204) {
      dispatchError = await githubDispatchError(response);
    }
  } catch (error) {
    dispatchError = (error instanceof Error ? error.message : String(error))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
  }

  return runTransaction(async (tx) => {
    const current = await tx.professionalContactDispatch.findUnique({
      where: { id: claimed.dispatchId },
      select: { leaseToken: true },
    });
    if (current?.leaseToken !== claimed.leaseToken) {
      return {
        requestId,
        state: "stale",
        triggered: false,
        error: "Dispatch lease changed before completion",
        updatedAt: null,
      };
    }
    const status = dispatchError ? "failed" : "dispatched";
    const dispatch = await tx.professionalContactDispatch.update({
      where: { id: claimed.dispatchId },
      data: {
        status,
        leaseToken: null,
        leaseExpiresAt: null,
        lastError: dispatchError,
        ...(dispatchError ? {} : { lastDispatchedAt: now }),
      },
      select: { updatedAt: true },
    });
    await tx.professionalContactDispatchAttempt.update({
      where: {
        dispatchId_attemptNumber: {
          dispatchId: claimed.dispatchId,
          attemptNumber: claimed.attemptNumber,
        },
      },
      data: {
        status: dispatchError ? "failed" : "succeeded",
        error: dispatchError,
        completedAt: now,
      },
    });
    await tx.professionalContactEvent.create({
      data: {
        requestId,
        kind: dispatchError ? "dispatch_failed" : "dispatch_succeeded",
        actor: "admin",
        details: {
          attempt: claimed.attemptNumber,
          error: dispatchError,
        },
      },
    });
    return {
      requestId,
      state: dispatchError ? "failed" : "dispatched",
      triggered: true,
      error: dispatchError,
      updatedAt: dispatch.updatedAt,
    };
  });
}

export async function submitProfessionalContactResult(
  jobId: string,
  value: unknown,
  now: Date = new Date(),
  runTransaction: ProfessionalContactTransactionRunner = withSerializableRetry,
): Promise<{
  accepted: boolean;
  status: "review" | "exhausted" | "conflict" | "duplicate_candidates";
  idempotent: boolean;
}> {
  return runTransaction(async (tx) => {
    const job = await tx.professionalContactJob.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        requestId: true,
        personName: true,
        status: true,
        claimToken: true,
        claimProvenanceToken: true,
        claimExpiresAt: true,
        resultFingerprint: true,
        request: {
          select: { organizationName: true, website: true },
        },
        attemptCount: true,
      },
    });
    if (!job) return { accepted: false, status: "conflict", idempotent: false };
    const rawClaimToken =
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof Reflect.get(value, "claimToken") === "string"
        ? String(Reflect.get(value, "claimToken"))
        : null;
    const activeClaim =
      job.status === "claimed" &&
      job.claimToken === rawClaimToken &&
      !!job.claimExpiresAt &&
      job.claimExpiresAt > now &&
      !!job.claimProvenanceToken;
    const possibleIdempotentReplay =
      job.claimToken === rawClaimToken &&
      !!job.resultFingerprint &&
      (job.status === "review" || job.status === "exhausted");
    if (!activeClaim && !possibleIdempotentReplay) {
      return { accepted: false, status: "conflict", idempotent: false };
    }
    const submission = parseProfessionalContactSubmission(value, {
      personName: job.personName,
      organizationName: job.request.organizationName,
    });
    if (!job.claimProvenanceToken) {
      return { accepted: false, status: "conflict", idempotent: false };
    }
    validateProfessionalContactProvenance(
      submission,
      submission.provenance,
      {
        claimProvenanceToken: job.claimProvenanceToken,
        personName: job.personName,
        organizationName: job.request.organizationName,
        website: job.request.website,
      },
    );
    const fingerprint = submissionFingerprint(submission);
    if (
      possibleIdempotentReplay &&
      job.resultFingerprint === fingerprint
    ) {
      return {
        accepted: true,
        status: job.status === "review" ? "review" : "exhausted",
        idempotent: true,
      };
    }
    if (!activeClaim) {
      return { accepted: false, status: "conflict", idempotent: false };
    }
    if (submission.outcome === "candidates") {
      const existing = await tx.professionalContactCandidate.findMany({
        where: {
          jobId: job.id,
          normalizedEmail: {
            in: submission.candidates.map((candidate) => candidate.normalizedEmail),
          },
        },
        select: { normalizedEmail: true },
      });
      const existingEmails = new Set(
        existing.map((candidate) => candidate.normalizedEmail),
      );
      const novel = submission.candidates.filter(
        (candidate) => !existingEmails.has(candidate.normalizedEmail),
      );
      if (novel.length === 0) {
        return {
          accepted: false,
          status: "duplicate_candidates",
          idempotent: false,
        };
      }
      await tx.professionalContactCandidate.createMany({
        data: novel.map((candidate) => ({
          jobId: job.id,
          normalizedEmail: candidate.normalizedEmail,
          email: candidate.email,
          personName: candidate.personName,
          roleTitle: candidate.roleTitle,
          organization: candidate.organization,
          confidence: candidate.confidence,
          discoveryMethod: candidate.discoveryMethod,
          evidence: candidate.evidence,
          sourceUrls: candidate.sourceUrls,
          patternEvidence: candidate.patternEvidence,
          patternEvidenceUrl: candidate.patternEvidenceUrl,
          patternExamples: candidate.patternExamples,
        })),
      });
      await tx.professionalContactJob.update({
        where: { id: job.id },
        data: {
          status: "review",
          agentNotes: submission.notes,
          resultFingerprint: fingerprint,
          claimExpiresAt: null,
          completedAt: null,
        },
      });
      await tx.professionalContactEvent.create({
        data: {
          requestId: job.requestId,
          jobId: job.id,
          kind: "result_submitted",
          actor: "agent",
          details: {
            candidates: novel.length,
            notes: submission.notes,
            attempt: job.attemptCount,
          },
        },
      });
      return { accepted: true, status: "review", idempotent: false };
    }
    await tx.professionalContactJob.update({
      where: { id: job.id },
      data: {
        status: "exhausted",
        agentNotes: submission.notes,
        resultFingerprint: fingerprint,
        claimExpiresAt: null,
        completedAt: now,
      },
    });
    await tx.professionalContactEvent.create({
      data: {
        requestId: job.requestId,
        jobId: job.id,
        kind: "job_exhausted",
        actor: "agent",
        details: {
          attempt: job.attemptCount,
          notes: submission.notes,
        },
      },
    });
    return { accepted: true, status: "exhausted", idempotent: false };
  });
}

export async function decideProfessionalContactCandidate(
  candidateId: string,
  action: "approved" | "rejected",
  now: Date = new Date(),
  runTransaction: ProfessionalContactTransactionRunner = withSerializableRetry,
): Promise<{ ok: boolean; idempotent: boolean; error?: string }> {
  try {
    return await runTransaction(async (tx) => {
      const candidate = await tx.professionalContactCandidate.findUnique({
        where: { id: candidateId },
        select: {
          id: true,
          jobId: true,
          decision: { select: { action: true } },
          job: { select: { requestId: true, status: true } },
        },
      });
      if (!candidate) {
        return { ok: false, idempotent: false, error: "Candidate not found" };
      }
      if (candidate.decision) {
        return candidate.decision.action === action
          ? { ok: true, idempotent: true }
          : {
              ok: false,
              idempotent: false,
              error: "Candidate already has an immutable human decision",
            };
      }
      if (candidate.job.status !== "review") {
        return {
          ok: false,
          idempotent: false,
          error: "Candidate is no longer reviewable",
        };
      }
      await tx.professionalContactDecision.create({
        data: { candidateId: candidate.id, action, decidedAt: now },
      });
      await tx.professionalContactEvent.create({
        data: {
          requestId: candidate.job.requestId,
          jobId: candidate.jobId,
          candidateId: candidate.id,
          kind:
            action === "approved" ? "candidate_approved" : "candidate_rejected",
          actor: "admin",
        },
      });
      const remaining = await tx.professionalContactCandidate.count({
        where: { jobId: candidate.jobId, decision: null },
      });
      if (remaining === 0) {
        await tx.professionalContactJob.update({
          where: { id: candidate.jobId },
          data: { status: "completed", completedAt: now },
        });
      }
      return { ok: true, idempotent: false };
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const existing = await db.professionalContactDecision.findUnique({
        where: { candidateId },
        select: { action: true },
      });
      return existing?.action === action
        ? { ok: true, idempotent: true }
        : {
            ok: false,
            idempotent: false,
            error: "Candidate already has an immutable human decision",
          };
    }
    throw error;
  }
}

export async function requeueProfessionalContactJob(
  jobId: string,
  runTransaction: ProfessionalContactTransactionRunner = withSerializableRetry,
): Promise<boolean> {
  return runTransaction(async (tx) => {
    const job = await tx.professionalContactJob.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        requestId: true,
        status: true,
        agentNotes: true,
        candidates: {
          select: { decision: { select: { action: true } } },
        },
      },
    });
    if (!job) return false;
    if (job.status === "pending") return true;
    const hasApproval = job.candidates.some(
      (candidate) => candidate.decision?.action === "approved",
    );
    if (
      job.status !== "exhausted" &&
      !(job.status === "completed" && !hasApproval)
    ) {
      return false;
    }
    await tx.professionalContactJob.update({
      where: { id: job.id },
      data: {
        status: "pending",
        claimedAt: null,
        claimExpiresAt: null,
        claimToken: null,
        claimProvenanceToken: null,
        resultFingerprint: null,
        completedAt: null,
      },
    });
    await tx.professionalContactEvent.create({
      data: {
        requestId: job.requestId,
        jobId: job.id,
        kind: "job_requeued",
        actor: "admin",
        details: {
          previousStatus: job.status,
          previousAgentNotes: job.agentNotes,
        },
      },
    });
    return true;
  });
}

interface ProfessionalContactAuthorizationOptions {
  environment?: AgentMutationEnvironment;
  staticToken?: string;
  verifyGithubActionsToken?: (token: string) => Promise<boolean>;
}

export async function isValidProfessionalContactAuthorization(
  authorization: string | null,
  options: ProfessionalContactAuthorizationOptions = {},
): Promise<boolean> {
  return isValidAgentMutationAuthorization(authorization, {
    environment: options.environment,
    staticSecrets:
      options.staticToken ??
      process.env.PROFESSIONAL_CONTACT_RESEARCH_AGENT_TOKEN,
    verifyOidcToken:
      options.verifyGithubActionsToken ??
      verifyGithubActionsProfessionalContactToken,
  });
}

export function isTrustedProfessionalContactOidcClaims(
  payload: JWTPayload,
  configuration: WorkflowTrustConfig | null = TRUST_CONFIG,
): boolean {
  if (!configuration) return false;
  return (
    payload.aud === PROFESSIONAL_CONTACT_OIDC_AUDIENCE &&
    payload.repository === configuration.repository &&
    payload.repository_owner === configuration.owner &&
    payload.ref === "refs/heads/main" &&
    payload.workflow_ref === configuration.workflowRef &&
    (payload.event_name === "schedule" ||
      payload.event_name === "workflow_dispatch")
  );
}

export async function verifyGithubActionsProfessionalContactToken(
  token: string,
): Promise<boolean> {
  if (token.split(".").length !== 3) return false;
  try {
    const { payload } = await jwtVerify(token, githubActionsJwks, {
      issuer: PROFESSIONAL_CONTACT_OIDC_ISSUER,
      audience: PROFESSIONAL_CONTACT_OIDC_AUDIENCE,
      maxTokenAge: "10m",
    });
    return isTrustedProfessionalContactOidcClaims(payload);
  } catch {
    return false;
  }
}
