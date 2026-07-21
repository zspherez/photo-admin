import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
} from "jose";
import { isProductionAgentEnvironment } from "@/lib/agentMutationAuthorization";
import { db } from "@/lib/db";
import {
  parseTrajectoryManifest,
  TRAJECTORY_RAW_SIZE_LIMIT_BYTES,
  TrajectoryContractError,
  TrajectoryDigestMismatchError,
} from "@/lib/trajectoryContract";
import {
  importTrajectoryManifest,
  TrajectoryImportError,
  type TrajectoryImportOptions,
  type TrajectoryImportSummary,
} from "@/lib/trajectoryImport";
import {
  IntegrationSyncLeaseLostError,
  OperationDeadlineExceededError,
} from "@/lib/integrationUtils";

export const TRAJECTORY_INGEST_AUDIENCE = "photo-admin-trajectory-ingest";
export const TRAJECTORY_INGEST_ISSUER =
  "https://token.actions.githubusercontent.com";
export const TRAJECTORY_INGEST_MAIN_REF = "refs/heads/main";
export const TRAJECTORY_INGEST_EVENT = "workflow_dispatch";
export const TRAJECTORY_INGEST_PATH =
  "/api/integrations/trajectory-runs";

const REQUEST_FRESHNESS_MS = 10 * 60 * 1_000;
const REQUEST_FUTURE_TOLERANCE_MS = 60 * 1_000;
const PROCESSING_STALE_MS = 5 * 60 * 1_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const GITHUB_REPOSITORY_PATTERN =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_SHA_PATTERN = /^[0-9a-f]{40}$/;
const githubActionsJwks = createRemoteJWKSet(
  new URL(`${TRAJECTORY_INGEST_ISSUER}/.well-known/jwks`),
);

export type TrajectoryIngestMode = "dry-run" | "apply";
export type TrajectoryIngestAuthMode = "oidc" | "hmac" | "oidc-or-hmac";

export interface TrajectoryIngestEnvironment {
  NODE_ENV?: string;
  VERCEL_ENV?: string;
  VERCEL_TARGET_ENV?: string;
  TRAJECTORY_INGEST_AUTH_MODE?: string;
  TRAJECTORY_INGEST_GITHUB_REPOSITORY?: string;
  TRAJECTORY_INGEST_GITHUB_WORKFLOW_REF?: string;
  TRAJECTORY_INGEST_HMAC_SECRET?: string;
  TRAJECTORY_INGEST_RECEIPT_SECRET?: string;
}

export interface TrajectoryOidcConfiguration {
  repository: string;
  owner: string;
  workflowRef: string;
}

export interface TrajectoryIngestIdentity {
  kind: "oidc" | "hmac";
  revision: string | null;
}

export interface TrajectoryIngestStoredRequest {
  idempotencyKey: string;
  ownerToken: string;
  producerRunId: string;
  artifactSha256: string;
  mode: TrajectoryIngestMode;
  producedAt: Date;
  status: "processing" | "completed";
  response: unknown | null;
  httpStatus: number | null;
  updatedAt: Date;
}

export type TrajectoryIngestClaim =
  | {
      kind: "claimed";
      ownerToken: string;
    }
  | {
      kind: "replay";
      response: unknown;
      httpStatus: number;
    }
  | {
      kind: "busy";
    }
  | {
      kind: "conflict";
    };

export interface TrajectoryIngestRequestPersistence {
  claim(input: {
    idempotencyKey: string;
    producerRunId: string;
    artifactSha256: string;
    mode: TrajectoryIngestMode;
    producedAt: Date;
    now: Date;
  }): Promise<TrajectoryIngestClaim>;
  complete(input: {
    idempotencyKey: string;
    ownerToken: string;
    response: Record<string, unknown>;
    httpStatus: number;
    completedAt: Date;
  }): Promise<void>;
  abandon(idempotencyKey: string, ownerToken: string): Promise<void>;
}

