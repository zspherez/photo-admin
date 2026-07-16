import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import { db } from "./db";
import {
  assertOperationTimeRemaining,
  boundedRetryDelayMs,
  chunkItems,
  collectCursorPages,
  createOperationDeadline,
  deadlineTransactionTiming,
  DeadlineTransactionTimeoutError,
  DeferredRetryError,
  integrationSyncLeaseAcquireAttemptTiming,
  isIntegrationSyncLeaseAcquireBusyError,
  isDeadlineTransactionTimeoutError,
  isIntegrationSyncLeaseExpired,
  makeIntegrationSyncLeaseKey,
  minimumDeadlineTransactionRemainingMs,
  missingIdsForCompleteSnapshot,
  operationDeadlineSignal,
  OperationDeadlineExceededError,
  asOperationDeadlineDeferredResult,
  parseRetryAfterMs,
  remainingOperationTimeMs,
  retryDelayMsBeforeDeadline,
  waitForRetryBeforeDeadline,
  withIntegrationSyncLease,
} from "./integrationUtils";

test("integration lease keys fence each source identity independently", () => {
  const spotify = makeIntegrationSyncLeaseKey("spotify");
  const statsfmA = makeIntegrationSyncLeaseKey("statsfm", "user:a");
  const statsfmB = makeIntegrationSyncLeaseKey("statsfm", "user", "a");

  assert.equal(spotify, makeIntegrationSyncLeaseKey("spotify"));
  assert.notEqual(spotify, makeIntegrationSyncLeaseKey("edmtrain-nyc"));
  assert.notEqual(statsfmA, statsfmB);
});

test("integration leases expire at the exact expiry instant", () => {
  const expiresAt = new Date("2026-07-16T10:00:00.000Z");
  assert.equal(
    isIntegrationSyncLeaseExpired(
      expiresAt,
      new Date("2026-07-16T09:59:59.999Z")
    ),
    false
  );
  assert.equal(isIntegrationSyncLeaseExpired(expiresAt, expiresAt), true);
});

test("lease acquisition only maps PostgreSQL row-lock conflicts to busy retries", () => {
  assert.equal(
    isIntegrationSyncLeaseAcquireBusyError({
      code: "P2010",
      meta: { code: "55P03", message: "canceling statement due to lock timeout" },
    }),
    true
  );
  assert.equal(
    isIntegrationSyncLeaseAcquireBusyError(
      Object.assign(new Error("Unable to start a transaction in the given time"), {
        code: "P2028",
      })
    ),
    false
  );
  assert.equal(
    isIntegrationSyncLeaseAcquireBusyError({
      code: "P2010",
      meta: { code: "57014", message: "statement timeout" },
    }),
    false
  );
  assert.equal(
    isIntegrationSyncLeaseAcquireBusyError(
      Object.assign(new Error("database unavailable"), { code: "P1001" })
    ),
    false
  );
});

test("zero-wait lease acquisition uses nonblocking lock and connection waits", () => {
  assert.deepEqual(
    integrationSyncLeaseAcquireAttemptTiming(0, 500, null),
    {
      lockTimeoutMs: 1,
      maxWaitMs: 2_000,
      transactionTimeoutMs: 5_000,
    }
  );
  assert.deepEqual(
    integrationSyncLeaseAcquireAttemptTiming(1_200, 500, 300),
    {
      lockTimeoutMs: 215,
      maxWaitMs: 85,
      transactionTimeoutMs: 215,
    }
  );
  const constrained = integrationSyncLeaseAcquireAttemptTiming(5_000, 500, 300);
  assert.ok(
    constrained.maxWaitMs + constrained.transactionTimeoutMs <= 300
  );
});

