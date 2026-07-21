import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { db } from "./db";
import {
  prepareContactAudit,
  recordContactAuditWorkflowFailure,
  requestContactAudit,
  submitContactAuditResult,
} from "./contactAudit";

type RequestRow = {
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
};

type MutableDb = {
  $transaction: (
    work: (tx: Record<string, unknown>) => Promise<unknown>,
    options?: unknown
  ) => Promise<unknown>;
};

function serialTransaction(
  tx: Record<string, unknown>
): MutableDb["$transaction"] {
  let tail = Promise.resolve();
  return async (work) => {
    const previous = tail;
    let release = () => {};
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work(tx);
    } finally {
      release();
    }
  };
}

function applyUpdate(
  row: RequestRow,
  data: Record<string, unknown>
): RequestRow {
  const next = { ...row };
  for (const [key, value] of Object.entries(data)) {
    if (
      key === "attemptCount" &&
      typeof value === "object" &&
      value !== null
    ) {
      next.attemptCount += Number(Reflect.get(value, "increment") ?? 0);
    } else {
      Reflect.set(next, key, value);
    }
  }
  return next;
}

test("first, duplicate, running, completed, and concurrent requests preserve one active request", async () => {
  const mutableDb = db as unknown as MutableDb;
  const originalTransaction = mutableDb.$transaction;
  const rows: RequestRow[] = [];
  const now = new Date("2026-07-21T01:00:00.000Z");
  const tx = {
    contactAuditRequest: {
      findFirst: async () =>
        rows.find(
          (row) => row.status === "pending" || row.status === "running"
        ) ?? null,
      create: async ({ data }: { data: { id: string; requestedAt: Date } }) => {
        const row: RequestRow = {
          id: data.id,
          status: "pending",
          requestedAt: data.requestedAt,
          startedAt: null,
          completedAt: null,
          runId: null,
          attemptCount: 0,
          lastAttemptAt: null,
          lastWorkflowRunId: null,
          lastError: null,
        };
        rows.push(row);
        return row;
      },
    },
    contactAuditRun: {
      findFirst: async () => null,
    },
  };
  mutableDb.$transaction = serialTransaction(tx);

  try {
    const first = await requestContactAudit(now);
    const duplicate = await requestContactAudit(now);
    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.id, first.id);

    rows[0].status = "running";
    const whileRunning = await requestContactAudit(now);
    assert.equal(whileRunning.created, false);
    assert.equal(whileRunning.id, first.id);

    rows[0].status = "completed";
    rows[0].completedAt = now;
    const [afterCompletionA, afterCompletionB] = await Promise.all([
      requestContactAudit(new Date(now.getTime() + 1_000)),
      requestContactAudit(new Date(now.getTime() + 1_000)),
    ]);
    assert.equal(rows.filter((row) => row.status === "pending").length, 1);
    assert.deepEqual(
      [afterCompletionA.created, afterCompletionB.created].sort(),
      [false, true]
    );
    assert.equal(afterCompletionA.id, afterCompletionB.id);
    assert.notEqual(afterCompletionA.id, first.id);
  } finally {
    mutableDb.$transaction = originalTransaction;
  }
});

