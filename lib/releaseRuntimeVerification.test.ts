import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type {
  DatabaseTargetConnection,
  MigrationHistoryEntry,
} from "./databaseTargetVerification";
import {
  cleanupReleaseRuntimeVerification,
  prepareReleaseRuntimeVerification,
  RELEASE_RUNTIME_VERIFICATION_SETTING_KEY,
  resolveReleaseRuntimeVerificationRequest,
  type ReleaseRuntimeVerificationMarker,
} from "./releaseRuntimeVerification";

const NOW = Date.parse("2026-07-17T16:00:00.000Z");
const RELEASE_SHA = "a".repeat(40);
const NONCE = Buffer.alloc(32, 7).toString("base64url");
const OTHER_NONCE = Buffer.alloc(32, 8).toString("base64url");
const CRON_SECRET = "release-cron-secret";
const APP_BASE_URL = "https://photo-admin.example";

interface MockDatabaseState {
  settings: Map<string, string>;
}

class MockDatabaseConnection implements DatabaseTargetConnection {
  readonly writes: string[] = [];
  readonly deletes: string[] = [];

  constructor(readonly state: MockDatabaseState) {}

  async readMigrationHistory(): Promise<MigrationHistoryEntry[]> {
    return [];
  }

  async writeVerificationNonce(key: string, value: string): Promise<void> {
    if (this.state.settings.has(key)) throw new Error("duplicate marker");
    this.state.settings.set(key, value);
    this.writes.push(value);
  }

  async readVerificationNonce(key: string): Promise<string | null> {
    return this.state.settings.get(key) ?? null;
  }

  async deleteVerificationNonce(
    key: string,
    expectedValue?: string
  ): Promise<boolean> {
    const current = this.state.settings.get(key);
    if (
      current === undefined ||
      (expectedValue !== undefined && current !== expectedValue)
    ) {
      return false;
    }
    this.deletes.push(current);
    return this.state.settings.delete(key);
  }
}

function markerValue(
  overrides: Partial<ReleaseRuntimeVerificationMarker> = {}
): string {
  return JSON.stringify({
    version: 1,
    nonce: NONCE,
    releaseSha: RELEASE_SHA,
    expiresAt: NOW + 25 * 60 * 1_000,
    ...overrides,
  });
}

function bearer(secret = CRON_SECRET): string {
  return `Bearer ${secret}`;
}

test("release marker is written across both GitHub database connections and conditionally cleaned", async () => {
  const state = { settings: new Map<string, string>() };
  const runtime = new MockDatabaseConnection(state);
  const direct = new MockDatabaseConnection(state);

  const marker = await prepareReleaseRuntimeVerification(runtime, direct, {
    releaseSha: RELEASE_SHA,
    now: () => NOW,
    createNonce: () => NONCE,
  });

  assert.deepEqual(marker, {
    version: 1,
    nonce: NONCE,
    releaseSha: RELEASE_SHA,
    expiresAt: NOW + 25 * 60 * 1_000,
  });
  assert.equal(runtime.writes.length, 1);
  assert.equal(
    state.settings.get(RELEASE_RUNTIME_VERIFICATION_SETTING_KEY),
    markerValue()
  );

  await cleanupReleaseRuntimeVerification(runtime, direct, NONCE);
  assert.equal(state.settings.size, 0);
  assert.ok(runtime.deletes.length + direct.deletes.length >= 1);
});

test("a staged runtime on a different database cannot observe the candidate marker and the writer is cleaned", async () => {
  const candidateState = { settings: new Map<string, string>() };
  const stagedState = { settings: new Map<string, string>() };
  const runtime = new MockDatabaseConnection(candidateState);
  const direct = new MockDatabaseConnection(stagedState);

  await assert.rejects(
    prepareReleaseRuntimeVerification(runtime, direct, {
      releaseSha: RELEASE_SHA,
      now: () => NOW,
      createNonce: () => NONCE,
    }),
    /was not observed through DIRECT_URL/
  );
  assert.equal(candidateState.settings.size, 0);
  assert.equal(stagedState.settings.size, 0);
});

test("stale and malformed abandoned markers are replaced, while an active marker blocks replacement", async (t) => {
  for (const [name, existing] of [
    ["stale", markerValue({ expiresAt: NOW - 1 })],
    ["malformed", '{"version":1,"nonce":"broken"}'],
    [
      "far-future",
      markerValue({ expiresAt: NOW + 31 * 60 * 1_000 }),
    ],
  ] as const) {
    await t.test(name, async () => {
      const state = {
        settings: new Map([[RELEASE_RUNTIME_VERIFICATION_SETTING_KEY, existing]]),
      };
      const runtime = new MockDatabaseConnection(state);
      const direct = new MockDatabaseConnection(state);

      const marker = await prepareReleaseRuntimeVerification(runtime, direct, {
        releaseSha: RELEASE_SHA,
        now: () => NOW,
        createNonce: () => OTHER_NONCE,
      });
      assert.equal(marker.nonce, OTHER_NONCE);
      assert.notEqual(
        state.settings.get(RELEASE_RUNTIME_VERIFICATION_SETTING_KEY),
        existing
      );
    });
  }

  const activeValue = markerValue();
  const activeState = {
    settings: new Map([
      [RELEASE_RUNTIME_VERIFICATION_SETTING_KEY, activeValue],
    ]),
  };
  await assert.rejects(
    prepareReleaseRuntimeVerification(
      new MockDatabaseConnection(activeState),
      new MockDatabaseConnection(activeState),
      {
        releaseSha: RELEASE_SHA,
        now: () => NOW,
        createNonce: () => OTHER_NONCE,
      }
    ),
    /unexpired/
  );
  assert.equal(
    activeState.settings.get(RELEASE_RUNTIME_VERIFICATION_SETTING_KEY),
    activeValue
  );
});

