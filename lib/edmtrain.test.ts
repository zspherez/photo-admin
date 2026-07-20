import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createSerializedEdmtrainReconciliationScheduler,
  edmtrainEventGeography,
  edmtrainEventStatus,
  fetchEdmtrainEvents,
  isValidEdmtrainSnapshotEvent,
  runLeasedEdmtrainSnapshotSync,
  runConcurrentEdmtrainSnapshotSyncs,
  runIndependentEdmtrainSyncs,
  syncEdmtrainFestivals,
  syncEdmtrainShows,
  type EdmtrainEvent,
  type EdmtrainScopeLeaseAcquirer,
  type SyncResult,
} from "./edmtrain";
import {
  createOperationDeadline,
  DeferredRetryError,
  IntegrationSyncLeaseLostError,
  OperationDeadlineExceededError,
  retryDelayMsBeforeDeadline,
  type IntegrationSyncLeaseGuard,
} from "./integrationUtils";

const syncResult = (fetched: number): SyncResult => ({
  fetched,
  upserted: fetched,
  artistsLinked: 0,
  missing: 0,
  cancelled: 0,
  outsideNyc: 0,
  geographyUnknown: 0,
  leadTimeExcluded: 0,
  leadTimeGeographyUnknown: 0,
  venuesCached: 0,
  venuesReused: 0,
  identityConflicts: [],
});

function eventWithCountry(country: string): EdmtrainEvent {
  return {
    id: 1,
    date: "2026-07-16",
    ages: null,
    electronicGenreInd: true,
    festivalInd: true,
    livestreamInd: false,
    name: "Test Festival",
    link: null,
    startTime: null,
    endTime: null,
    createdDate: "2026-01-01",
    artistList: [],
    venue: {
      id: 1,
      name: "Test Venue",
      location: "Toronto, ON",
      state: "ON",
      address: "",
      country,
      latitude: 0,
      longitude: 0,
    },
  };
}

test("EDMTrain geography persists provider countries without assuming US", () => {
  assert.deepEqual(edmtrainEventGeography(eventWithCountry("Canada")), {
    city: "Toronto",
    state: "ON",
    countryCode: "CA",
    countryName: "Canada",
  });
  assert.deepEqual(edmtrainEventGeography(eventWithCountry("Atlantis")), {
    city: "Toronto",
    state: "ON",
    countryCode: null,
    countryName: "Atlantis",
  });
});

test("festival reconciliation succeeds when the NYC snapshot fails", async () => {
  let festivalsAttempted = false;
  const result = await runIndependentEdmtrainSyncs(
    async () => {
      throw new Error("NYC provider unavailable");
    },
    async () => {
      festivalsAttempted = true;
      return syncResult(12);
    }
  );

  assert.equal(festivalsAttempted, true);
  assert.deepEqual(result.nyc, {
    ok: false,
    error: "NYC provider unavailable",
  });
  assert.equal(result.festivals.ok, true);
  if (result.festivals.ok) assert.equal(result.festivals.data.fetched, 12);
});

test("NYC reconciliation remains successful when festivals fail", async () => {
  const result = await runIndependentEdmtrainSyncs(
    async () => syncResult(8),
    async () => {
      throw new Error("festival provider unavailable");
    }
  );

  assert.equal(result.nyc.ok, true);
  if (result.nyc.ok) assert.equal(result.nyc.data.fetched, 8);
  assert.deepEqual(result.festivals, {
    ok: false,
    error: "festival provider unavailable",
  });
});

