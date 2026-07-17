import "dotenv/config";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  DatabaseTargetVerificationError,
  readExpectedMigrationHistory,
  verifyDatabaseTargetConnections,
} from "@/lib/databaseTargetVerification";
import { PrismaDatabaseTargetConnection } from "@/lib/prismaDatabaseTargetConnection";

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
