import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export const ROUTE_DEADLINE_SAFETY_MARGIN_MS = 15_000;
export const PROVIDER_REQUEST_MIN_REMAINING_MS = 5_000;

export interface OperationDeadline {
  readonly expiresAtMs: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

interface OperationDeadlineOptions {
  safetyMarginMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class OperationDeadlineExceededError extends Error {
  readonly code = "operation_deadline_exceeded";

  constructor(
    readonly operation: string,
    readonly requiredMs: number,
    readonly remainingMs: number,
    readonly expiresAtMs: number
  ) {
    super(
      `${operation} requires ${requiredMs}ms but only ${remainingMs}ms remain before the operation deadline`
    );
    this.name = "OperationDeadlineExceededError";
  }
}

export function createOperationDeadline(
  durationMs: number,
  options: OperationDeadlineOptions = {}
): OperationDeadline {
  const safetyMarginMs = options.safetyMarginMs ?? 0;
  if (
    !Number.isFinite(durationMs) ||
    !Number.isFinite(safetyMarginMs) ||
    durationMs <= 0 ||
    safetyMarginMs < 0 ||
    safetyMarginMs >= durationMs
  ) {
    throw new Error("Invalid operation deadline timing");
  }
  const now = options.now ?? Date.now;
  return {
    expiresAtMs: now() + durationMs - safetyMarginMs,
    now,
    sleep: options.sleep ?? sleep,
  };
}

export function remainingOperationTimeMs(
  deadline: OperationDeadline
): number {
  return Math.max(0, deadline.expiresAtMs - deadline.now());
}

export function assertOperationTimeRemaining(
  deadline: OperationDeadline,
  requiredMs: number,
  operation: string
): number {
  if (!Number.isFinite(requiredMs) || requiredMs < 0) {
    throw new Error("requiredMs must be a non-negative number");
  }
  const remainingMs = remainingOperationTimeMs(deadline);
  if (remainingMs < requiredMs) {
    throw new OperationDeadlineExceededError(
      operation,
      requiredMs,
      remainingMs,
      deadline.expiresAtMs
    );
  }
  return remainingMs;
}

export function operationDeadlineSignal(
  deadline: OperationDeadline,
  operation: string,
  existingSignal?: AbortSignal | null
): AbortSignal {
  const remainingMs = assertOperationTimeRemaining(deadline, 1, operation);
  const deadlineSignal = AbortSignal.timeout(Math.max(1, Math.ceil(remainingMs)));
  return existingSignal
    ? AbortSignal.any([existingSignal, deadlineSignal])
    : deadlineSignal;
}

export function operationDeadlineWithReservedTime(
  deadline: OperationDeadline,
  reservedMs: number,
  operation: string
): OperationDeadline {
  if (!Number.isFinite(reservedMs) || reservedMs < 0) {
    throw new Error("reservedMs must be a non-negative number");
  }
  assertOperationTimeRemaining(deadline, reservedMs + 1, operation);
  return {
    expiresAtMs: deadline.expiresAtMs - reservedMs,
    now: deadline.now,
    sleep: deadline.sleep,
  };
}

export const TRANSACTION_COMPLETION_SAFETY_MARGIN_MS = 1_000;
export const TRANSACTION_STATEMENT_SAFETY_MARGIN_MS = 250;

export interface DeadlineTransactionPolicy {
  operation: string;
  maxWaitMs: number;
  timeoutMs: number;
  minimumTimeoutMs: number;
  lockTimeoutMs?: number;
  completionSafetyMarginMs?: number;
  statementSafetyMarginMs?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
}

export interface DeadlineTransactionTiming {
  maxWait: number;
  timeout: number;
  lockTimeoutMs: number;
  statementTimeoutMs: number;
  requiredRemainingMs: number;
  remainingMs: number;
}

interface NormalizedDeadlineTransactionPolicy {
  operation: string;
  maxWaitMs: number;
  timeoutMs: number;
  minimumTimeoutMs: number;
  lockTimeoutMs: number | null;
  completionSafetyMarginMs: number;
  statementSafetyMarginMs: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
}

function normalizedDeadlineTransactionPolicy(
  policy: DeadlineTransactionPolicy
): NormalizedDeadlineTransactionPolicy {
  const completionSafetyMarginMs =
    policy.completionSafetyMarginMs ??
    TRANSACTION_COMPLETION_SAFETY_MARGIN_MS;
  const statementSafetyMarginMs =
    policy.statementSafetyMarginMs ??
    TRANSACTION_STATEMENT_SAFETY_MARGIN_MS;
  const values = [
    policy.maxWaitMs,
    policy.timeoutMs,
    policy.minimumTimeoutMs,
    completionSafetyMarginMs,
    statementSafetyMarginMs,
    ...(policy.lockTimeoutMs === undefined ? [] : [policy.lockTimeoutMs]),
  ];
  if (
    !policy.operation.trim() ||
    values.some((value) => !Number.isInteger(value)) ||
    policy.maxWaitMs < 1 ||
    policy.timeoutMs < 1 ||
    policy.minimumTimeoutMs < 1 ||
    policy.minimumTimeoutMs > policy.timeoutMs ||
    completionSafetyMarginMs < 1 ||
    statementSafetyMarginMs < 0 ||
    statementSafetyMarginMs >= policy.minimumTimeoutMs ||
    (policy.lockTimeoutMs !== undefined && policy.lockTimeoutMs < 1)
  ) {
    throw new Error("Invalid deadline transaction policy");
  }
  return {
    operation: policy.operation,
    maxWaitMs: policy.maxWaitMs,
    timeoutMs: policy.timeoutMs,
    minimumTimeoutMs: policy.minimumTimeoutMs,
    lockTimeoutMs: policy.lockTimeoutMs ?? null,
    completionSafetyMarginMs,
    statementSafetyMarginMs,
    isolationLevel: policy.isolationLevel,
  };
}

export function minimumDeadlineTransactionRemainingMs(
  policy: DeadlineTransactionPolicy
): number {
  const normalized = normalizedDeadlineTransactionPolicy(policy);
  return (
    normalized.minimumTimeoutMs +
    normalized.completionSafetyMarginMs +
    1
  );
}

export function deadlineTransactionTiming(
  deadline: OperationDeadline,
  policy: DeadlineTransactionPolicy
): DeadlineTransactionTiming {
  const normalized = normalizedDeadlineTransactionPolicy(policy);
  const requiredRemainingMs =
    normalized.minimumTimeoutMs +
    normalized.completionSafetyMarginMs +
    1;
  const remainingMs = assertOperationTimeRemaining(
    deadline,
    requiredRemainingMs,
    normalized.operation
  );
  const usableMs = Math.floor(
    remainingMs - normalized.completionSafetyMarginMs
  );
  const maxWait = Math.max(
    1,
    Math.min(
      normalized.maxWaitMs,
      Math.floor(usableMs / 4),
      usableMs - normalized.minimumTimeoutMs
    )
  );
  const timeout = Math.min(
    normalized.timeoutMs,
    usableMs - maxWait
  );
  if (timeout < normalized.minimumTimeoutMs) {
    throw new OperationDeadlineExceededError(
      normalized.operation,
      requiredRemainingMs,
      remainingMs,
      deadline.expiresAtMs
    );
  }
  const statementTimeoutMs = Math.max(
    1,
    timeout - normalized.statementSafetyMarginMs
  );
  const lockTimeoutMs = Math.max(
    1,
    Math.min(
      normalized.lockTimeoutMs ?? maxWait,
      maxWait,
      statementTimeoutMs
    )
  );
  return {
    maxWait,
    timeout,
    lockTimeoutMs,
    statementTimeoutMs,
    requiredRemainingMs,
    remainingMs,
  };
}

export class DeadlineTransactionTimeoutError extends Error {
  readonly code = "operation_deadline_exceeded";