export interface TrajectoryIngestDependencies {
  environment?: TrajectoryIngestEnvironment;
  now?: () => Date;
  persistence?: TrajectoryIngestRequestPersistence;
  importManifest?: (
    raw: Buffer,
    options: TrajectoryImportOptions,
  ) => Promise<TrajectoryImportSummary>;
  verifyOidcToken?: (
    token: string,
    configuration: TrajectoryOidcConfiguration,
  ) => Promise<TrajectoryIngestIdentity | null>;
}

export class TrajectoryIngestHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "TrajectoryIngestHttpError";
  }
}

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

function safeErrorResponse(error: unknown): Response {
  if (error instanceof TrajectoryIngestHttpError) {
    return jsonResponse(
      {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        },
      },
      error.status,
    );
  }
  if (
    error instanceof TrajectoryDigestMismatchError
  ) {
    return jsonResponse(
      {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          retryable: false,
        },
      },
      400,
    );
  }
  if (error instanceof TrajectoryContractError) {
    return jsonResponse(
      {
        ok: false,
        error: {
          code: error.code,
          message: "Trajectory manifest failed contract validation",
          retryable: false,
        },
      },
      400,
    );
  }
  if (error instanceof TrajectoryImportError) {
    const conflictCodes = new Set([
      "trajectory_run_digest_conflict",
      "trajectory_run_not_newer",
      "trajectory_mapping_changed",
    ]);
    return jsonResponse(
      {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          retryable: false,
        },
      },
      conflictCodes.has(error.code) ? 409 : 422,
    );
  }
  if (
    error instanceof IntegrationSyncLeaseLostError ||
    error instanceof OperationDeadlineExceededError
  ) {
    return jsonResponse(
      {
        ok: false,
        error: {
          code:
            "code" in error && typeof error.code === "string"
              ? error.code
              : "trajectory_ingest_retry",
          message:
            "Trajectory promotion did not complete; the active run was preserved",
          retryable: true,
        },
      },
      503,
    );
  }
  return jsonResponse(
    {
      ok: false,
      error: {
        code: "trajectory_ingest_failed",
        message:
          "Trajectory promotion failed without changing the active run",
        retryable: true,
      },
    },
    500,
  );
}

function forwardedRequestProtocol(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-proto");
  return forwarded
    ? forwarded.split(",")[0].trim().toLowerCase()
    : null;
}

export function assertTrustedTrajectoryRequestContext(
  request: Request,
  environment: TrajectoryIngestEnvironment = process.env,
): void {
  const forwardedProtocol = forwardedRequestProtocol(request);
  if (
    isProductionAgentEnvironment(environment) &&
    (new URL(request.url).protocol !== "https:" ||
      (forwardedProtocol !== null && forwardedProtocol !== "https"))
  ) {
    throw new TrajectoryIngestHttpError(
      400,
      "trajectory_https_required",
      "Production trajectory ingestion requires HTTPS",
    );
  }
}

function requiredHeader(request: Request, name: string): string {
  const value = request.headers.get(name)?.trim();
  if (!value) {
    throw new TrajectoryIngestHttpError(
      400,
      "trajectory_header_missing",
      `Missing required ${name} header`,
    );
  }
  return value;
}

function parseMode(request: Request): TrajectoryIngestMode {
  const mode = requiredHeader(request, "X-Trajectory-Mode");
  if (mode !== "dry-run" && mode !== "apply") {
    throw new TrajectoryIngestHttpError(
      400,
      "trajectory_mode_invalid",
      "X-Trajectory-Mode must be dry-run or apply",
    );
  }
  return mode;
}

function parseProducedAt(value: string, now: Date): Date {
  const producedAt = new Date(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ||
    !Number.isFinite(producedAt.getTime())
  ) {
    throw new TrajectoryIngestHttpError(
      400,
      "trajectory_produced_at_invalid",
      "X-Produced-At must be a UTC ISO timestamp",
    );
  }
  const age = now.getTime() - producedAt.getTime();
  if (
    age > REQUEST_FRESHNESS_MS ||
    age < -REQUEST_FUTURE_TOLERANCE_MS
  ) {
    throw new TrajectoryIngestHttpError(
      409,
      "trajectory_request_stale",
      "Trajectory ingest request timestamp is outside the allowed window",
    );
  }
  return producedAt;
}

