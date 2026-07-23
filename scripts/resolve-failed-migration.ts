import "dotenv/config";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Prisma, PrismaClient } from "@prisma/client";

interface MigrationRow {
  migrationName: string;
  checksum: string;
}

function requiredMigrationName(value: string | undefined): string {
  const migrationName = value?.trim() ?? "";
  if (!/^[0-9]{14}_[a-z0-9_]+$/.test(migrationName)) {
    throw new Error("A valid migration name is required");
  }
  if (
    !existsSync(resolve("prisma/migrations", migrationName, "migration.sql"))
  ) {
    throw new Error("The requested migration is not present in this checkout");
  }
  return migrationName;
}

function requiredChecksum(value: string | undefined): string {
  const checksum = value?.trim().toLowerCase() ?? "";
  if (!/^[0-9a-f]{64}$/.test(checksum)) {
    throw new Error("A valid expected failed checksum is required");
  }
  return checksum;
}

async function main(): Promise<void> {
  const migrationName = requiredMigrationName(process.argv[2]);
  const expectedFailedChecksum = requiredChecksum(process.argv[3]);
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const directUrl = process.env.DIRECT_URL?.trim();
  if (!databaseUrl || !directUrl) {
    throw new Error("DATABASE_URL and DIRECT_URL are required");
  }
  const runtimeClient = new PrismaClient({
    datasourceUrl: databaseUrl,
    errorFormat: "minimal",
  });
  const directClient = new PrismaClient({
    datasourceUrl: directUrl,
    errorFormat: "minimal",
  });
  const nonceKey = `release_migration_recovery:${randomUUID()}`;
  const nonceValue = randomUUID();
  try {
    await Promise.all([runtimeClient.$connect(), directClient.$connect()]);
    await runtimeClient.$executeRaw(Prisma.sql`
      INSERT INTO "Setting" ("key", "value", "updatedAt")
      VALUES (${nonceKey}, ${nonceValue}, CURRENT_TIMESTAMP)
    `);
    const nonceRows = await directClient.$queryRaw<Array<{ value: string }>>(
      Prisma.sql`
        SELECT "value"
        FROM "Setting"
        WHERE "key" = ${nonceKey}
      `,
    );
    if (nonceRows[0]?.value !== nonceValue) {
      throw new Error(
        "DATABASE_URL and DIRECT_URL do not target the same database",
      );
    }

    const rows = await directClient.$queryRaw<MigrationRow[]>(Prisma.sql`
      SELECT
        "migration_name" AS "migrationName",
        "checksum"
      FROM "_prisma_migrations"
      WHERE "finished_at" IS NULL
        AND "rolled_back_at" IS NULL
      ORDER BY "started_at" DESC, "id" DESC
    `);
    if (rows.length === 0) {
      console.log(
        JSON.stringify({
          event: "failed_migration_resolution_not_required",
          migrationName,
        }),
      );
      return;
    }
    if (rows.length !== 1) {
      throw new Error(
        `Expected one unresolved migration record, found ${rows.length}`,
      );
    }
    const [failed] = rows;
    if (
      failed.migrationName !== migrationName ||
      failed.checksum.toLowerCase() !== expectedFailedChecksum
    ) {
      throw new Error(
        "The unresolved migration does not match the authorized recovery target",
      );
    }
  } finally {
    await runtimeClient
      .$executeRaw(Prisma.sql`
        DELETE FROM "Setting"
        WHERE "key" = ${nonceKey}
          AND "value" = ${nonceValue}
      `)
      .catch(() => {});
    await Promise.allSettled([
      runtimeClient.$disconnect(),
      directClient.$disconnect(),
    ]);
  }

  const resolved = spawnSync(
    "npx",
    [
      "--no-install",
      "prisma",
      "migrate",
      "resolve",
      "--rolled-back",
      migrationName,
    ],
    {
      env: process.env,
      stdio: "inherit",
    },
  );
  if (resolved.error) throw resolved.error;
  if (resolved.status !== 0) {
    throw new Error(
      `Prisma migrate resolve exited with status ${resolved.status ?? "unknown"}`,
    );
  }
  console.log(
    JSON.stringify({
      event: "failed_migration_marked_rolled_back",
      migrationName,
    }),
  );
}

main().catch((error) => {
  console.error(
    error instanceof Error
      ? error.message
      : "Failed migration recovery could not complete",
  );
  process.exitCode = 1;
});