test("the first poll adopts an active legacy run without changing its snapshot or claims", async () => {
  const mutableDb = db as unknown as MutableDb;
  const originalTransaction = mutableDb.$transaction;
  const now = new Date("2026-07-21T01:05:00.000Z");
  const legacyCreatedAt = new Date("2026-07-21T00:30:00.000Z");
  const jobs = [
    {
      id: "job-claimed",
      status: "claimed",
      claimExpiresAt: new Date(now.getTime() + 30_000),
      claimToken: "existing-claim",
      attemptCount: 1,
    },
    {
      id: "job-pending",
      status: "pending",
      claimExpiresAt: null,
      claimToken: null,
      attemptCount: 0,
    },
  ];
  const originalJobs = structuredClone(jobs);
  const run = {
    id: "legacy-run",
    status: "running",
    contactCount: 2,
    createdAt: legacyCreatedAt,
    jobs,
  };
  let request: RequestRow | null = null;
  let contactReads = 0;
  let runCreates = 0;
  let snapshotCreates = 0;

  const tx = {
    contactAuditRequest: {
      findFirst: async () =>
        request
          ? {
              ...request,
              run,
            }
          : null,
      create: async ({
        data,
      }: {
        data: {
          id: string;
          status: string;
          requestedAt: Date;
          startedAt: Date;
          runId: string;
        };
      }) => {
        request = {
          id: data.id,
          status: data.status,
          requestedAt: data.requestedAt,
          startedAt: data.startedAt,
          completedAt: null,
          runId: data.runId,
          attemptCount: 0,
          lastAttemptAt: null,
          lastWorkflowRunId: null,
          lastError: null,
        };
        return request;
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        assert.ok(request);
        request = applyUpdate(request, data);
        return request;
      },
    },
    contactAuditRun: {
      findFirst: async () => run,
      create: async () => {
        runCreates += 1;
      },
      update: async () => run,
    },
    contact: {
      findMany: async () => {
        contactReads += 1;
        return [];
      },
    },
    contactAuditJob: {
      createMany: async () => {
        snapshotCreates += 1;
      },
    },
  };
  mutableDb.$transaction = serialTransaction(tx);

  try {
    const result = await prepareContactAudit("1000", now);
    assert.equal(result.requested, true);
    assert.equal(result.resumed, true);
    assert.equal(result.runId, "legacy-run");
    assert.equal(result.contactCount, 2);
    assert.equal(result.claimable, 1);
    const adoptedRequest = request as unknown as RequestRow;
    assert.equal(adoptedRequest.runId, "legacy-run");
    assert.equal(adoptedRequest.status, "running");
    assert.equal(
      adoptedRequest.requestedAt.toISOString(),
      legacyCreatedAt.toISOString()
    );
    assert.equal(contactReads, 0);
    assert.equal(runCreates, 0);
    assert.equal(snapshotCreates, 0);
    assert.deepEqual(jobs, originalJobs);
  } finally {
    mutableDb.$transaction = originalTransaction;
  }
});

test("a request snapshots once and a retry resumes the same audit run", async () => {
  const mutableDb = db as unknown as MutableDb;
  const originalTransaction = mutableDb.$transaction;
  const now = new Date("2026-07-21T01:10:00.000Z");
  let request: RequestRow = {
    id: "request-1",
    status: "pending",
    requestedAt: new Date(now.getTime() - 1_000),
    startedAt: null,
    completedAt: null,
    runId: null,
    attemptCount: 0,
    lastAttemptAt: null,
    lastWorkflowRunId: null,
    lastError: null,
  };
  let run:
    | {
        id: string;
        status: string;
        contactCount: number;
        jobs: Array<{ status: string; claimExpiresAt: Date | null }>;
      }
    | null = null;
  let contactReads = 0;
  let runCreates = 0;
  let snapshotCreates = 0;

  const tx = {
    contactAuditRequest: {
      findFirst: async () => ({
        ...request,
        run,
      }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        request = applyUpdate(request, data);
        return request;
      },
    },
    contact: {
      findMany: async () => {
        contactReads += 1;
        return [
          {
            id: "contact-1",
            artistId: "artist-1",
            email: "manager@example.com",
            phone: null,
            directOutreachNote: null,
            name: "Manager",
            role: "management",
            source: "manual",
            notes: null,
            artist: { name: "Artist" },
          },
        ];
      },
    },
    contactAuditRun: {
      create: async ({
        data,
      }: {
        data: { id: string; status: string; contactCount: number };
      }) => {
        runCreates += 1;
        run = {
          id: data.id,
          status: data.status,
          contactCount: data.contactCount,
          jobs: [{ status: "pending", claimExpiresAt: null }],
        };
        return run;
      },
      update: async () => run,
    },
    contactAuditJob: {
      createMany: async ({
        data,
      }: {
        data: Array<Record<string, unknown>>;
      }) => {
        snapshotCreates += data.length;
        return { count: data.length };
      },
    },
  };
  mutableDb.$transaction = serialTransaction(tx);

  try {
    const first = await prepareContactAudit("1001", now);
    const retry = await prepareContactAudit(
      "1002",
      new Date(now.getTime() + 60_000)
    );
    assert.equal(first.requested, true);
    assert.equal(first.resumed, false);
    assert.equal(retry.resumed, true);
    assert.equal(retry.runId, first.runId);
    assert.equal(runCreates, 1);
    assert.equal(contactReads, 1);
    assert.equal(snapshotCreates, 1);
    assert.equal(request.attemptCount, 2);
    assert.equal(request.lastWorkflowRunId, "1002");
  } finally {
    mutableDb.$transaction = originalTransaction;
  }
});