function parseContentLength(request: Request): number {
  const value = requiredHeader(request, "Content-Length");
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new TrajectoryIngestHttpError(
      400,
      "trajectory_content_length_invalid",
      "Content-Length must be a positive integer",
    );
  }
  const size = Number(value);
  if (!Number.isSafeInteger(size)) {
    throw new TrajectoryIngestHttpError(
      400,
      "trajectory_content_length_invalid",
      "Content-Length is invalid",
    );
  }
  if (size > TRAJECTORY_RAW_SIZE_LIMIT_BYTES) {
    throw new TrajectoryIngestHttpError(
      413,
      "trajectory_manifest_too_large",
      `Trajectory manifest exceeds ${TRAJECTORY_RAW_SIZE_LIMIT_BYTES} bytes`,
    );
  }
  return size;
}

export async function readTrajectoryRequestBody(
  request: Request,
  declaredLength: number,
): Promise<Buffer> {
  const reader = request.body?.getReader();
  if (!reader) {
    throw new TrajectoryIngestHttpError(
      400,
      "trajectory_body_missing",
      "Trajectory manifest body is required",
    );
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > TRAJECTORY_RAW_SIZE_LIMIT_BYTES) {
      await reader.cancel();
      throw new TrajectoryIngestHttpError(
        413,
        "trajectory_manifest_too_large",
        `Trajectory manifest exceeds ${TRAJECTORY_RAW_SIZE_LIMIT_BYTES} bytes`,
      );
    }
    chunks.push(result.value);
  }
  if (total !== declaredLength) {
    throw new TrajectoryIngestHttpError(
      400,
      "trajectory_content_length_mismatch",
      "Content-Length does not match the received trajectory manifest",
    );
  }
  return Buffer.concat(
    chunks.map((chunk) =>
      Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
    ),
    total,
  );
}

export function trajectoryHmacCanonicalMessage(input: {
  idempotencyKey: string;
  producedAt: string;
  artifactSha256: string;
  mode: TrajectoryIngestMode;
  contentLength: number;
  applyConfirmation: string;
  dryRunReceipt: string;
}): string {
  return [
    "POST",
    TRAJECTORY_INGEST_PATH,
    input.idempotencyKey,
    input.producedAt,
    input.artifactSha256,
    input.mode,
    String(input.contentLength),
    input.applyConfirmation,
    input.dryRunReceipt,
  ].join("\n");
}

export function createTrajectoryHmacSignature(
  secret: string,
  canonicalMessage: string,
): string {
  return `sha256=${createHmac("sha256", secret)
    .update(canonicalMessage)
    .digest("hex")}`;
}

function constantTimeSignatureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

export function trajectoryOidcConfiguration(
  environment: TrajectoryIngestEnvironment,
): TrajectoryOidcConfiguration | null {
  const repository =
    environment.TRAJECTORY_INGEST_GITHUB_REPOSITORY?.trim();
  const workflowRef =
    environment.TRAJECTORY_INGEST_GITHUB_WORKFLOW_REF?.trim();
  if (
    !repository ||
    !workflowRef ||
    !GITHUB_REPOSITORY_PATTERN.test(repository)
  ) {
    return null;
  }
  const owner = repository.split("/")[0];
  const workflowPrefix = `${repository}/.github/workflows/`;
  if (
    !workflowRef.startsWith(workflowPrefix) ||
    !workflowRef.endsWith(`@${TRAJECTORY_INGEST_MAIN_REF}`)
  ) {
    return null;
  }
  const workflowFile = workflowRef.slice(
    workflowPrefix.length,
    -`@${TRAJECTORY_INGEST_MAIN_REF}`.length,
  );
  if (
    !/^[A-Za-z0-9_.-]+\.(?:yml|yaml)$/.test(workflowFile)
  ) {
    return null;
  }
  return { repository, owner, workflowRef };
}

