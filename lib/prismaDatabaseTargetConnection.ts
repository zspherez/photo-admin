import { Prisma, PrismaClient } from "@prisma/client";
import type {
  DatabaseTargetConnection,
  MigrationHistoryEntry,
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

export class PrismaDatabaseTargetConnection
  implements DatabaseTargetConnection
{
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

  async deleteVerificationNonce(
    key: string,
    expectedValue?: string
  ): Promise<boolean> {
    const condition =
      expectedValue === undefined
        ? Prisma.sql`"key" = ${key}`
        : Prisma.sql`"key" = ${key} AND "value" = ${expectedValue}`;
    return (
      (await this.client.$executeRaw(
        Prisma.sql`
          DELETE FROM "Setting"
          WHERE ${condition}
        `
      )) > 0
    );
  }
}
