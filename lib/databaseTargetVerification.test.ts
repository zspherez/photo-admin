import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DatabaseTargetVerificationError,
  type DatabaseTargetConnection,
  type ExpectedMigration,
  type MigrationHistoryEntry,
  readExpectedMigrationHistory,
  verifyAppliedMigrationPrefix,
  verifyDatabaseTargetConnections,
} from "./databaseTargetVerification";

const NONCE_ID = "c1453f7a-e1d8-4c28-b70e-b2ad3e12f95a";
const NONCE_VALUE = "240bd4db-77c5-44df-b7d0-d3e74c53949a";

interface MockDatabaseState {
  migrations: MigrationHistoryEntry[];
  settings: Map<string, string>;
}

class MockDatabaseConnection implements DatabaseTargetConnection {
  readonly writes: string[] = [];
  readonly deletes: string[] = [];

  constructor(readonly state: MockDatabaseState) {}

  async readMigrationHistory(): Promise<MigrationHistoryEntry[]> {
    return structuredClone(this.state.migrations);
  }

  async writeVerificationNonce(key: string, value: string): Promise<void> {
    if (this.state.settings.has(key)) throw new Error("duplicate nonce");
    this.state.settings.set(key, value);
    this.writes.push(key);
  }

  async readVerificationNonce(key: string): Promise<string | null> {
    return this.state.settings.get(key) ?? null;
  }

  async deleteVerificationNonce(key: string): Promise<boolean> {
    this.deletes.push(key);
    return this.state.settings.delete(key);
  }
}