export function isTrustedTrajectoryOidcClaims(
  payload: JWTPayload,
  configuration: TrajectoryOidcConfiguration,
): boolean {
  return (
    payload.aud === TRAJECTORY_INGEST_AUDIENCE &&
    payload.repository === configuration.repository &&
    payload.repository_owner === configuration.owner &&
    payload.ref === TRAJECTORY_INGEST_MAIN_REF &&
    payload.workflow_ref === configuration.workflowRef &&
    payload.event_name === TRAJECTORY_INGEST_EVENT &&
    typeof payload.sha === "string" &&
    GITHUB_SHA_PATTERN.test(payload.sha)
  );
}

export async function verifyGithubActionsTrajectoryToken(
  token: string,
  configuration: TrajectoryOidcConfiguration,
): Promise<TrajectoryIngestIdentity | null> {
  if (token.split(".").length !== 3) return null;
  try {
    const { payload } = await jwtVerify(token, githubActionsJwks, {
      issuer: TRAJECTORY_INGEST_ISSUER,
      audience: TRAJECTORY_INGEST_AUDIENCE,
      maxTokenAge: "5m",
      clockTolerance: "30s",
    });
    if (!isTrustedTrajectoryOidcClaims(payload, configuration)) {
      return null;
    }
    return { kind: "oidc", revision: payload.sha as string };
  } catch {
    return null;
  }
}

function configuredAuthMode(
  environment: TrajectoryIngestEnvironment,
): TrajectoryIngestAuthMode {
  const mode = environment.TRAJECTORY_INGEST_AUTH_MODE?.trim() || "oidc";
  if (
    mode !== "oidc" &&
    mode !== "hmac" &&
    mode !== "oidc-or-hmac"
  ) {
    throw new TrajectoryIngestHttpError(
      503,
      "trajectory_auth_not_configured",
      "Trajectory ingest authentication is not configured",
    );
  }
  return mode;
}

async function authenticateTrajectoryRequest(
  request: Request,
  input: {
    idempotencyKey: string;
    producedAt: string;
    artifactSha256: string;
    mode: TrajectoryIngestMode;
    contentLength: number;
    applyConfirmation: string;
    dryRunReceipt: string;
  },
  dependencies: TrajectoryIngestDependencies,
): Promise<TrajectoryIngestIdentity> {
  const environment = dependencies.environment ?? process.env;
  const mode = configuredAuthMode(environment);
  const configuration =
    mode === "oidc" || mode === "oidc-or-hmac"
      ? trajectoryOidcConfiguration(environment)
      : null;
  const hmacSecret =
    mode === "hmac" || mode === "oidc-or-hmac"
      ? environment.TRAJECTORY_INGEST_HMAC_SECRET
      : undefined;
  if (
    (mode === "oidc" && !configuration) ||
    (mode === "hmac" &&
      (!hmacSecret || Buffer.byteLength(hmacSecret) < 32)) ||
    (mode === "oidc-or-hmac" &&
      !configuration &&
      (!hmacSecret || Buffer.byteLength(hmacSecret) < 32))
  ) {
    throw new TrajectoryIngestHttpError(
      503,
      "trajectory_auth_not_configured",
      "Trajectory ingest authentication is not configured",
    );
  }
  if (mode === "oidc" || mode === "oidc-or-hmac") {
    const authorization = request.headers.get("authorization");
    if (configuration && authorization?.startsWith("Bearer ")) {
      const token = authorization.slice("Bearer ".length);
      const identity = await (
        dependencies.verifyOidcToken ??
        verifyGithubActionsTrajectoryToken
      )(token, configuration);
      if (identity) return identity;
    }
  }
  if (mode === "hmac" || mode === "oidc-or-hmac") {
    const signature = request.headers.get("x-signature")?.trim();
    if (
      hmacSecret &&
      Buffer.byteLength(hmacSecret) >= 32 &&
      signature
    ) {
      const canonical = trajectoryHmacCanonicalMessage(input);
      const expected = createTrajectoryHmacSignature(
        hmacSecret,
        canonical,
      );
      if (constantTimeSignatureEqual(signature, expected)) {
        return { kind: "hmac", revision: null };
      }
    }
  }
  throw new TrajectoryIngestHttpError(
    401,
    "trajectory_unauthorized",
    "Trajectory ingest authorization failed",
  );
}