test("distinct zero-wait leases serialize through a one-connection pool", async (t) => {
  type TransactionRunner = {
    $transaction: (
      callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
      options?: { maxWait?: number; timeout?: number }
    ) => Promise<unknown>;
  };
  type LeaseModel = {
    findUnique: (...args: unknown[]) => Promise<{ expiresAt: Date } | null>;
    deleteMany: (...args: unknown[]) => Promise<{ count: number }>;
  };

  let connectionAvailable = true;
  const waiters: Array<() => void> = [];
  const observedMaxWaits: number[] = [];
  const acquireConnection = (maxWaitMs: number): Promise<() => void> => {
    if (connectionAvailable) {
      connectionAvailable = false;
      return Promise.resolve(() => {
        const next = waiters.shift();
        if (next) next();
        else connectionAvailable = true;
      });
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        clearTimeout(timer);
        resolve(() => {
          const next = waiters.shift();
          if (next) next();
          else connectionAvailable = true;
        });
      };
      const timer = setTimeout(() => {
        const index = waiters.indexOf(grant);
        if (index >= 0) waiters.splice(index, 1);
        reject(
          Object.assign(
            new Error("Unable to start a transaction in the given time"),
            { code: "P2028" }
          )
        );
      }, maxWaitMs);
      waiters.push(grant);
    });
  };

  const transactionTarget = db as unknown as TransactionRunner;
  const leaseTarget = db.integrationSyncLease as unknown as LeaseModel;
  const transactionDescriptor = Object.getOwnPropertyDescriptor(
    db,
    "$transaction"
  );
  const originalFindUnique = leaseTarget.findUnique;
  const originalDeleteMany = leaseTarget.deleteMany;
  transactionTarget.$transaction = async (callback, options) => {
    const maxWaitMs = options?.maxWait ?? 2_000;
    observedMaxWaits.push(maxWaitMs);
    const release = await acquireConnection(maxWaitMs);
    let queryCount = 0;
    const tx = {
      $queryRaw: async (query: unknown) => {
        queryCount++;
        if (queryCount === 1) return [];
        await new Promise((resolve) => setTimeout(resolve, 20));
        const values = Reflect.get(query as object, "values") as unknown[];
        return [
          {
            ownerToken: String(values[1]),
            expiresAt: new Date(Date.now() + 60_000),
          },
        ];
      },
    } as unknown as Prisma.TransactionClient;
    try {
      return await callback(tx);
    } finally {
      release();
    }
  };
  leaseTarget.findUnique = async () => null;
  leaseTarget.deleteMany = async () => ({ count: 1 });
  t.after(() => {
    if (transactionDescriptor) {
      Object.defineProperty(db, "$transaction", transactionDescriptor);
    } else {
      Reflect.deleteProperty(db, "$transaction");
    }
    leaseTarget.findUnique = originalFindUnique;
    leaseTarget.deleteMany = originalDeleteMany;
  });

  const [nyc, festivals] = await Promise.all([
    withIntegrationSyncLease(
      makeIntegrationSyncLeaseKey("edmtrain-nyc"),
      async () => "nyc"
    ),
    withIntegrationSyncLease(
      makeIntegrationSyncLeaseKey("edmtrain-festivals"),
      async () => "festivals"
    ),
  ]);

  assert.equal(nyc.ok, true);
  assert.equal(festivals.ok, true);
  assert.deepEqual(observedMaxWaits, [2_000, 2_000]);
});

test("pool waits cannot consume the caller budget after lease acquisition", async (t) => {
  type TransactionRunner = {
    $transaction: (
      callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
      options?: { maxWait?: number; timeout?: number }
    ) => Promise<unknown>;
  };
  type LeaseModel = {
    findUnique: (...args: unknown[]) => Promise<{ expiresAt: Date } | null>;
    deleteMany: (...args: unknown[]) => Promise<{ count: number }>;
  };

  let nowMs = 0;
  let workStarted = false;
  let releases = 0;
  let observedTiming = { maxWait: 0, timeout: 0 };
  const transactionTarget = db as unknown as TransactionRunner;
  const leaseTarget = db.integrationSyncLease as unknown as LeaseModel;
  const transactionDescriptor = Object.getOwnPropertyDescriptor(
    db,
    "$transaction"
  );
  const originalFindUnique = leaseTarget.findUnique;
  const originalDeleteMany = leaseTarget.deleteMany;
  transactionTarget.$transaction = async (callback, options) => {
    const maxWait = options?.maxWait ?? 2_000;
    const timeout = options?.timeout ?? 5_000;
    observedTiming = { maxWait, timeout };
    let queryCount = 0;
    const tx = {
      $queryRaw: async (query: unknown) => {
        queryCount++;
        if (queryCount === 1) return [];
        const values = Reflect.get(query as object, "values") as unknown[];
        return [
          {
            ownerToken: String(values[1]),
            expiresAt: new Date(60_000),
          },
        ];
      },
    } as unknown as Prisma.TransactionClient;
    const result = await callback(tx);
    nowMs += maxWait + timeout + 1;
    return result;
  };
  leaseTarget.findUnique = async () => null;
  leaseTarget.deleteMany = async () => {
    releases++;
    return { count: 1 };
  };
  t.after(() => {
    if (transactionDescriptor) {
      Object.defineProperty(db, "$transaction", transactionDescriptor);
    } else {
      Reflect.deleteProperty(db, "$transaction");
    }
    leaseTarget.findUnique = originalFindUnique;
    leaseTarget.deleteMany = originalDeleteMany;
  });

  const deadline = createOperationDeadline(10_000, { now: () => nowMs });
  let failure: unknown;
  try {
    await withIntegrationSyncLease(
      makeIntegrationSyncLeaseKey("fake-clock-pool"),
      async () => {
        workStarted = true;
      },
      {
        deadline,
        waitMs: 7_000,
        minimumRemainingMs: 5_000,
      }
    );
  } catch (error) {
    failure = error;
  }
  assert.deepEqual(observedTiming, { maxWait: 1_428, timeout: 3_572 });
  assert.deepEqual(observedTiming, { maxWait: 1_428, timeout: 3_572 });
  assert.ok(
    observedTiming.maxWait + observedTiming.timeout <=
      deadline.expiresAtMs - 5_000
  );
  assert.equal(workStarted, false);
  assert.equal(releases, 1);
  assert.ok(failure instanceof OperationDeadlineExceededError);
  assert.equal(failure.requiredMs, 5_000);
  assert.equal(failure.remainingMs, 4_999);
  assert.equal(
    asOperationDeadlineDeferredResult(failure, {
      deadline,
      phase: "lease_acquisition",
    })?.details.priorSnapshotPreserved,
    true
  );
});