test("cleanup refuses a different nonce and cannot delete another release marker", async () => {
  const value = markerValue();
  const state = {
    settings: new Map([[RELEASE_RUNTIME_VERIFICATION_SETTING_KEY, value]]),
  };

  await assert.rejects(
    cleanupReleaseRuntimeVerification(
      new MockDatabaseConnection(state),
      new MockDatabaseConnection(state),
      OTHER_NONCE
    ),
    /different marker/
  );
  assert.equal(
    state.settings.get(RELEASE_RUNTIME_VERIFICATION_SETTING_KEY),
    value
  );
});

test("runtime verification authenticates before its single fixed marker read", async () => {
  let reads = 0;
  const readMarkerValue = async () => {
    reads += 1;
    return markerValue();
  };

  for (const authorization of [
    null,
    "",
    CRON_SECRET,
    "Bearer",
    "Bearer wrong-secret",
    `Bearer ${NONCE}`,
  ]) {
    const result = await resolveReleaseRuntimeVerificationRequest(
      {
        authorization,
        expectedAppBaseUrl: APP_BASE_URL,
        expectedReleaseSha: RELEASE_SHA,
      },
      {
        cronSecret: CRON_SECRET,
        configuredAppBaseUrl: APP_BASE_URL,
        readMarkerValue,
        now: () => NOW,
      }
    );
    assert.equal(result.status, 401);
  }
  assert.equal(reads, 0);

  const result = await resolveReleaseRuntimeVerificationRequest(
    {
      authorization: bearer(),
      expectedAppBaseUrl: `${APP_BASE_URL}/`,
      expectedReleaseSha: RELEASE_SHA.toUpperCase(),
    },
    {
      cronSecret: CRON_SECRET,
      configuredAppBaseUrl: APP_BASE_URL,
      readMarkerValue,
      now: () => NOW,
    }
  );
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, JSON.parse(markerValue()));
  assert.equal(reads, 1);
});

test("runtime verification fails closed for APP_BASE_URL, SHA, database, malformed, and stale mismatches", async (t) => {
  const cases: Array<{
    name: string;
    appBaseUrl?: string;
    releaseSha?: string;
    value?: string | null;
    throws?: boolean;
    status: number;
    expectedReads: number;
  }> = [
    {
      name: "wrong-app-base-url",
      appBaseUrl: "https://wrong.example",
      status: 401,
      expectedReads: 0,
    },
    {
      name: "malformed-app-base-url",
      appBaseUrl: "not-an-origin",
      status: 400,
      expectedReads: 0,
    },
    {
      name: "wrong-release-sha",
      releaseSha: "b".repeat(40),
      status: 404,
      expectedReads: 1,
    },
    {
      name: "missing-marker",
      value: null,
      status: 404,
      expectedReads: 1,
    },
    {
      name: "malformed-marker",
      value: '{"nonce":"broken"}',
      status: 404,
      expectedReads: 1,
    },
    {
      name: "stale-marker",
      value: markerValue({ expiresAt: NOW }),
      status: 404,
      expectedReads: 1,
    },
    {
      name: "far-future-marker",
      value: markerValue({ expiresAt: NOW + 31 * 60 * 1_000 }),
      status: 404,
      expectedReads: 1,
    },
    {
      name: "database-error",
      throws: true,
      status: 503,
      expectedReads: 1,
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      let reads = 0;
      const result = await resolveReleaseRuntimeVerificationRequest(
        {
          authorization: bearer(),
          expectedAppBaseUrl: testCase.appBaseUrl ?? APP_BASE_URL,
          expectedReleaseSha: testCase.releaseSha ?? RELEASE_SHA,
        },
        {
          cronSecret: CRON_SECRET,
          configuredAppBaseUrl: APP_BASE_URL,
          readMarkerValue: async () => {
            reads += 1;
            if (testCase.throws) throw new Error("database unavailable");
            return testCase.value === undefined
              ? markerValue()
              : testCase.value;
          },
          now: () => NOW,
        }
      );
      assert.equal(result.status, testCase.status);
      assert.equal(reads, testCase.expectedReads);
      assert.doesNotMatch(JSON.stringify(result.body), /postgres|secret/i);
    });
  }
});

test("route is dynamic, uses constant-time request verification, and exposes no query surface", () => {
  const route = readFileSync(
    new URL(
      "../app/api/release/runtime-verification/route.ts",
      import.meta.url
    ),
    "utf8"
  );
  const verifier = readFileSync(
    new URL("./releaseRuntimeVerification.ts", import.meta.url),
    "utf8"
  );

  assert.match(route, /export const dynamic = "force-dynamic"/);
  assert.match(route, /export const runtime = "nodejs"/);
  assert.match(route, /RELEASE_RUNTIME_VERIFICATION_SETTING_KEY/);
  assert.match(route, /select: \{ value: true \}/);
  assert.doesNotMatch(route, /searchParams|request\.json|queryRaw|DATABASE_URL/);
  assert.match(verifier, /isValidCronAuthorization/);
  assert.match(verifier, /constantTimeEqual/);
  assert.doesNotMatch(verifier, /console\.(?:log|error)/);
});