test("EDMTrain fetches overlap while identity-lock reconciliations serialize", async () => {
  let activeFetches = 0;
  let maxActiveFetches = 0;
  let activeReconciliations = 0;
  let maxActiveReconciliations = 0;
  const fetchSnapshot = async (scope: string) => {
    activeFetches++;
    maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
    await Promise.resolve();
    activeFetches--;
    return scope;
  };
  const reconcile = async (scope: string) => {
    activeReconciliations++;
    maxActiveReconciliations = Math.max(
      maxActiveReconciliations,
      activeReconciliations
    );
    await Promise.resolve();
    activeReconciliations--;
    if (scope === "nyc") throw new Error("NYC reconciliation failed");
    return syncResult(7);
  };

  const result = await runConcurrentEdmtrainSnapshotSyncs(
    () => fetchSnapshot("nyc"),
    () => fetchSnapshot("festivals"),
    reconcile,
    reconcile
  );

  assert.equal(maxActiveFetches, 2);
  assert.equal(maxActiveReconciliations, 1);
  assert.deepEqual(result.nyc, {
    ok: false,
    error: "NYC reconciliation failed",
  });
  assert.equal(result.festivals.ok, true);
  if (result.festivals.ok) assert.equal(result.festivals.data.fetched, 7);
});

test("each EDMTrain scope lease spans concurrent fetch through serialized reconciliation", async () => {
  const scheduleReconciliation =
    createSerializedEdmtrainReconciliationScheduler();
  const activeLeases = new Set<string>();
  let activeFetches = 0;
  let maxActiveFetches = 0;
  let activeReconciliations = 0;
  let maxActiveReconciliations = 0;
  let releaseFetches!: () => void;
  const fetchGate = new Promise<void>((resolve) => {
    releaseFetches = resolve;
  });

  const acquireLease = (scope: string): EdmtrainScopeLeaseAcquirer =>
    async (work) => {
      activeLeases.add(scope);
      const guard: IntegrationSyncLeaseGuard = {
        key: `lease:${scope}`,
        ownerToken: `owner:${scope}`,
        async assertOwned() {
          assert.equal(activeLeases.has(scope), true);
        },
        async fenceTransaction() {
          assert.equal(activeLeases.has(scope), true);
        },
      };
      try {
        return {
          ok: true,
          status: "completed",
          data: await work(guard),
        };
      } finally {
        activeLeases.delete(scope);
      }
    };

  const runScope = (scope: string) =>
    runLeasedEdmtrainSnapshotSync(
      acquireLease(scope),
      async () => {
        assert.equal(activeLeases.has(scope), true);
        activeFetches++;
        maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
        if (activeFetches === 2) releaseFetches();
        await fetchGate;
        activeFetches--;
        return scope;
      },
      scheduleReconciliation,
      async (snapshot) => {
        assert.equal(activeLeases.has(scope), true);
        assert.equal(snapshot, scope);
        activeReconciliations++;
        maxActiveReconciliations = Math.max(
          maxActiveReconciliations,
          activeReconciliations
        );
        await Promise.resolve();
        activeReconciliations--;
        return syncResult(1);
      }
    );

  const [nyc, festivals] = await Promise.all([
    runScope("nyc"),
    runScope("festivals"),
  ]);

  assert.equal(nyc.ok, true);
  assert.equal(festivals.ok, true);
  assert.equal(maxActiveFetches, 2);
  assert.equal(maxActiveReconciliations, 1);
  assert.deepEqual(activeLeases, new Set());
});

test("an older EDMTrain worker cannot reconcile after losing its queued scope lease", async () => {
  let owned = true;
  let reconciled = false;
  let markQueued!: () => void;
  let releaseQueue!: () => void;
  const queued = new Promise<void>((resolve) => {
    markQueued = resolve;
  });
  const queueGate = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const guard: IntegrationSyncLeaseGuard = {
    key: "lease:nyc",
    ownerToken: "older-generation",
    async assertOwned() {
      if (!owned) throw new IntegrationSyncLeaseLostError(this.key);
    },
    async fenceTransaction() {
      if (!owned) throw new IntegrationSyncLeaseLostError(this.key);
    },
  };
  const pending = runLeasedEdmtrainSnapshotSync(
    async (work) => ({
      ok: true,
      status: "completed",
      data: await work(guard),
    }),
    async () => "older-snapshot",
    async (work) => {
      markQueued();
      await queueGate;
      return work();
    },
    async () => {
      reconciled = true;
      return syncResult(1);
    }
  );

  await queued;
  owned = false;
  releaseQueue();

  await assert.rejects(pending, IntegrationSyncLeaseLostError);
  assert.equal(reconciled, false);
});