test("cursor pagination collects every page before completion", async () => {
  const pages = new Map([
    ["first", { items: [1, 2], next: "second" }],
    ["second", { items: [3], next: null }],
  ]);
  assert.deepEqual(
    await collectCursorPages("first", async (cursor) => pages.get(cursor)!),
    [1, 2, 3]
  );
});

test("pagination rejects repeated cursors and page caps", async () => {
  await assert.rejects(
    collectCursorPages("first", async () => ({ items: [], next: "first" })),
    /repeated cursor/
  );
  await assert.rejects(
    collectCursorPages(
      "first",
      async (cursor) => ({ items: [], next: `${cursor}-next` }),
      2
    ),
    /exceeded 2 pages/
  );
});

test("destructive reconciliation requires an explicit complete snapshot", () => {
  assert.deepEqual(
    missingIdsForCompleteSnapshot(["a", "b", "c"], ["b"], true),
    ["a", "c"]
  );
  assert.throws(
    () => missingIdsForCompleteSnapshot(["a"], [], false),
    /incomplete snapshot/
  );
});

test("large writes are split into bounded chunks", () => {
  assert.deepEqual(chunkItems([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.throws(() => chunkItems([1], 0), /positive integer/);
});

test("Retry-After parsing never shortens explicit durations", () => {
  assert.equal(parseRetryAfterMs("2", 0), 2_000);
  assert.equal(parseRetryAfterMs("0.0011", 0), 2);
  assert.equal(
    parseRetryAfterMs("Thu, 01 Jan 1970 00:00:05 GMT", 1_000),
    4_000
  );
  assert.equal(boundedRetryDelayMs(2, 8_000, 500, 10_000), 8_000);
});

test("explicit provider delays beyond the execution budget are deferred", () => {
  assert.throws(
    () => boundedRetryDelayMs(2, 12_000, 500, 10_000),
    (error) => {
      assert.ok(error instanceof DeferredRetryError);
      assert.equal(error.retryAfterMs, 12_000);
      assert.equal(error.safeExecutionBudgetMs, 10_000);
      return true;
    }
  );
});

test("exponential fallback remains bounded without Retry-After", () => {
  assert.equal(boundedRetryDelayMs(10, null, 500, 10_000), 10_000);
});

test("operation deadlines reserve one absolute route budget", () => {
  let nowMs = 1_000;
  const deadline = createOperationDeadline(10_000, {
    safetyMarginMs: 1_000,
    now: () => nowMs,
  });

  assert.equal(deadline.expiresAtMs, 10_000);
  assert.equal(remainingOperationTimeMs(deadline), 9_000);
  nowMs = 5_001;
  assert.equal(remainingOperationTimeMs(deadline), 4_999);
  assert.throws(
    () =>
      assertOperationTimeRemaining(
        deadline,
        5_000,
        "provider request"
      ),
    /only 4999ms remain/
  );
});

test("database transaction options shrink with one fake-clock deadline", () => {
  let nowMs = 0;
  const deadline = createOperationDeadline(60_000, {
    now: () => nowMs,
  });
  const policy = {
    operation: "Spotify reconciliation",
    maxWaitMs: 10_000,
    timeoutMs: 120_000,
    minimumTimeoutMs: 30_000,
    lockTimeoutMs: 10_000,
  };

  assert.equal(minimumDeadlineTransactionRemainingMs(policy), 31_001);
  assert.deepEqual(deadlineTransactionTiming(deadline, policy), {
    maxWait: 10_000,
    timeout: 49_000,
    lockTimeoutMs: 10_000,
    statementTimeoutMs: 48_750,
    requiredRemainingMs: 31_001,
    remainingMs: 60_000,
  });

  nowMs = 25_000;
  const constrained = deadlineTransactionTiming(deadline, policy);
  assert.deepEqual(constrained, {
    maxWait: 4_000,
    timeout: 30_000,
    lockTimeoutMs: 4_000,
    statementTimeoutMs: 29_750,
    requiredRemainingMs: 31_001,
    remainingMs: 35_000,
  });
  assert.ok(
    constrained.maxWait + constrained.timeout <=
      constrained.remainingMs - 1_000
  );

  nowMs = 40_000;
  assert.throws(
    () => deadlineTransactionTiming(deadline, policy),
    OperationDeadlineExceededError
  );
});

test("deadline transaction timeouts become typed rollback deferrals", () => {
  assert.equal(
    isDeadlineTransactionTimeoutError({
      code: "P2010",
      meta: { code: "57014", message: "statement timeout" },
    }),
    true
  );
  const deferred = asOperationDeadlineDeferredResult(
    new DeadlineTransactionTimeoutError(
      "EDMTrain reconciliation",
      35_000,
      0,
      100_000,
      true
    ),
    "database_reconciliation"
  );

  assert.deepEqual(deferred, {
    ok: false,
    status: "deferred",
    reason: "operation_deadline_exceeded",
    details: {
      phase: "database_reconciliation",
      operation: "EDMTrain reconciliation",
      requiredMs: 35_000,
      remainingMs: 0,
      destructiveWorkStarted: true,
      transactionStarted: true,
      transactionRolledBack: true,
      priorSnapshotPreserved: true,
      deadlineCause: "transaction_timeout",
      expiresAtMs: 100_000,
      retryAfterMs: null,
      safeExecutionBudgetMs: null,
    },
  });
});

test("retry and abort failures normalize with structured deadline details", () => {
  const deadline = createOperationDeadline(10_000, { now: () => 0 });
  let retryError: unknown;
  try {
    retryDelayMsBeforeDeadline(
      deadline,
      1,
      6_000,
      "EDMTrain provider retry",
      5_000
    );
  } catch (error) {
    retryError = error;
  }

  const retryDeferred = asOperationDeadlineDeferredResult(retryError, {
    deadline,
  });
  assert.equal(retryDeferred?.details.deadlineCause, "retry_after");
  assert.equal(retryDeferred?.details.retryAfterMs, 6_000);
  assert.equal(retryDeferred?.details.safeExecutionBudgetMs, 5_000);
  assert.equal(retryDeferred?.details.requiredMs, 11_000);
  assert.equal(retryDeferred?.details.remainingMs, 10_000);
  assert.equal(retryDeferred?.details.expiresAtMs, 10_000);

  const abortError = Object.assign(new Error("request timed out"), {
    name: "AbortError",
  });
  const abortDeferred = asOperationDeadlineDeferredResult(abortError, {
    deadline,
    operation: "Spotify provider request",
  });
  assert.equal(abortDeferred?.details.deadlineCause, "abort_signal");
  assert.equal(abortDeferred?.details.operation, "Spotify provider request");
  assert.equal(abortDeferred?.details.expiresAtMs, 10_000);
});

test("operation deadline signals preserve caller cancellation", () => {
  const controller = new AbortController();
  const deadline = createOperationDeadline(10_000);
  const signal = operationDeadlineSignal(
    deadline,
    "provider request",
    controller.signal,
  );

  assert.equal(signal.aborted, false);
  controller.abort();
  assert.equal(signal.aborted, true);
});

test("retries share a fake-clock deadline without shortening Retry-After", async () => {
  let nowMs = 0;
  const sleeps: number[] = [];
  const deadline = createOperationDeadline(10_000, {
    now: () => nowMs,
    sleep: async (delayMs) => {
      sleeps.push(delayMs);
      nowMs += delayMs;
    },
  });

  await waitForRetryBeforeDeadline(
    deadline,
    1,
    4_000,
    "provider retry",
    1_000
  );
  assert.deepEqual(sleeps, [4_000]);
  assert.equal(remainingOperationTimeMs(deadline), 6_000);
  assert.throws(
    () =>
      retryDelayMsBeforeDeadline(
        deadline,
        2,
        6_000,
        "provider retry",
        1_000
      ),
    (error) => {
      assert.ok(error instanceof DeferredRetryError);
      assert.equal(error.retryAfterMs, 6_000);
      assert.equal(error.safeExecutionBudgetMs, 5_000);
      return true;
    }
  );
  assert.deepEqual(sleeps, [4_000]);
});