  constructor(
    readonly operation: string,
    readonly requiredMs: number,
    readonly remainingMs: number,
    readonly expiresAtMs: number,
    readonly transactionStarted: boolean,
    options: ErrorOptions = {}
  ) {
    super(
      `${operation} exceeded its deadline-bound database transaction budget`,
      options
    );
    this.name = "DeadlineTransactionTimeoutError";
  }
}

interface DeferredRetryErrorOptions extends ErrorOptions {
  operation?: string;
  requiredMs?: number;
  remainingMs?: number;
  expiresAtMs?: number;
}

export class DeferredRetryError extends Error {
  readonly code = "retry_after_exceeds_execution_budget";
  readonly operation: string | null;
  readonly requiredMs: number | null;
  readonly remainingMs: number | null;
  readonly expiresAtMs: number | null;

  constructor(
    readonly retryAfterMs: number,
    readonly safeExecutionBudgetMs: number,
    options: DeferredRetryErrorOptions = {}
  ) {
    super(
      `Provider requested a ${retryAfterMs}ms retry delay, exceeding the ${safeExecutionBudgetMs}ms local execution budget`,
      options
    );
    this.name = "DeferredRetryError";
    this.operation = options.operation ?? null;
    this.requiredMs = options.requiredMs ?? null;
    this.remainingMs = options.remainingMs ?? null;
    this.expiresAtMs = options.expiresAtMs ?? null;
  }
}

function databaseTimeoutErrorCode(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const code = Reflect.get(value, "code");
  return typeof code === "string" ? code : null;
}

export function isDeadlineTransactionTimeoutError(error: unknown): boolean {
  const directCode = databaseTimeoutErrorCode(error);
  const meta =
    error && typeof error === "object" ? Reflect.get(error, "meta") : null;
  const postgresCode = databaseTimeoutErrorCode(meta);
  if (
    directCode === "P2028" ||
    directCode === "55P03" ||
    directCode === "57014" ||
    postgresCode === "55P03" ||
    postgresCode === "57014"
  ) {
    return true;
  }
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return /lock timeout|statement timeout|transaction.*timeout|transaction already closed|unable to start a transaction/i.test(
    message
  );
}

export async function runDeadlineBoundTransaction<T>(
  deadline: OperationDeadline,
  policy: DeadlineTransactionPolicy,
  work: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  const timing = deadlineTransactionTiming(deadline, policy);
  let transactionStarted = false;
  try {
    return await db.$transaction(
      async (tx) => {
        transactionStarted = true;
        const lockTimeout = `${timing.lockTimeoutMs}ms`;
        const statementTimeout = `${timing.statementTimeoutMs}ms`;
        await tx.$queryRaw(
          Prisma.sql`
            SELECT
              set_config('lock_timeout', ${lockTimeout}, true)
                AS "lockTimeout",
              set_config('statement_timeout', ${statementTimeout}, true)
                AS "statementTimeout"
          `
        );
        return work(tx);
      },
      {
        maxWait: timing.maxWait,
        timeout: timing.timeout,
        isolationLevel: policy.isolationLevel,
      }
    );
  } catch (error) {
    if (error instanceof DeadlineTransactionTimeoutError) throw error;
    if (
      !(error instanceof OperationDeadlineExceededError) &&
      !isDeadlineTransactionTimeoutError(error)
    ) {
      throw error;
    }
    if (!transactionStarted && error instanceof OperationDeadlineExceededError) {
      throw error;
    }
    throw new DeadlineTransactionTimeoutError(
      policy.operation,
      timing.maxWait + timing.timeout,
      remainingOperationTimeMs(deadline),
      deadline.expiresAtMs,
      transactionStarted,
      { cause: error }
    );
  }
}

export interface OperationDeadlineDeferredResult {
  ok: false;
  status: "deferred";
  reason: "operation_deadline_exceeded";
  details: {
    phase: string;
    operation: string;
    requiredMs: number;
    remainingMs: number;
    destructiveWorkStarted: boolean;
    transactionStarted: boolean;
    transactionRolledBack: boolean;
    priorSnapshotPreserved: true;
    deadlineCause?:
      | "operation_deadline"
      | "transaction_timeout"
      | "retry_after"
      | "abort_signal";
    expiresAtMs?: number | null;
    retryAfterMs?: number | null;
    safeExecutionBudgetMs?: number | null;
  };
}

export interface OperationDeadlineDeferredContext {
  deadline?: OperationDeadline;
  phase?: string;
  operation?: string;
  requiredMs?: number;
}

function errorCause(error: unknown): unknown {
  if (!error || typeof error !== "object") return null;
  return Reflect.get(error, "cause");
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const visited = new Set<unknown>();
  let current: unknown = error;
  while (current && !visited.has(current) && chain.length < 10) {
    chain.push(current);
    visited.add(current);
    current = errorCause(current);
  }
  return chain;
}

export function isAbortSignalDeadlineError(error: unknown): boolean {
  if (!error || (typeof error !== "object" && typeof error !== "function")) {
    return false;
  }
  const name = Reflect.get(error, "name");
  const code = Reflect.get(error, "code");
  return (
    name === "AbortError" ||
    name === "TimeoutError" ||
    code === "ABORT_ERR"
  );
}

export function asOperationDeadlineDeferredResult(
  error: unknown,
  context: string | OperationDeadlineDeferredContext = {}
): OperationDeadlineDeferredResult | null {
  const normalizedContext =
    typeof context === "string" ? { phase: context } : context;
  const chain = errorChain(error);
  const operationError = chain.find(
    (candidate) => candidate instanceof OperationDeadlineExceededError
  ) as OperationDeadlineExceededError | undefined;
  const transactionError = chain.find(
    (candidate) => candidate instanceof DeadlineTransactionTimeoutError
  ) as DeadlineTransactionTimeoutError | undefined;
  const retryError = chain.find(
    (candidate) => candidate instanceof DeferredRetryError
  ) as DeferredRetryError | undefined;
  const abortError = chain.find(isAbortSignalDeadlineError);
  const rawTransactionTimeout =
    normalizedContext.deadline &&
    chain.some((candidate) => isDeadlineTransactionTimeoutError(candidate));

  let operation: string;
  let requiredMs: number;
  let remainingMs: number;
  let expiresAtMs: number | null;
  let deadlineCause: NonNullable<
    OperationDeadlineDeferredResult["details"]["deadlineCause"]
  >;
  let retryAfterMs: number | null = null;
  let safeExecutionBudgetMs: number | null = null;
  let transactionStarted = false;

  if (transactionError) {
    operation = transactionError.operation;
    requiredMs = transactionError.requiredMs;
    remainingMs = transactionError.remainingMs;
    expiresAtMs = transactionError.expiresAtMs;
    deadlineCause = "transaction_timeout";
    transactionStarted = transactionError.transactionStarted;
  } else if (operationError) {
    operation = operationError.operation;
    requiredMs = operationError.requiredMs;
    remainingMs = operationError.remainingMs;
    expiresAtMs = operationError.expiresAtMs;
    deadlineCause = "operation_deadline";
  } else if (retryError) {
    operation =
      retryError.operation ??
      normalizedContext.operation ??
      "Provider retry";
    requiredMs =
      retryError.requiredMs ??
      retryError.retryAfterMs;
    remainingMs =
      retryError.remainingMs ??
      (normalizedContext.deadline
        ? remainingOperationTimeMs(normalizedContext.deadline)
        : retryError.safeExecutionBudgetMs);
    expiresAtMs =
      retryError.expiresAtMs ??
      normalizedContext.deadline?.expiresAtMs ??
      null;
    deadlineCause = "retry_after";
    retryAfterMs = retryError.retryAfterMs;
    safeExecutionBudgetMs = retryError.safeExecutionBudgetMs;
  } else if (abortError && normalizedContext.deadline) {
    operation =
      normalizedContext.operation ??
      "Provider request";
    requiredMs = normalizedContext.requiredMs ?? 1;
    remainingMs = remainingOperationTimeMs(normalizedContext.deadline);
    expiresAtMs = normalizedContext.deadline.expiresAtMs;
    deadlineCause = "abort_signal";
  } else if (rawTransactionTimeout && normalizedContext.deadline) {
    operation =
      normalizedContext.operation ??
      "Database transaction";
    requiredMs = normalizedContext.requiredMs ?? 1;
    remainingMs = remainingOperationTimeMs(normalizedContext.deadline);
    expiresAtMs = normalizedContext.deadline.expiresAtMs;
    deadlineCause = "transaction_timeout";
  } else {
    return null;
  }

  return {
    ok: false,
    status: "deferred",
    reason: "operation_deadline_exceeded",
    details: {
      phase: normalizedContext.phase ?? operation,
      operation,
      requiredMs,
      remainingMs,
      destructiveWorkStarted: transactionStarted,
      transactionStarted,
      transactionRolledBack: transactionStarted,
      priorSnapshotPreserved: true,
      deadlineCause,
      expiresAtMs,
      retryAfterMs,
      safeExecutionBudgetMs,
    },
  };
}

export const INTEGRATION_SYNC_LEASE_TTL_MS = 10 * 60 * 1_000;
export const INTEGRATION_SYNC_LEASE_HEARTBEAT_MS = 60 * 1_000;

export interface IntegrationSyncLeaseBusyResult {
  ok: false;
  status: "busy";
  reason: "lease_conflict";
  leaseKey: string;
  expiresAt: string | null;
  retryAfterMs: number | null;
}

export interface IntegrationSyncLeaseCompletedResult<T> {
  ok: true;
  status: "completed";
  data: T;
}

export type IntegrationSyncLeaseResult<T> =
  | IntegrationSyncLeaseCompletedResult<T>
  | IntegrationSyncLeaseBusyResult;

export interface IntegrationSyncLeaseGuard {
  readonly key: string;
  readonly ownerToken: string;
  assertOwned(): Promise<void>;
  fenceTransaction(tx: Prisma.TransactionClient): Promise<void>;
}

interface IntegrationSyncLeaseOptions {
  ttlMs?: number;
  heartbeatMs?: number;
  waitMs?: number;
  retryMs?: number;
  deadline?: OperationDeadline;
  minimumRemainingMs?: number;
}

interface LeaseRecord {
  ownerToken: string;
  expiresAt: Date;
}

type LeaseQuery = <T>(query: Prisma.Sql) => Promise<T>;

const NONBLOCKING_LEASE_LOCK_TIMEOUT_MS = 1;
const MAX_LEASE_ACQUIRE_CONNECTION_WAIT_MS = 2_000;
const MAX_LEASE_ACQUIRE_TRANSACTION_TIMEOUT_MS = 5_000;
const MIN_LEASE_ACQUIRE_CONNECTION_WAIT_MS = 1;
const MIN_LEASE_ACQUIRE_TRANSACTION_TIMEOUT_MS = 1;
const MIN_LEASE_ACQUIRE_ATTEMPT_MS =
  MIN_LEASE_ACQUIRE_CONNECTION_WAIT_MS +
  MIN_LEASE_ACQUIRE_TRANSACTION_TIMEOUT_MS;

interface LeaseAcquireAttemptTiming {
  lockTimeoutMs: number;
  maxWaitMs: number;
  transactionTimeoutMs: number;
}

export class IntegrationSyncLeaseLostError extends Error {
  readonly code = "integration_sync_lease_lost";