function requestMatches(
  existing: TrajectoryIngestStoredRequest,
  input: {
    producerRunId: string;
    artifactSha256: string;
    mode: TrajectoryIngestMode;
    producedAt: Date;
  },
): boolean {
  return (
    existing.producerRunId === input.producerRunId &&
    existing.artifactSha256 === input.artifactSha256 &&
    existing.mode === input.mode &&
    existing.producedAt.getTime() === input.producedAt.getTime()
  );
}

type TrajectoryIngestStoredRow = Omit<
  TrajectoryIngestStoredRequest,
  "mode" | "status"
> & {
  mode: string;
  status: string;
};

function asStoredRequest(
  value: TrajectoryIngestStoredRow,
): TrajectoryIngestStoredRequest {
  if (
    (value.mode !== "dry-run" && value.mode !== "apply") ||
    (value.status !== "processing" && value.status !== "completed")
  ) {
    throw new Error("Stored trajectory ingest request is invalid");
  }
  return {
    ...value,
    mode: value.mode,
    status: value.status,
  };
}

export function createPrismaTrajectoryIngestPersistence(): TrajectoryIngestRequestPersistence {
  return {
    async claim(input) {
      const ownerToken = randomUUID();
      try {
        await db.trajectoryIngestRequest.create({
          data: {
            idempotencyKey: input.idempotencyKey,
            ownerToken,
            producerRunId: input.producerRunId,
            artifactSha256: input.artifactSha256,
            mode: input.mode,
            producedAt: input.producedAt,
            status: "processing",
          },
        });
        return { kind: "claimed", ownerToken };
      } catch (error) {
        if (
          !(
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2002"
          )
        ) {
          throw error;
        }
      }

      const existingValue =
        await db.trajectoryIngestRequest.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
        });
      if (!existingValue) {
        throw new Error("Trajectory idempotency request disappeared");
      }
      const existing = asStoredRequest(existingValue);
      if (!requestMatches(existing, input)) return { kind: "conflict" };
      if (
        existing.status === "completed" &&
        existing.response &&
        existing.httpStatus
      ) {
        return {
          kind: "replay",
          response: existing.response,
          httpStatus: existing.httpStatus,
        };
      }
      if (
        input.now.getTime() - existing.updatedAt.getTime() <
        PROCESSING_STALE_MS
      ) {
        return { kind: "busy" };
      }
      const reclaimed =
        await db.trajectoryIngestRequest.updateMany({
          where: {
            idempotencyKey: input.idempotencyKey,
            ownerToken: existing.ownerToken,
            status: "processing",
            updatedAt: existing.updatedAt,
          },
          data: { ownerToken },
        });
      return reclaimed.count === 1
        ? { kind: "claimed", ownerToken }
        : { kind: "busy" };
    },
    async complete(input) {
      const result = await db.trajectoryIngestRequest.updateMany({
        where: {
          idempotencyKey: input.idempotencyKey,
          ownerToken: input.ownerToken,
          status: "processing",
        },
        data: {
          status: "completed",
          response: input.response as Prisma.InputJsonValue,
          httpStatus: input.httpStatus,
          completedAt: input.completedAt,
        },
      });
      if (result.count !== 1) {
        throw new Error("Trajectory idempotency claim was lost");
      }
    },
    async abandon(idempotencyKey, ownerToken) {
      await db.trajectoryIngestRequest.deleteMany({
        where: {
          idempotencyKey,
          ownerToken,
          status: "processing",
        },
      });
    },
  };
}