test("completion marks an adopted request completed without replacing its run", async () => {
  const mutableDb = db as unknown as MutableDb;
  const originalTransaction = mutableDb.$transaction;
  const now = new Date("2026-07-21T01:15:00.000Z");
  let request: RequestRow = {
    id: "legacy-request",
    status: "running",
    requestedAt: new Date("2026-07-21T00:30:00.000Z"),
    startedAt: new Date("2026-07-21T00:30:00.000Z"),
    completedAt: null,
    runId: "legacy-run",
    attemptCount: 1,
    lastAttemptAt: new Date("2026-07-21T01:00:00.000Z"),
    lastWorkflowRunId: "1000",
    lastError: null,
  };
  let completedRunId: string | null = null;
  const tx = {
    contactAuditJob: {
      findFirst: async () => ({
        id: "legacy-job",
        runId: "legacy-run",
        claimToken: "claim-1",
        snapshotEmail: "old.manager@example.com",
      }),
      update: async () => ({ id: "legacy-job" }),
      count: async () => 0,
    },
    contactAuditAlternative: {
      deleteMany: async () => ({ count: 0 }),
      createMany: async () => ({ count: 0 }),
    },
    contactAuditRun: {
      update: async ({ where }: { where: { id: string } }) => {
        completedRunId = where.id;
        return { id: where.id };
      },
    },
    contactAuditRequest: {
      findFirst: async () => ({ id: request.id }),
      updateMany: async ({
        data,
      }: {
        data: Record<string, unknown>;
      }) => {
        request = applyUpdate(request, data);
        return { count: 1 };
      },
    },
  };
  mutableDb.$transaction = serialTransaction(tx);

  try {
    const result = await submitContactAuditResult(
      "legacy-job",
      {
        claimToken: "claim-1",
        finding: "current",
        sourceUrls: ["https://artist.example/contact"],
        evidence: "The official artist page still lists this manager.",
        confidence: "high",
        alternatives: [],
      },
      now
    );
    assert.deepEqual(result, { accepted: true, runComplete: true });
    assert.equal(completedRunId, "legacy-run");
    assert.equal(request.runId, "legacy-run");
    assert.equal(request.status, "completed");
    assert.equal(request.completedAt, now);
  } finally {
    mutableDb.$transaction = originalTransaction;
  }
});

test("failed workflow attempts release claims and keep the linked request retryable", async () => {
  const mutableDb = db as unknown as MutableDb;
  const originalTransaction = mutableDb.$transaction;
  const now = new Date("2026-07-21T01:20:00.000Z");
  let request: RequestRow = {
    id: "request-1",
    status: "running",
    requestedAt: new Date(now.getTime() - 60_000),
    startedAt: new Date(now.getTime() - 50_000),
    completedAt: null,
    runId: "run-1",
    attemptCount: 1,
    lastAttemptAt: new Date(now.getTime() - 50_000),
    lastWorkflowRunId: "2001",
    lastError: null,
  };
  let released = 0;
  const tx = {
    contactAuditRequest: {
      findFirst: async () => request,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        request = applyUpdate(request, data);
        return request;
      },
    },
    contactAuditJob: {
      updateMany: async () => {
        released += 2;
        return { count: 2 };
      },
    },
  };
  mutableDb.$transaction = serialTransaction(tx);

  try {
    assert.equal(
      await recordContactAuditWorkflowFailure(
        "run-1",
        "2001",
        "workers failed",
        now
      ),
      true
    );
    assert.equal(released, 2);
    assert.equal(request.status, "pending");
    assert.equal(request.runId, "run-1");
    assert.equal(request.lastError, "workers failed");
  } finally {
    mutableDb.$transaction = originalTransaction;
  }
});

test("completion links the request and the audit queue is independent from manager research", () => {
  const source = readFileSync(new URL("./contactAudit.ts", import.meta.url), "utf8");
  const migration = readFileSync(
    new URL(
      "../prisma/migrations/20260721030000_contact_audit_request_queue/migration.sql",
      import.meta.url
    ),
    "utf8"
  );
  const completion = source.slice(
    source.indexOf("export async function submitContactAuditResult"),
    source.indexOf("export async function markContactAuditReviewed")
  );

  assert.match(completion, /tx\.contactAuditRequest\.updateMany/);
  assert.match(completion, /status: "completed"/);
  assert.match(completion, /completedAt: now/);
  const claim = source.indexOf("export async function claimContactAuditJobs");
  const submit = source.indexOf("export async function submitContactAuditResult");
  assert.ok(source.indexOf("await ensureLegacyContactAuditRequest()", claim) > claim);
  assert.ok(
    source.indexOf("await ensureLegacyContactAuditRequest()", submit) > submit
  );
  assert.match(
    source,
    /JOIN "ContactAuditRequest" request ON request\."runId" = run\."id"/
  );
  assert.doesNotMatch(migration, /ContactResearchJob/);
  assert.doesNotMatch(completion, /contactResearchJob/);
});