test("concurrent EDMTrain fetch aborts retain structured scope deferrals", async () => {
  const deadline = createOperationDeadline(10_000, { now: () => 0 });
  const result = await runConcurrentEdmtrainSnapshotSyncs(
    async () => {
      throw Object.assign(new Error("request timed out"), {
        name: "AbortError",
      });
    },
    async () => "festivals",
    async () => syncResult(0),
    async () => syncResult(4),
    {
      nyc: { deadline, operation: "nyc EDMTrain synchronization" },
      festivals: {
        deadline,
        operation: "festivals EDMTrain synchronization",
      },
    }
  );

  assert.equal(result.nyc.ok, false);
  assert.equal("status" in result.nyc ? result.nyc.status : null, "deferred");
  if ("status" in result.nyc && result.nyc.status === "deferred") {
    assert.equal(result.nyc.details.deadlineCause, "abort_signal");
    assert.equal(result.nyc.details.priorSnapshotPreserved, true);
  }
  assert.equal(result.festivals.ok, true);
});

test("scope lease conflicts are returned without running a second reconciliation", async () => {
  const busy = {
    ok: false as const,
    status: "busy" as const,
    reason: "lease_conflict" as const,
    leaseKey: "integration-sync:edmtrain-nyc:W10",
    expiresAt: "2026-07-16T12:00:00.000Z",
    retryAfterMs: 10_000,
  };
  const result = await runIndependentEdmtrainSyncs(
    async () => busy,
    async () => syncResult(3)
  );

  assert.deepEqual(result.nyc, busy);
  assert.equal(result.festivals.ok, true);
});

