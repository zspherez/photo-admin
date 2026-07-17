import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import {
  cleanupReleaseRuntimeVerification,
  prepareReleaseRuntimeVerification,
  ReleaseRuntimeVerificationError,
} from "@/lib/releaseRuntimeVerification";
import { PrismaDatabaseTargetConnection } from "@/lib/prismaDatabaseTargetConnection";

function requiredDatabaseUrl(name: "DATABASE_URL" | "DIRECT_URL"): string {
  const rawValue = process.env[name];
  if (!rawValue || rawValue !== rawValue.trim()) {
    throw new ReleaseRuntimeVerificationError(`${name} is required`);
  }
  const value = rawValue;
  try {
    const parsed = new URL(value);
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      !parsed.hostname ||
      !parsed.username ||
      parsed.pathname === "/"
    ) {
      throw new Error("invalid");
    }
  } catch {
    throw new ReleaseRuntimeVerificationError(
      `${name} must be a valid PostgreSQL URL`
    );
  }
  return value;
}

function parseArguments():
  | { action: "create"; releaseSha: string }
  | { action: "cleanup"; nonce: string } {
  const [action, argument, ...rest] = process.argv.slice(2);
  if (rest.length > 0) {
    throw new ReleaseRuntimeVerificationError("Unexpected arguments");
  }
  if (action === "create" && argument) {
    return { action, releaseSha: argument };
  }
  if (action === "cleanup" && !argument) {
    return {
      action,
      nonce:
        process.env.RELEASE_RUNTIME_VERIFICATION_NONCE?.trim() ?? "",
    };
  }
  throw new ReleaseRuntimeVerificationError(
    "Use create <release-sha> or cleanup"
  );
}

async function main(): Promise<void> {
  const command = parseArguments();
  const runtimeClient = new PrismaClient({
    datasourceUrl: requiredDatabaseUrl("DATABASE_URL"),
    errorFormat: "minimal",
  });
  const directClient = new PrismaClient({
    datasourceUrl: requiredDatabaseUrl("DIRECT_URL"),
    errorFormat: "minimal",
  });
  const runtime = new PrismaDatabaseTargetConnection(runtimeClient);
  const direct = new PrismaDatabaseTargetConnection(directClient);

  try {
    await Promise.all([runtimeClient.$connect(), directClient.$connect()]);
    if (command.action === "create") {
      const marker = await prepareReleaseRuntimeVerification(runtime, direct, {
        releaseSha: command.releaseSha,
      });
      process.stdout.write(marker.nonce);
      return;
    }

    await cleanupReleaseRuntimeVerification(runtime, direct, command.nonce);
    console.log(
      JSON.stringify({ event: "release_runtime_verification_cleaned" })
    );
  } catch (error) {
    if (error instanceof ReleaseRuntimeVerificationError) throw error;
    throw new ReleaseRuntimeVerificationError(
      "Release runtime verification database operation could not complete"
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
    error instanceof ReleaseRuntimeVerificationError
      ? error.message
      : "Release runtime verification failed";
  console.error(`Release runtime verification failed: ${message}`);
  process.exitCode = 1;
});
