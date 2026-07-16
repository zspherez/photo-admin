import "dotenv/config";
import { resolve } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  DatabaseTargetVerificationError,
  type DatabaseTargetConnection,
  type MigrationHistoryEntry,
  readExpectedMigrationHistory,
  verifyDatabaseTargetConnections,
} from "@/lib/databaseTargetVerification";

interface MigrationRow {
  migrationName: string;
  checksum: string;
  startedAt: Date;
  finishedAt: Date | null;
  rolledBackAt: Date | null;
  appliedStepsCount: number;
}

interface NonceRow {
  value: string;
}

class PrismaDatabaseTargetConnection implements DatabaseTargetConnection {
  constructor(readonly client: PrismaClient) {}

  async readMigrationHistory(): Promise<MigrationHistoryEntry[]> {
    const rows = await this.client.$queryRaw<MigrationRow[]>(
      Prisma.sql`
        SELECT
          "migration_name" AS "migrationName",
          "checksum",
          "started_at" AS "startedAt",
          "finished_at" AS "finishedAt",
          "rolled_back_at" AS "rolledBackAt",
          "applied_steps_count" AS "appliedStepsCount"
        FROM "_prisma_migrations"
        ORDER BY "started_at", "migration_name", "id"
      `
    );
    return rows.map((row) => ({
      migrationName: row.migrationName,
      checksum: row.checksum,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
      rolledBackAt: row.rolledBackAt?.toISOString() ?? null,
      appliedStepsCount: row.appliedStepsCount,
    }));
  }

  async writeVerificationNonce(key: string, value: string): Promise<void> {
    await this.client.$executeRaw(
      Prisma.sql`
        INSERT INTO "Setting" ("key", "value", "updatedAt")
        VALUES (${key}, ${value}, CURRENT_TIMESTAMP)
      `
    );
  }

  async readVerificationNonce(key: string): Promise<string | null> {
    const rows = await this.client.$queryRaw<NonceRow[]>(
      Prisma.sql`
        SELECT "value"
        FROM "Setting"
        WHERE "key" = ${key}
      `
    );
    return rows[0]?.value ?? null;
  }

  async deleteVerificationNonce(key: string): Promise<boolean> {
    return (
      (await this.client.$executeRaw(
        Prisma.sql`
          DELETE FROM "Setting"
          WHERE "key" = ${key}
        `
      )) > 0
    );
  }
}

function requiredUrl(name: "DATABASE_URL" | "DIRECT_URL"): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new DatabaseTargetVerificationError(`${name} is required`);
  }
  return value;
}

function parseArguments(): { requireAllMigrations: boolean } {
  const args = new Set(process.argv.slice(2));
  const requireAllMigrations = args.delete("--require-all-migrations");
  if (args.size > 0) {
    throw new DatabaseTargetVerificationError(
      `Unknown argument(s): ${Array.from(args).join(", ")}`
    );
  }
  return { requireAllMigrations };
}

async function main(): Promise<void> {
  const { requireAllMigrations } = parseArguments();
  const expectedMigrations = readExpectedMigrationHistory(
    resolve("prisma/migrations")
  );
  const runtimeClient = new PrismaClient({
    datasourceUrl: requiredUrl("DATABASE_URL"),
    errorFormat: "minimal",
  });
  const directClient = new PrismaClient({
    datasourceUrl: requiredUrl("DIRECT_URL"),
    errorFormat: "minimal",
  });

  try {
    await Promise.all([runtimeClient.$connect(), directClient.$connect()]);
    const result = await verifyDatabaseTargetConnections(
      new PrismaDatabaseTargetConnection(runtimeClient),
      new PrismaDatabaseTargetConnection(directClient),
      { expectedMigrations, requireAllMigrations }
    );
    console.log(
      JSON.stringify({
        event: "database_targets_verified",
        ...result,
      })
    );
  } catch (error) {
    if (error instanceof DatabaseTargetVerificationError) throw error;
    throw new DatabaseTargetVerificationError(
      "Independent database target verification could not complete"
    );
  } finally {
    await Promise.allSettled([
      runtimeClient.$disconnect(),
      directClient.$disconnect(),
    ]);
  }
}

main().catch((error) => {
  const message =
    error instanceof DatabaseTargetVerificationError
      ? error.message
      : "Database target verification failed";
  console.error(`Database target verification failed: ${message}`);
  process.exitCode = 1;
});
