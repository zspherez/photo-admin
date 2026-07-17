import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface MigrationHistoryEntry {
  migrationName: string;
  checksum: string;
  startedAt: string;
  finishedAt: string | null;
  rolledBackAt: string | null;
  appliedStepsCount: number;
}

export interface ExpectedMigration {
  migrationName: string;
  checksum: string;
}

export interface DatabaseTargetConnection {
  readMigrationHistory(): Promise<MigrationHistoryEntry[]>;
  writeVerificationNonce(key: string, value: string): Promise<void>;
  readVerificationNonce(key: string): Promise<string | null>;
  deleteVerificationNonce(key: string, expectedValue?: string): Promise<boolean>;
}

export interface DatabaseTargetVerificationOptions {
  expectedMigrations: readonly ExpectedMigration[];
  requireAllMigrations?: boolean;
  createNonce?: () => string;
}

export interface DatabaseTargetVerificationResult {
  appliedMigrationCount: number;
  expectedMigrationCount: number;
  pendingMigrationCount: number;
  allMigrationsApplied: boolean;
  nonceVerified: true;
}

export class DatabaseTargetVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseTargetVerificationError";
  }
}

function validMigrationName(value: string): boolean {
  return /^[0-9]{14}_[a-z0-9][a-z0-9_]*$/.test(value);
}