  constructor(readonly leaseKey: string) {
    super(`Integration sync lease is no longer owned: ${leaseKey}`);
    this.name = "IntegrationSyncLeaseLostError";
  }
}

export function makeIntegrationSyncLeaseKey(
  source: string,
  ...identity: string[]
): string {
  const normalizedSource = source.trim().toLowerCase();
  if (!normalizedSource) throw new Error("Integration lease source is required");
  return `integration-sync:${normalizedSource}:${Buffer.from(
    JSON.stringify(identity),
    "utf8"
  ).toString("base64url")}`;
}

export function isIntegrationSyncLeaseExpired(
  expiresAt: Date,
  now: Date
): boolean {
  return expiresAt.getTime() <= now.getTime();
}

function errorCode(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const code = Reflect.get(value, "code");
  return typeof code === "string" ? code : null;
}

export function isIntegrationSyncLeaseAcquireBusyError(
  error: unknown
): boolean {
  const directCode = errorCode(error);
  const meta =
    error && typeof error === "object" ? Reflect.get(error, "meta") : null;
  const postgresCode = errorCode(meta);
  if (
    directCode === "55P03" ||
    postgresCode === "55P03"
  ) {
    return true;
  }
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return /lock timeout|could not obtain lock/i.test(message);
}

export function integrationSyncLeaseAcquireAttemptTiming(
  remainingWaitMs: number,
  retryMs: number,
  remainingAcquisitionMs: number | null
): LeaseAcquireAttemptTiming {
  if (
    !Number.isFinite(remainingWaitMs) ||
    !Number.isFinite(retryMs) ||
    retryMs < 1 ||
    (remainingAcquisitionMs !== null &&
      (!Number.isFinite(remainingAcquisitionMs) ||
        remainingAcquisitionMs < MIN_LEASE_ACQUIRE_ATTEMPT_MS))
  ) {
    throw new Error("Invalid integration sync lease acquisition budget");
  }
  const lockBudgetMs =
    remainingWaitMs <= 0
      ? NONBLOCKING_LEASE_LOCK_TIMEOUT_MS
      : Math.max(1, Math.min(retryMs, Math.ceil(remainingWaitMs)));
  const totalBudgetMs =
    remainingAcquisitionMs === null
      ? MAX_LEASE_ACQUIRE_CONNECTION_WAIT_MS +
        MAX_LEASE_ACQUIRE_TRANSACTION_TIMEOUT_MS
      : Math.floor(remainingAcquisitionMs);
  const maxWaitMs =
    totalBudgetMs >=
    MAX_LEASE_ACQUIRE_CONNECTION_WAIT_MS +
      MAX_LEASE_ACQUIRE_TRANSACTION_TIMEOUT_MS
      ? MAX_LEASE_ACQUIRE_CONNECTION_WAIT_MS
      : Math.max(
          MIN_LEASE_ACQUIRE_CONNECTION_WAIT_MS,
          Math.min(
            MAX_LEASE_ACQUIRE_CONNECTION_WAIT_MS,
            Math.floor(
              (totalBudgetMs * MAX_LEASE_ACQUIRE_CONNECTION_WAIT_MS) /
                (MAX_LEASE_ACQUIRE_CONNECTION_WAIT_MS +
                  MAX_LEASE_ACQUIRE_TRANSACTION_TIMEOUT_MS)
            )
          )
        );
  const transactionTimeoutMs = Math.max(
    MIN_LEASE_ACQUIRE_TRANSACTION_TIMEOUT_MS,
    Math.min(
      MAX_LEASE_ACQUIRE_TRANSACTION_TIMEOUT_MS,
      totalBudgetMs - maxWaitMs
    )
  );
  return {
    lockTimeoutMs: Math.min(lockBudgetMs, transactionTimeoutMs),
    maxWaitMs,
    transactionTimeoutMs,
  };
}

async function tryAcquireIntegrationSyncLease(
  key: string,
  ownerToken: string,
  ttlMs: number,
  timing: LeaseAcquireAttemptTiming
): Promise<LeaseRecord | null> {
  try {
    return await db.$transaction(
      async (tx) => {
        const lockTimeout = `${timing.lockTimeoutMs}ms`;
        const statementTimeout = `${timing.transactionTimeoutMs}ms`;
        await tx.$queryRaw(
          Prisma.sql`
            SELECT
              set_config('lock_timeout', ${lockTimeout}, true)
                AS "lockTimeout",
              set_config('statement_timeout', ${statementTimeout}, true)
                AS "statementTimeout"
          `
        );
        const rows = await tx.$queryRaw<LeaseRecord[]>(
          Prisma.sql`
            INSERT INTO "IntegrationSyncLease"
              ("key", "ownerToken", "expiresAt", "createdAt", "updatedAt")
            VALUES (
              ${key},
              ${ownerToken},
              clock_timestamp() + ${ttlMs} * INTERVAL '1 millisecond',
              clock_timestamp(),
              clock_timestamp()
            )
            ON CONFLICT ("key") DO UPDATE SET
              "ownerToken" = EXCLUDED."ownerToken",
              "expiresAt" = EXCLUDED."expiresAt",
              "updatedAt" = EXCLUDED."updatedAt"
            WHERE "IntegrationSyncLease"."expiresAt" <= clock_timestamp()
            RETURNING "ownerToken", "expiresAt"
          `
        );
        return rows[0]?.ownerToken === ownerToken ? rows[0] : null;
      },
      {
        maxWait: timing.maxWaitMs,
        timeout: timing.transactionTimeoutMs,
      }
    );
  } catch (error) {
    if (isIntegrationSyncLeaseAcquireBusyError(error)) return null;
    throw error;
  }
}

async function currentIntegrationSyncLeaseBusyResult(
  key: string,
  now: () => number
): Promise<IntegrationSyncLeaseBusyResult> {
  const current = await db.integrationSyncLease.findUnique({
    where: { key },
    select: { expiresAt: true },
  });
  const retryAfterMs = current
    ? Math.max(0, current.expiresAt.getTime() - now())
    : null;
  return {
    ok: false,
    status: "busy",
    reason: "lease_conflict",
    leaseKey: key,
    expiresAt: current?.expiresAt.toISOString() ?? null,
    retryAfterMs,
  };
}

async function acquireIntegrationSyncLease(
  key: string,
  ownerToken: string,
  ttlMs: number,
  waitMs: number,
  retryMs: number,
  deadline?: OperationDeadline,
  minimumRemainingMs = 0
): Promise<LeaseRecord | IntegrationSyncLeaseBusyResult> {
  const now = deadline?.now ?? Date.now;
  const sleepFor = deadline?.sleep ?? sleep;
  const startedAtMs = now();
  const waitExpiresAtMs = startedAtMs + waitMs;
  const operationExpiresAtMs = deadline
    ? deadline.expiresAtMs - minimumRemainingMs
    : Number.POSITIVE_INFINITY;
  const acquireExpiresAtMs =
    waitMs > 0
      ? Math.min(waitExpiresAtMs, operationExpiresAtMs)
      : operationExpiresAtMs;
  const operationLimitsAcquisition =
    deadline !== undefined &&
    (waitMs === 0 || operationExpiresAtMs <= waitExpiresAtMs);
  while (true) {
    const currentTimeMs = now();
    const remainingWaitMs = waitExpiresAtMs - currentTimeMs;
    const remainingAcquisitionMs = Number.isFinite(acquireExpiresAtMs)
      ? acquireExpiresAtMs - currentTimeMs
      : null;
    if (
      remainingAcquisitionMs !== null &&
      remainingAcquisitionMs < MIN_LEASE_ACQUIRE_ATTEMPT_MS
    ) {
      if (deadline && operationLimitsAcquisition) {
        throw new OperationDeadlineExceededError(
          `Acquire integration sync lease ${key}`,
          minimumRemainingMs + MIN_LEASE_ACQUIRE_ATTEMPT_MS,
          remainingOperationTimeMs(deadline),
          deadline.expiresAtMs
        );
      }
      return currentIntegrationSyncLeaseBusyResult(key, now);
    }
    const acquired = await tryAcquireIntegrationSyncLease(
      key,
      ownerToken,
      ttlMs,
      integrationSyncLeaseAcquireAttemptTiming(
        remainingWaitMs,
        retryMs,
        remainingAcquisitionMs
      )
    );
    if (acquired) return acquired;
    const currentAfterAttemptMs = now();
    const remainingWaitAfterAttemptMs =
      waitExpiresAtMs - currentAfterAttemptMs;
    const remainingAcquisitionAfterAttemptMs = Number.isFinite(
      acquireExpiresAtMs
    )
      ? acquireExpiresAtMs - currentAfterAttemptMs
      : Number.POSITIVE_INFINITY;
    if (remainingAcquisitionAfterAttemptMs <= 0) {
      if (deadline && operationLimitsAcquisition) {
        throw new OperationDeadlineExceededError(
          `Acquire integration sync lease ${key}`,
          minimumRemainingMs + MIN_LEASE_ACQUIRE_ATTEMPT_MS,
          remainingOperationTimeMs(deadline),
          deadline.expiresAtMs
        );
      }
      return currentIntegrationSyncLeaseBusyResult(key, now);
    }
    if (waitMs === 0 || remainingWaitAfterAttemptMs <= 0) {
      return currentIntegrationSyncLeaseBusyResult(key, now);
    }
    await sleepFor(
      Math.min(
        retryMs,
        remainingWaitAfterAttemptMs,
        remainingAcquisitionAfterAttemptMs
      )
    );
  }
}

async function releaseIntegrationSyncLease(
  key: string,
  ownerToken: string
): Promise<void> {
  await db.integrationSyncLease.deleteMany({
    where: { key, ownerToken },
  });
}

async function renewIntegrationSyncLease(
  query: LeaseQuery,
  key: string,
  ownerToken: string,
  ttlMs: number
): Promise<void> {
  const rows = await query<Array<{ key: string }>>(
    Prisma.sql`
      UPDATE "IntegrationSyncLease"
      SET
        "expiresAt" =
          clock_timestamp() + ${ttlMs} * INTERVAL '1 millisecond',
        "updatedAt" = clock_timestamp()
      WHERE "key" = ${key}
        AND "ownerToken" = ${ownerToken}
        AND "expiresAt" > clock_timestamp()
      RETURNING "key"
    `
  );
  if (rows.length !== 1) throw new IntegrationSyncLeaseLostError(key);
}

export async function withIntegrationSyncLease<T>(
  key: string,
  work: (lease: IntegrationSyncLeaseGuard) => Promise<T>,
  options: IntegrationSyncLeaseOptions = {}
): Promise<IntegrationSyncLeaseResult<T>> {
  const ttlMs = options.ttlMs ?? INTEGRATION_SYNC_LEASE_TTL_MS;
  const heartbeatMs =
    options.heartbeatMs ?? INTEGRATION_SYNC_LEASE_HEARTBEAT_MS;
  const waitMs = options.waitMs ?? 0;
  const retryMs = options.retryMs ?? 500;
  const minimumRemainingMs = options.minimumRemainingMs ?? 0;
  if (
    !Number.isInteger(ttlMs) ||
    !Number.isInteger(heartbeatMs) ||
    !Number.isInteger(waitMs) ||
    !Number.isInteger(retryMs) ||
    !Number.isInteger(minimumRemainingMs) ||
    ttlMs < 1 ||
    heartbeatMs < 1 ||
    waitMs < 0 ||
    retryMs < 1 ||
    minimumRemainingMs < 0 ||
    heartbeatMs * 2 >= ttlMs
  ) {
    throw new Error("Invalid integration sync lease timing");
  }
  if (options.deadline && minimumRemainingMs > 0) {
    assertOperationTimeRemaining(
      options.deadline,
      minimumRemainingMs,
      `Acquire integration sync lease ${key}`
    );
  }

  const ownerToken = randomUUID();
  const acquired = await acquireIntegrationSyncLease(
    key,
    ownerToken,
    ttlMs,
    waitMs,
    retryMs,
    options.deadline,
    minimumRemainingMs
  );
  if ("ok" in acquired) return acquired;
  if (options.deadline) {
    try {
      assertOperationTimeRemaining(
        options.deadline,
        Math.max(1, minimumRemainingMs),
        `Use acquired integration sync lease ${key}`
      );
    } catch (error) {
      await releaseIntegrationSyncLease(key, ownerToken);
      throw error;
    }
  }

  let heartbeatError: unknown = null;
  let renewalChain = Promise.resolve();
  const scheduleRenewal = () => {
    const renewal = renewalChain.then(async () => {
      if (heartbeatError) throw heartbeatError;
      await renewIntegrationSyncLease(
        (query) => db.$queryRaw(query),
        key,
        ownerToken,
        ttlMs
      );
    });
    renewalChain = renewal.catch((error) => {
      heartbeatError ??= error;
    });
    return renewal;
  };
  const heartbeat = setInterval(() => {
    void scheduleRenewal().catch(() => undefined);
  }, heartbeatMs);
  heartbeat.unref();

  const lease: IntegrationSyncLeaseGuard = {
    key,
    ownerToken,
    async assertOwned() {
      if (options.deadline) {
        assertOperationTimeRemaining(
          options.deadline,
          1,
          "Integration sync lease renewal"
        );
      }
      if (heartbeatError) throw heartbeatError;
      await scheduleRenewal();
      if (heartbeatError) throw heartbeatError;
      if (options.deadline) {
        assertOperationTimeRemaining(
          options.deadline,
          1,
          "Integration sync lease renewal"
        );
      }
    },
    async fenceTransaction(tx) {
      if (heartbeatError) throw heartbeatError;
      // The row update token-checks ownership and holds the lease lock to commit.
      await renewIntegrationSyncLease(
        (query) => tx.$queryRaw(query),
        key,
        ownerToken,
        ttlMs
      );
    },
  };

  try {
    return {
      ok: true,
      status: "completed",
      data: await work(lease),
    };
  } finally {
    clearInterval(heartbeat);
    await renewalChain;
    await releaseIntegrationSyncLease(key, ownerToken);
  }
}

export interface CursorPage<T> {
  items: T[];
  next: string | null;
}

export async function collectCursorPages<T>(
  initialCursor: string,
  fetchPage: (cursor: string) => Promise<CursorPage<T>>,
  maxPages = 1_000
): Promise<T[]> {
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new Error("maxPages must be a positive integer");
  }
  const items: T[] = [];
  const visited = new Set<string>();
  let cursor: string | null = initialCursor;