function successfulResponse(
  summary: TrajectoryImportSummary,
  identity: TrajectoryIngestIdentity,
  replayed: boolean,
  dryRunReceipt?: string,
): Record<string, unknown> {
  return {
    ok: true,
    event:
      summary.mode === "dry-run"
        ? "trajectory_ingest_dry_run_complete"
        : summary.status === "noop"
          ? "trajectory_ingest_noop"
          : "trajectory_ingest_applied",
    authenticatedBy: identity.kind,
    replayed,
    summary,
    ...(dryRunReceipt ? { dryRunReceipt } : {}),
  };
}

interface TrajectoryDryRunReceipt {
  version: 1;
  producerRunId: string;
  artifactSha256: string;
  issuedAt: string;
  expiresAt: string;
  mappedSuggestedRecommendationCount: number;
  suggestedRecommendationCount: number;
  unresolvedNonSuggestedRate: number;
  maximumUnmappedRate: number;
}

function receiptSecret(
  environment: TrajectoryIngestEnvironment,
): string {
  const secret = environment.TRAJECTORY_INGEST_RECEIPT_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new TrajectoryIngestHttpError(
      503,
      "trajectory_receipt_not_configured",
      "Trajectory dry-run receipt signing is not configured",
    );
  }
  return secret;
}