function checksum(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

function expected(migrationName: string, seed = "a"): ExpectedMigration {
  return { migrationName, checksum: checksum(seed) };
}

function migration(
  migrationName: string,
  seed = "a",
  overrides: Partial<MigrationHistoryEntry> = {}
): MigrationHistoryEntry {
  return {
    migrationName,
    checksum: checksum(seed),
    startedAt: "2026-07-16T12:00:00.000Z",
    finishedAt: "2026-07-16T12:00:01.000Z",
    rolledBackAt: null,
    appliedStepsCount: 1,
    ...overrides,
  };
}

function nonceFactory(): () => string {
  const values = [NONCE_ID, NONCE_VALUE];
  return () => values.shift() ?? "unexpected";
}

test("database verification accepts an exact applied prefix and cleans a fresh cross-connection nonce", async () => {
  const state = {
    migrations: [migration("20260520044338_init")],
    settings: new Map<string, string>(),
  };
  const runtime = new MockDatabaseConnection(state);
  const direct = new MockDatabaseConnection(state);

  assert.deepEqual(
    await verifyDatabaseTargetConnections(runtime, direct, {
      expectedMigrations: [
        expected("20260520044338_init"),
        expected("20260526000000_contact_email_optional", "b"),
      ],
      createNonce: nonceFactory(),
    }),
    {
      appliedMigrationCount: 1,
      expectedMigrationCount: 2,
      pendingMigrationCount: 1,
      allMigrationsApplied: false,
      nonceVerified: true,
    }
  );
  assert.equal(runtime.writes.length, 1);
  assert.equal(state.settings.size, 0);
  assert.ok(direct.deletes.length >= 1);
});

test("separate databases fail the fresh nonce proof and the writer is cleaned", async () => {
  const migrations = [migration("20260520044338_init")];
  const runtimeState = {
    migrations,
    settings: new Map<string, string>(),
  };
  const directState = {
    migrations,
    settings: new Map<string, string>(),
  };

  await assert.rejects(
    verifyDatabaseTargetConnections(
      new MockDatabaseConnection(runtimeState),
      new MockDatabaseConnection(directState),
      {
        expectedMigrations: [expected("20260520044338_init")],
        createNonce: nonceFactory(),
      }
    ),
    /fresh DATABASE_URL write was not observed/
  );
  assert.equal(runtimeState.settings.size, 0);
  assert.equal(directState.settings.size, 0);
});

test("migration histories must match before the nonce proof begins", async () => {
  const runtime = new MockDatabaseConnection({
    migrations: [migration("20260520044338_init")],
    settings: new Map(),
  });
  const direct = new MockDatabaseConnection({
    migrations: [migration("20260520044338_init", "b")],
    settings: new Map(),
  });

  await assert.rejects(
    verifyDatabaseTargetConnections(runtime, direct, {
      expectedMigrations: [expected("20260520044338_init")],
      createNonce: nonceFactory(),
    }),
    /different migration histories/
  );
  assert.equal(runtime.writes.length, 0);
});

test("applied migrations must be the requested checksum-valid prefix", () => {
  const requested = [
    expected("20260520044338_init"),
    expected("20260526000000_contact_email_optional", "b"),
  ];

  assert.equal(
    verifyAppliedMigrationPrefix(
      [migration("20260520044338_init")],
      requested
    ),
    1
  );
  assert.throws(
    () =>
      verifyAppliedMigrationPrefix(
        [migration("20260520044338_init", "f")],
        requested
      ),
    /exact checksum-valid prefix/
  );
  assert.throws(
    () =>
      verifyAppliedMigrationPrefix(
        [
          migration("20260520044338_init"),
          migration("20260525000000_database_only", "b"),
        ],
        requested
      ),
    /exact checksum-valid prefix/
  );
  assert.throws(
    () =>
      verifyAppliedMigrationPrefix(
        [
          migration("20260520044338_init"),
          migration("20260526000000_contact_email_optional", "b"),
          migration("20260527000000_database_only", "c"),
        ],
        requested
      ),
    /newer than the requested revision/
  );
});

test("unresolved migrations and incomplete required histories fail closed", () => {
  const requested = [
    expected("20260520044338_init"),
    expected("20260526000000_contact_email_optional", "b"),
  ];
  assert.throws(
    () =>
      verifyAppliedMigrationPrefix(
        [
          migration("20260520044338_init", "a", {
            finishedAt: null,
            appliedStepsCount: 0,
          }),
        ],
        requested
      ),
    /unresolved Prisma migration/
  );
  assert.throws(
    () =>
      verifyAppliedMigrationPrefix(
        [migration("20260520044338_init")],
        requested,
        true
      ),
    /still has unapplied/
  );
});

test("the requested checkout migration reader returns ordered SHA-256 checksums", () => {
  const history = readExpectedMigrationHistory(
    new URL("../prisma/migrations", import.meta.url).pathname
  );

  assert.ok(history.length > 0);
  assert.deepEqual(
    history.map((entry) => entry.migrationName),
    [...history.map((entry) => entry.migrationName)].sort()
  );
  assert.ok(history.every((entry) => /^[0-9a-f]{64}$/.test(entry.checksum)));
});

test("database verification logs only safe summary fields", () => {
  const source = readFileSync(
    new URL("../scripts/verify-database-targets.ts", import.meta.url),
    "utf8"
  );

  assert.match(source, /event: "database_targets_verified"/);
  assert.match(source, /readExpectedMigrationHistory/);
  assert.match(source, /--require-all-migrations/);
  assert.doesNotMatch(
    source,
    /console\.(?:log|error)\([^)]*process\.env\.(?:DATABASE_URL|DIRECT_URL)/
  );
  assert.doesNotMatch(source, /nonce(?:Id|Value|Key):/);
});

test("invalid nonce generators fail before touching the database", async () => {
  const state = {
    migrations: [migration("20260520044338_init")],
    settings: new Map<string, string>(),
  };
  const runtime = new MockDatabaseConnection(state);
  const direct = new MockDatabaseConnection(state);

  await assert.rejects(
    verifyDatabaseTargetConnections(runtime, direct, {
      expectedMigrations: [expected("20260520044338_init")],
      createNonce: () => NONCE_ID,
    }),
    DatabaseTargetVerificationError
  );
  assert.equal(runtime.writes.length, 0);
});