function validChecksum(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

export function readExpectedMigrationHistory(
  migrationsDirectory: string
): ExpectedMigration[] {
  const migrations = readdirSync(migrationsDirectory, {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  if (migrations.length === 0) {
    throw new DatabaseTargetVerificationError(
      "Requested revision has no Prisma migrations"
    );
  }

  const seen = new Set<string>();
  return migrations.map((migrationName) => {
    if (!validMigrationName(migrationName) || seen.has(migrationName)) {
      throw new DatabaseTargetVerificationError(
        "Requested revision contains an invalid Prisma migration history"
      );
    }
    seen.add(migrationName);
    let sql: Buffer;
    try {
      sql = readFileSync(join(migrationsDirectory, migrationName, "migration.sql"));
    } catch {
      throw new DatabaseTargetVerificationError(
        `Requested revision is missing migration.sql for ${migrationName}`
      );
    }
    return {
      migrationName,
      checksum: createHash("sha256").update(sql).digest("hex"),
    };
  });
}

function canonicalMigrationHistory(
  history: readonly MigrationHistoryEntry[]
): string {
  return JSON.stringify(
    history.map((migration) => ({
      migrationName: migration.migrationName,
      checksum: migration.checksum,
      startedAt: migration.startedAt,
      finishedAt: migration.finishedAt,
      rolledBackAt: migration.rolledBackAt,
      appliedStepsCount: migration.appliedStepsCount,
    }))
  );
}

export function verifyAppliedMigrationPrefix(
  history: readonly MigrationHistoryEntry[],
  expected: readonly ExpectedMigration[],
  requireAllMigrations = false
): number {
  if (history.length === 0) {
    throw new DatabaseTargetVerificationError(
      "Database migration history is empty or unavailable"
    );
  }
  if (expected.length === 0) {
    throw new DatabaseTargetVerificationError(
      "Requested revision has no Prisma migrations"
    );
  }

  const applied: MigrationHistoryEntry[] = [];
  const appliedNames = new Set<string>();
  for (const migration of history) {
    if (
      !validMigrationName(migration.migrationName) ||
      !validChecksum(migration.checksum) ||
      !migration.startedAt ||
      !Number.isInteger(migration.appliedStepsCount) ||
      migration.appliedStepsCount < 0
    ) {
      throw new DatabaseTargetVerificationError(
        "Database migration history contains a malformed entry"
      );
    }
    if (migration.rolledBackAt !== null) continue;
    if (
      migration.finishedAt === null ||
      migration.appliedStepsCount < 1
    ) {
      throw new DatabaseTargetVerificationError(
        `Database has an unresolved Prisma migration: ${migration.migrationName}`
      );
    }
    if (appliedNames.has(migration.migrationName)) {
      throw new DatabaseTargetVerificationError(
        "Database migration history contains duplicate applied migration names"
      );
    }
    appliedNames.add(migration.migrationName);
    applied.push(migration);
  }

  if (applied.length === 0) {
    throw new DatabaseTargetVerificationError(
      "Database has no successfully applied Prisma migrations"
    );
  }
  if (applied.length > expected.length) {
    throw new DatabaseTargetVerificationError(
      "Database migration history is newer than the requested revision"
    );
  }

  applied.forEach((migration, index) => {
    const requested = expected[index];
    if (
      requested?.migrationName !== migration.migrationName ||
      requested.checksum !== migration.checksum
    ) {
      throw new DatabaseTargetVerificationError(
        "Database applied migrations are not an exact checksum-valid prefix of the requested revision"
      );
    }
  });

  if (requireAllMigrations && applied.length !== expected.length) {
    throw new DatabaseTargetVerificationError(
      "Requested revision still has unapplied Prisma migrations"
    );
  }
  return applied.length;
}

async function deleteNonceEverywhere(
  runtime: DatabaseTargetConnection,
  direct: DatabaseTargetConnection,
  key: string,
  expectedValue: string
): Promise<void> {
  await Promise.allSettled([
    runtime.deleteVerificationNonce(key, expectedValue),
    direct.deleteVerificationNonce(key, expectedValue),
  ]);
}

export async function verifyDatabaseTargetConnections(
  runtime: DatabaseTargetConnection,
  direct: DatabaseTargetConnection,
  options: DatabaseTargetVerificationOptions
): Promise<DatabaseTargetVerificationResult> {
  const [runtimeHistory, directHistory] = await Promise.all([
    runtime.readMigrationHistory(),
    direct.readMigrationHistory(),
  ]);

  if (
    canonicalMigrationHistory(runtimeHistory) !==
    canonicalMigrationHistory(directHistory)
  ) {
    throw new DatabaseTargetVerificationError(
      "DATABASE_URL and DIRECT_URL have different migration histories"
    );
  }

  const appliedMigrationCount = verifyAppliedMigrationPrefix(
    runtimeHistory,
    options.expectedMigrations,
    options.requireAllMigrations
  );
  const createNonce = options.createNonce ?? randomUUID;
  const nonceId = createNonce();
  const nonceValue = createNonce();
  if (!validUuid(nonceId) || !validUuid(nonceValue) || nonceId === nonceValue) {
    throw new DatabaseTargetVerificationError(
      "Generated database verification nonce is invalid"
    );
  }
  const nonceKey = `release_database_verification_nonce:${nonceId}`;

  try {
    await runtime.writeVerificationNonce(nonceKey, nonceValue);
    if ((await direct.readVerificationNonce(nonceKey)) !== nonceValue) {
      throw new DatabaseTargetVerificationError(
        "A fresh DATABASE_URL write was not observed through DIRECT_URL"
      );
    }
    if (!(await direct.deleteVerificationNonce(nonceKey, nonceValue))) {
      throw new DatabaseTargetVerificationError(
        "Fresh database verification nonce could not be cleaned through DIRECT_URL"
      );
    }
    if ((await runtime.readVerificationNonce(nonceKey)) !== null) {
      throw new DatabaseTargetVerificationError(
        "Fresh database verification nonce cleanup was not observed through DATABASE_URL"
      );
    }
  } finally {
    await deleteNonceEverywhere(runtime, direct, nonceKey, nonceValue);
  }

  const expectedMigrationCount = options.expectedMigrations.length;
  return {
    appliedMigrationCount,
    expectedMigrationCount,
    pendingMigrationCount: expectedMigrationCount - appliedMigrationCount,
    allMigrationsApplied: appliedMigrationCount === expectedMigrationCount,
    nonceVerified: true,
  };
}