function signDryRunReceipt(
  summary: TrajectoryImportSummary,
  now: Date,
  environment: TrajectoryIngestEnvironment,
): string {
  const payload: TrajectoryDryRunReceipt = {
    version: 1,
    producerRunId: summary.producerRunId,
    artifactSha256: summary.artifactSha256,
    issuedAt: now.toISOString(),
    expiresAt: new Date(
      Math.min(
        now.getTime() + 30 * 60 * 1_000,
        Date.parse(summary.validUntil),
      ),
    ).toISOString(),
    mappedSuggestedRecommendationCount:
      summary.mappedSuggestedRecommendationCount,
    suggestedRecommendationCount: summary.suggestedRecommendationCount,
    unresolvedNonSuggestedRate: summary.unresolvedNonSuggestedRate,
    maximumUnmappedRate: summary.maximumUnmappedRate,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString(
    "base64url",
  );
  const signature = createHmac(
    "sha256",
    receiptSecret(environment),
  )
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${signature}`;
}

function verifyDryRunReceipt(
  receipt: string,
  input: {
    producerRunId: string;
    artifactSha256: string;
    now: Date;
  },
  environment: TrajectoryIngestEnvironment,
): void {
  if (receipt.length > 4_096) {
    throw new TrajectoryIngestHttpError(
      428,
      "trajectory_dry_run_receipt_invalid",
      "Apply requires a valid dry-run receipt",
    );
  }
  const [encoded, signature, extra] = receipt.split(".");
  if (!encoded || !signature || extra) {
    throw new TrajectoryIngestHttpError(
      428,
      "trajectory_dry_run_receipt_invalid",
      "Apply requires a valid dry-run receipt",
    );
  }
  const expected = createHmac(
    "sha256",
    receiptSecret(environment),
  )
    .update(encoded)
    .digest("base64url");
  if (!constantTimeSignatureEqual(signature, expected)) {
    throw new TrajectoryIngestHttpError(
      428,
      "trajectory_dry_run_receipt_invalid",
      "Apply requires a valid dry-run receipt",
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    );
  } catch {
    throw new TrajectoryIngestHttpError(
      428,
      "trajectory_dry_run_receipt_invalid",
      "Apply requires a valid dry-run receipt",
    );
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new TrajectoryIngestHttpError(
      428,
      "trajectory_dry_run_receipt_invalid",
      "Apply requires a valid dry-run receipt",
    );
  }
  const value = payload as Partial<TrajectoryDryRunReceipt>;
  if (
    value.version !== 1 ||
    value.producerRunId !== input.producerRunId ||
    value.artifactSha256 !== input.artifactSha256 ||
    typeof value.issuedAt !== "string" ||
    !Number.isFinite(Date.parse(value.issuedAt)) ||
    Date.parse(value.issuedAt) > input.now.getTime() + 60 * 1_000 ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    Date.parse(value.expiresAt) >
      Date.parse(value.issuedAt) + 30 * 60 * 1_000 ||
    Date.parse(value.expiresAt) <= input.now.getTime() ||
    !Number.isInteger(value.suggestedRecommendationCount) ||
    (value.suggestedRecommendationCount ?? -1) < 0 ||
    !Number.isInteger(value.mappedSuggestedRecommendationCount) ||
    (value.mappedSuggestedRecommendationCount ?? -1) < 0 ||
    value.mappedSuggestedRecommendationCount !==
      value.suggestedRecommendationCount ||
    typeof value.unresolvedNonSuggestedRate !== "number" ||
    !Number.isFinite(value.unresolvedNonSuggestedRate) ||
    value.unresolvedNonSuggestedRate < 0 ||
    value.unresolvedNonSuggestedRate > 1 ||
    typeof value.maximumUnmappedRate !== "number" ||
    !Number.isFinite(value.maximumUnmappedRate) ||
    value.maximumUnmappedRate < 0 ||
    value.maximumUnmappedRate > 1 ||
    value.unresolvedNonSuggestedRate > value.maximumUnmappedRate
  ) {
    throw new TrajectoryIngestHttpError(
      428,
      "trajectory_dry_run_receipt_invalid",
      "Apply requires a successful exact-run dry-run receipt",
    );
  }
}

export async function handleTrajectoryIngestRequest(
  request: Request,
  dependencies: TrajectoryIngestDependencies = {},
): Promise<Response> {
  let claim:
    | {
        idempotencyKey: string;
        ownerToken: string;
      }
    | undefined;
  const persistence =
    dependencies.persistence ??
    createPrismaTrajectoryIngestPersistence();
  try {
    assertTrustedTrajectoryRequestContext(
      request,
      dependencies.environment ?? process.env,
    );
    if (
      request.headers.get("content-type")?.split(";")[0].trim() !==
      "application/json"
    ) {
      throw new TrajectoryIngestHttpError(
        415,
        "trajectory_content_type_invalid",
        "Trajectory manifest Content-Type must be application/json",
      );
    }
    if (request.headers.has("content-encoding")) {
      throw new TrajectoryIngestHttpError(
        415,
        "trajectory_content_encoding_invalid",
        "Trajectory manifest must be sent as raw JSON bytes",
      );
    }

    const now = (dependencies.now ?? (() => new Date()))();
    const mode = parseMode(request);
    const idempotencyKey = requiredHeader(
      request,
      "Idempotency-Key",
    );
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw new TrajectoryIngestHttpError(
        400,
        "trajectory_idempotency_key_invalid",
        "Idempotency-Key must be 8-128 safe ASCII characters",
      );
    }
    const producedAtValue = requiredHeader(request, "X-Produced-At");
    const producedAt = parseProducedAt(producedAtValue, now);
    const expectedDigest = requiredHeader(
      request,
      "X-Content-SHA256",
    );
    if (!SHA256_PATTERN.test(expectedDigest)) {
      throw new TrajectoryIngestHttpError(
        400,
        "trajectory_digest_invalid",
        "X-Content-SHA256 must be a lowercase SHA-256 value",
      );
    }
    const contentLength = parseContentLength(request);
    const applyConfirmation =
      request.headers.get("x-trajectory-apply-confirmation")?.trim() ??
      "";
    const dryRunReceipt =
      request.headers.get("x-trajectory-dry-run-receipt")?.trim() ?? "";
    const raw = await readTrajectoryRequestBody(request, contentLength);
    const actualDigest = createHash("sha256").update(raw).digest("hex");
    if (actualDigest !== expectedDigest) {
      throw new TrajectoryDigestMismatchError();
    }

    const identity = await authenticateTrajectoryRequest(
      request,
      {
        idempotencyKey,
        producedAt: producedAtValue,
        artifactSha256: expectedDigest,
        mode,
        contentLength,
        applyConfirmation,
        dryRunReceipt,
      },
      dependencies,
    );
    const parsed = parseTrajectoryManifest(raw, expectedDigest);
    const producerRunId = parsed.manifest.producer_run_id;
    if (
      identity.kind === "oidc" &&
      parsed.manifest.producer_revision !== identity.revision
    ) {
      throw new TrajectoryIngestHttpError(
        409,
        "trajectory_revision_mismatch",
        "Manifest producer revision does not match the trusted workflow revision",
      );
    }
    const requiredConfirmation =
      `apply:${producerRunId}:${expectedDigest}`;
    if (
      mode === "apply" &&
      applyConfirmation !== requiredConfirmation
    ) {
      throw new TrajectoryIngestHttpError(
        428,
        "trajectory_apply_confirmation_required",
        "Apply requires confirmation for the exact run and digest",
      );
    }

    if (mode === "dry-run") {
      const environment = dependencies.environment ?? process.env;
      receiptSecret(environment);
      const summary = await (
        dependencies.importManifest ?? importTrajectoryManifest
      )(raw, {
        dryRun: true,
        expectedDigest,
      });
      if (
        summary.mode !== "dry-run" ||
        (summary.status !== "planned" && summary.status !== "noop") ||
        summary.mappedSuggestedRecommendationCount !==
          summary.suggestedRecommendationCount ||
        summary.unresolvedNonSuggestedRate >
          summary.maximumUnmappedRate
      ) {
        throw new Error("Trajectory dry-run summary invariant failed");
      }
      const receipt = signDryRunReceipt(
        summary,
        now,
        environment,
      );
      return jsonResponse(
        successfulResponse(summary, identity, false, receipt),
        200,
      );
    }

    verifyDryRunReceipt(
      dryRunReceipt,
      { producerRunId, artifactSha256: expectedDigest, now },
      dependencies.environment ?? process.env,
    );

    const claimed = await persistence.claim({
      idempotencyKey,
      producerRunId,
      artifactSha256: expectedDigest,
      mode,
      producedAt,
      now,
    });
    if (claimed.kind === "conflict") {
      throw new TrajectoryIngestHttpError(
        409,
        "trajectory_idempotency_conflict",
        "Idempotency-Key was already used for a different request",
      );
    }
    if (claimed.kind === "busy") {
      throw new TrajectoryIngestHttpError(
        409,
        "trajectory_request_in_progress",
        "The identical trajectory ingest request is already in progress",
        true,
      );
    }
    if (claimed.kind === "replay") {
      if (
        typeof claimed.response !== "object" ||
        claimed.response === null ||
        Array.isArray(claimed.response)
      ) {
        throw new Error("Stored trajectory ingest response is invalid");
      }
      return jsonResponse(
        {
          ...(claimed.response as Record<string, unknown>),
          replayed: true,
        },
        claimed.httpStatus,
      );
    }
    claim = { idempotencyKey, ownerToken: claimed.ownerToken };

    const summary = await (
      dependencies.importManifest ?? importTrajectoryManifest
    )(raw, {
      dryRun: false,
      expectedDigest,
    });
    if (summary.status === "busy") {
      throw new TrajectoryIngestHttpError(
        409,
        "trajectory_import_lease_busy",
        "Another trajectory promotion currently holds the import lease",
        true,
      );
    }
    const status = summary.status === "imported" ? 201 : 200;
    const response = successfulResponse(summary, identity, false);
    await persistence.complete({
      idempotencyKey,
      ownerToken: claimed.ownerToken,
      response,
      httpStatus: status,
      completedAt: (dependencies.now ?? (() => new Date()))(),
    });
    claim = undefined;
    return jsonResponse(response, status);
  } catch (error) {
    if (claim) {
      try {
        await persistence.abandon(
          claim.idempotencyKey,
          claim.ownerToken,
        );
      } catch {
        return safeErrorResponse(
          new TrajectoryIngestHttpError(
            503,
            "trajectory_idempotency_cleanup_failed",
            "Trajectory ingest failed and request cleanup must be retried",
            true,
          ),
        );
      }
    }
    return safeErrorResponse(error);
  }
}