  for (let pageNumber = 0; cursor; pageNumber++) {
    if (pageNumber >= maxPages) {
      throw new Error(`Pagination exceeded ${maxPages} pages before completion`);
    }
    if (visited.has(cursor)) {
      throw new Error(`Pagination repeated cursor: ${cursor}`);
    }
    visited.add(cursor);
    const page = await fetchPage(cursor);
    items.push(...page.items);
    cursor = page.next;
  }
  return items;
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("concurrency must be a positive integer");
  }
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}

export function parseRetryAfterMs(
  value: string | null,
  nowMs: number = Date.now()
): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }
  const dateMs = Date.parse(value);
  if (Number.isNaN(dateMs)) return null;
  return Math.max(0, dateMs - nowMs);
}

export function boundedRetryDelayMs(
  attempt: number,
  retryAfterMs: number | null,
  baseDelayMs = 500,
  maxDelayMs = 15_000,
  safeExecutionBudgetMs = maxDelayMs
): number {
  const exponential = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const fallbackDelay = Math.min(maxDelayMs, exponential);
  if (retryAfterMs === null) return fallbackDelay;
  if (retryAfterMs > safeExecutionBudgetMs) {
    throw new DeferredRetryError(retryAfterMs, safeExecutionBudgetMs);
  }
  return Math.max(fallbackDelay, retryAfterMs);
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function retryDelayMsBeforeDeadline(
  deadline: OperationDeadline,
  attempt: number,
  retryAfterMs: number | null,
  operation: string,
  minimumRemainingAfterDelayMs = PROVIDER_REQUEST_MIN_REMAINING_MS,
  baseDelayMs = 500,
  maxDelayMs = 15_000
): number {
  const remainingMs = assertOperationTimeRemaining(
    deadline,
    minimumRemainingAfterDelayMs,
    operation
  );
  const availableDelayMs = Math.max(
    0,
    remainingMs - minimumRemainingAfterDelayMs
  );
  if (retryAfterMs !== null && retryAfterMs > availableDelayMs) {
    throw new DeferredRetryError(retryAfterMs, availableDelayMs, {
      operation,
      requiredMs: retryAfterMs + minimumRemainingAfterDelayMs,
      remainingMs,
      expiresAtMs: deadline.expiresAtMs,
    });
  }
  const delayMs = boundedRetryDelayMs(
    attempt,
    retryAfterMs,
    baseDelayMs,
    maxDelayMs,
    availableDelayMs
  );
  if (delayMs > availableDelayMs) {
    throw new OperationDeadlineExceededError(
      operation,
      delayMs + minimumRemainingAfterDelayMs,
      remainingMs,
      deadline.expiresAtMs
    );
  }
  return delayMs;
}

export async function sleepBeforeDeadline(
  deadline: OperationDeadline,
  delayMs: number,
  operation: string,
  minimumRemainingAfterDelayMs = 0
): Promise<void> {
  const requiredMs = delayMs + minimumRemainingAfterDelayMs;
  assertOperationTimeRemaining(deadline, requiredMs, operation);
  await deadline.sleep(delayMs);
  assertOperationTimeRemaining(
    deadline,
    minimumRemainingAfterDelayMs,
    operation
  );
}

export async function waitForRetryBeforeDeadline(
  deadline: OperationDeadline,
  attempt: number,
  retryAfterMs: number | null,
  operation: string,
  minimumRemainingAfterDelayMs = PROVIDER_REQUEST_MIN_REMAINING_MS
): Promise<void> {
  const delayMs = retryDelayMsBeforeDeadline(
    deadline,
    attempt,
    retryAfterMs,
    operation,
    minimumRemainingAfterDelayMs
  );
  await sleepBeforeDeadline(
    deadline,
    delayMs,
    operation,
    minimumRemainingAfterDelayMs
  );
}

export function chunkItems<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error("chunk size must be a positive integer");
  }
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export function missingIdsForCompleteSnapshot(
  existingIds: Iterable<string>,
  seenIds: Iterable<string>,
  complete: boolean
): string[] {
  if (!complete) {
    throw new Error("Refusing destructive reconciliation from an incomplete snapshot");
  }
  const seen = new Set(seenIds);
  return Array.from(existingIds).filter((id) => !seen.has(id));
}