test("EDMTrain scope flags must be present booleans before a snapshot is complete", async () => {
  const baseEvent = {
    id: 1,
    date: "2026-07-16",
    venue: { id: 1, name: "Venue" },
    artistList: [],
  };
  assert.equal(
    isValidEdmtrainSnapshotEvent({
      ...baseEvent,
      festivalInd: false,
      electronicGenreInd: false,
    }),
    true
  );
  for (const flags of [
    { electronicGenreInd: true },
    { festivalInd: null, electronicGenreInd: true },
    { festivalInd: false, electronicGenreInd: "true" },
  ]) {
    assert.equal(
      isValidEdmtrainSnapshotEvent({ ...baseEvent, ...flags }),
      false
    );
  }

  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.EDMTRAIN_API_KEY;
  process.env.EDMTRAIN_API_KEY = "test-key";
  globalThis.fetch = (async () =>
    Response.json({
      success: true,
      data: [
        {
          ...baseEvent,
          festivalInd: null,
          electronicGenreInd: true,
        },
      ],
    })) as typeof fetch;
  try {
    await assert.rejects(
      fetchEdmtrainEvents(
        1,
        null,
        createOperationDeadline(30_000, { now: () => 0 })
      ),
      /incomplete event snapshot with invalid scope flags/
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.EDMTRAIN_API_KEY;
    else process.env.EDMTRAIN_API_KEY = originalApiKey;
  }
});

test("formerly blocklisted venues follow cancellation, geography, and festival lead-time rules", () => {
  const event = eventWithCountry("United States");
  event.venue.name = "The Surf Lodge";
  event.venue.location = "Montauk, NY";
  event.venue.state = "NY";
  event.festivalInd = false;
  assert.equal(edmtrainEventStatus(event, "inside_nyc"), "active");
  assert.equal(
    edmtrainEventStatus(event, "outside_nyc"),
    "outside_nyc"
  );
  assert.equal(
    edmtrainEventStatus(event, "unknown"),
    "geography_unknown"
  );

  event.festivalInd = true;
  event.date = "2026-07-26";
  const now = new Date("2026-07-20T12:00:00.000Z");
  assert.equal(
    edmtrainEventStatus(event, "inside_nyc", now),
    "active"
  );
  assert.equal(
    edmtrainEventStatus(event, "outside_nyc", now),
    "lead_time_outside_nyc"
  );
  assert.equal(
    edmtrainEventStatus(event, "unknown", now),
    "lead_time_geography_unknown"
  );

  event.date = "2026-07-27";
  assert.equal(
    edmtrainEventStatus(event, "outside_nyc", now),
    "active"
  );
  event.date = "2026-07-19";
  assert.equal(
    edmtrainEventStatus(event, "inside_nyc", now),
    "festival_past"
  );
  event.cancelledInd = true;
  assert.equal(
    edmtrainEventStatus(event, "outside_nyc", now),
    "cancelled"
  );

  const source = readFileSync(new URL("./edmtrain.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /event\.festivalInd \? venue\.nycStatus : null[\s\S]*"festivalNycStatus"/
  );
});

test("festival migration permits every emitted sync status and retains blocked only for legacy rows", () => {
  const migration = readFileSync(
    new URL(
      "../prisma/migrations/20260720170000_festival_lead_time/migration.sql",
      import.meta.url
    ),
    "utf8"
  );
  const constraint = /ADD CONSTRAINT "Show_syncStatus_check"[\s\S]*?CHECK \(\s*"syncStatus" IN \(([\s\S]*?)\)\s*\);/.exec(
    migration
  );
  assert.ok(constraint, "sync status constraint must be recreated");
  const allowed = new Set(
    [...constraint[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
  );
  assert.deepEqual(allowed, new Set([
    "active",
    "cancelled",
    "blocked",
    "missing",
    "outside_nyc",
    "geography_unknown",
    "festival_past",
    "lead_time_outside_nyc",
    "lead_time_geography_unknown",
  ]));

  const now = new Date("2026-07-20T12:00:00.000Z");
  const active = eventWithCountry("United States");
  active.festivalInd = false;
  active.date = "2026-07-20";
  const cancelled = { ...active, cancelledInd: true };
  const festival = { ...active, festivalInd: true };
  const emitted = new Set<string>([
    edmtrainEventStatus(active, "inside_nyc", now),
    edmtrainEventStatus(cancelled, "inside_nyc", now),
    edmtrainEventStatus(active, "outside_nyc", now),
    edmtrainEventStatus(active, "unknown", now),
    edmtrainEventStatus(
      { ...festival, date: "2026-07-19" },
      "inside_nyc",
      now
    ),
    edmtrainEventStatus(
      { ...festival, date: "2026-07-26" },
      "outside_nyc",
      now
    ),
    edmtrainEventStatus(
      { ...festival, date: "2026-07-26" },
      "unknown",
      now
    ),
  ]);
  assert.deepEqual(emitted, new Set([
    "active",
    "cancelled",
    "outside_nyc",
    "geography_unknown",
    "festival_past",
    "lead_time_outside_nyc",
    "lead_time_geography_unknown",
  ]));
  for (const status of emitted) assert.ok(allowed.has(status));
  assert.equal(emitted.has("blocked"), false);
  assert.equal(allowed.has("blocked"), true);
  assert.equal(allowed.has("lead_time_unknown"), false);

  const begin = migration.indexOf("BEGIN;");
  const drop = migration.indexOf('DROP CONSTRAINT "Show_syncStatus_check"');
  const add = migration.indexOf('ADD CONSTRAINT "Show_syncStatus_check"');
  const commit = migration.lastIndexOf("COMMIT;");
  assert.ok(begin >= 0 && begin < drop && drop < add && add < commit);
});

test("EDMTrain retry-budget failures remain structured at the provider boundary", async () => {
  const deadline = createOperationDeadline(10_000, { now: () => 0 });
  const result = await runIndependentEdmtrainSyncs(
    async () => {
      retryDelayMsBeforeDeadline(
        deadline,
        1,
        6_000,
        "EDMTrain provider retry",
        5_000
      );
      return syncResult(0);
    },
    async () => syncResult(2)
  );

  assert.equal(result.nyc.ok, false);
  assert.equal("status" in result.nyc ? result.nyc.status : null, "deferred");
  if ("status" in result.nyc && result.nyc.status === "deferred") {
    assert.equal(result.nyc.details.deadlineCause, "retry_after");
    assert.equal(result.nyc.details.retryAfterMs, 6_000);
    assert.equal(result.nyc.details.expiresAtMs, 10_000);
  }
  assert.equal(result.festivals.ok, true);
});

test("all EDMTrain chunks share one absolute fake-clock deadline", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.EDMTRAIN_API_KEY;
  let nowMs = 0;
  let fetches = 0;
  process.env.EDMTRAIN_API_KEY = "test-key";
  globalThis.fetch = (async () => {
    fetches++;
    nowMs += 10_000;
    return Response.json({ success: true, data: [] });
  }) as typeof fetch;

  try {
    const deadline = createOperationDeadline(35_000, {
      now: () => nowMs,
      sleep: async (delayMs) => {
        nowMs += delayMs;
      },
    });
    await assert.rejects(
      fetchEdmtrainEvents(365, null, deadline),
      OperationDeadlineExceededError
    );
    assert.equal(fetches, 4);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.EDMTRAIN_API_KEY;
    else process.env.EDMTRAIN_API_KEY = originalApiKey;
  }
});

test("EDMTrain never shortens Retry-After to fit the deadline", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.EDMTRAIN_API_KEY;
  let nowMs = 0;
  const sleeps: number[] = [];
  process.env.EDMTRAIN_API_KEY = "test-key";
  globalThis.fetch = (async () =>
    new Response("rate limited", {
      status: 429,
      headers: { "Retry-After": "6" },
    })) as typeof fetch;

  try {
    const deadline = createOperationDeadline(10_000, {
      now: () => nowMs,
      sleep: async (delayMs) => {
        sleeps.push(delayMs);
        nowMs += delayMs;
      },
    });
    await assert.rejects(
      fetchEdmtrainEvents(1, null, deadline),
      (error) => {
        assert.ok(error instanceof DeferredRetryError);
        assert.equal(error.retryAfterMs, 6_000);
        assert.equal(error.safeExecutionBudgetMs, 5_000);
        return true;
      }
    );
    assert.deepEqual(sleeps, []);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.EDMTRAIN_API_KEY;
    else process.env.EDMTRAIN_API_KEY = originalApiKey;
  }
});

test("each EDMTrain scope reconciles with deadline-bound transaction options", () => {
  const source = readFileSync(new URL("./edmtrain.ts", import.meta.url), "utf8");

  assert.match(
    source,
    /runDeadlineBoundTransaction\(\s*deadline,\s*transactionPolicy/
  );
  assert.match(
    source,
    /EDMTRAIN_RECONCILIATION_MIN_TIMEOUT_MS = 45_000/
  );
  assert.match(
    source,
    /minimumDeadlineTransactionRemainingMs\(transactionPolicy\)/
  );
  assert.doesNotMatch(
    source,
    /\{\s*maxWait:\s*10_000,\s*timeout:\s*180_000\s*\}/
  );
});

test("EDMTrain scopes defer before leases or provider reads when transaction time is unsafe", async () => {
  const deadline = createOperationDeadline(20_000, { now: () => 0 });
  const [nyc, festivals] = await Promise.all([
    syncEdmtrainShows(90, deadline),
    syncEdmtrainFestivals(365, deadline),
  ]);

  for (const result of [nyc, festivals]) {
    assert.equal(result.ok, false);
    assert.equal("status" in result ? result.status : null, "deferred");
    if ("status" in result && result.status === "deferred") {
      assert.equal(result.details.requiredMs, 46_001);
      assert.equal(result.details.destructiveWorkStarted, false);
      assert.equal(result.details.priorSnapshotPreserved, true);
    }
  }
});
