import "dotenv/config";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { db } from "@/lib/db";
import {
  importTrajectoryManifest,
  TrajectoryImportError,
  type TrajectoryImportOptions,
  type TrajectoryImportSummary,
} from "@/lib/trajectoryImport";
import {
  TRAJECTORY_RAW_SIZE_LIMIT_BYTES,
  TrajectoryContractError,
  TrajectoryDigestMismatchError,
} from "@/lib/trajectoryContract";
import {
  IntegrationSyncLeaseLostError,
  OperationDeadlineExceededError,
} from "@/lib/integrationUtils";

export interface TrajectoryImportCliArguments {
  manifestPath: string;
  dryRun: boolean;
  digestValue: string | null;
  digestPath: string | null;
  json: boolean;
  maximumUnmappedRate: number | undefined;
}

interface TrajectoryImportCliDependencies {
  readFile(path: string): Promise<Buffer>;
  stat(path: string): Promise<{ size: number }>;
  importManifest(
    raw: Buffer,
    options: TrajectoryImportOptions,
  ): Promise<TrajectoryImportSummary>;
  stdout(value: string): void;
  stderr(value: string): void;
}

function argumentValue(args: readonly string[], index: number): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new TrajectoryContractError(`Missing value for ${args[index]}`);
  }
  return value;
}

export function parseTrajectoryImportCliArguments(
  args: readonly string[],
): TrajectoryImportCliArguments {
  let manifestPath: string | null = null;
  let digestValue: string | null = null;
  let digestPath: string | null = null;
  let maximumUnmappedRate: number | undefined;
  let dryRun = false;
  let json = false;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--manifest") {
      if (manifestPath) {
        throw new TrajectoryContractError("--manifest may only be provided once");
      }
      manifestPath = argumentValue(args, index);
      index++;
    } else if (argument === "--digest") {
      if (digestValue || digestPath) {
        throw new TrajectoryContractError(
          "Provide only one of --digest or --digest-file",
        );
      }
      digestValue = argumentValue(args, index);
      index++;
    } else if (argument === "--digest-file") {
      if (digestValue || digestPath) {
        throw new TrajectoryContractError(
          "Provide only one of --digest or --digest-file",
        );
      }
      digestPath = argumentValue(args, index);
      index++;
    } else if (argument === "--max-unmapped-rate") {
      const value = Number(argumentValue(args, index));
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new TrajectoryContractError(
          "--max-unmapped-rate must be between 0 and 1",
        );
      }
      maximumUnmappedRate = value;
      index++;
    } else if (argument === "--dry-run") {
      dryRun = true;
    } else if (argument === "--json") {
      json = true;
    } else {
      throw new TrajectoryContractError(`Unknown argument: ${argument}`);
    }
  }

  if (!manifestPath) {
    throw new TrajectoryContractError("--manifest <path> is required");
  }
  return {
    manifestPath,
    dryRun,
    digestValue,
    digestPath,
    json,
    maximumUnmappedRate,
  };
}

function humanSummary(summary: TrajectoryImportSummary): string {
  const heading =
    summary.status === "planned"
      ? "Trajectory import dry-run complete"
      : summary.status === "imported"
        ? "Trajectory run imported"
        : summary.status === "noop"
          ? "Trajectory run already imported; no changes made"
          : "Trajectory import lease is busy";
  return [
    heading,
    `  producer run: ${summary.producerRunId}`,
    `  manifest SHA-256: ${summary.artifactSha256}`,
    `  bytes: ${summary.artifactByteLength}`,
    `  recommendations: ${summary.mappedRecommendationCount}/${summary.recommendationCount}`,
    `  mapping validation: ${summary.mappingValidation}`,
    `  import issues: ${summary.issueCount}`,
    `  unresolved non-suggested rate: ${(summary.unresolvedNonSuggestedRate * 100).toFixed(2)}%`,
    `  model opinion valid until: ${summary.validUntil}`,
    `  superseded ready runs: ${summary.previousReadyRunsSuperseded}`,
  ].join("\n");
}

function safeError(error: unknown): { code: string; message: string } {
  if (
    error instanceof TrajectoryContractError ||
    error instanceof TrajectoryDigestMismatchError ||
    error instanceof TrajectoryImportError ||
    error instanceof IntegrationSyncLeaseLostError ||
    error instanceof OperationDeadlineExceededError
  ) {
    return {
      code:
        "code" in error && typeof error.code === "string"
          ? error.code
          : "trajectory_import_failed",
      message: error.message,
    };
  }
  return {
    code: "trajectory_import_failed",
    message: "Trajectory import failed without changing the active run",
  };
}

export async function runTrajectoryImportCli(
  args: readonly string[],
  dependencies: TrajectoryImportCliDependencies = {
    readFile,
    stat,
    importManifest: importTrajectoryManifest,
    stdout: (value) => console.log(value),
    stderr: (value) => console.error(value),
  },
): Promise<number> {
  let json = args.includes("--json");
  try {
    const parsed = parseTrajectoryImportCliArguments(args);
    json = parsed.json;
    const manifestPath = resolve(parsed.manifestPath);
    const manifestStat = await dependencies.stat(manifestPath);
    if (manifestStat.size > TRAJECTORY_RAW_SIZE_LIMIT_BYTES) {
      throw new TrajectoryContractError(
        `Trajectory manifest exceeds ${TRAJECTORY_RAW_SIZE_LIMIT_BYTES} bytes`,
      );
    }
    const raw = await dependencies.readFile(manifestPath);
    const expectedDigest = parsed.digestPath
      ? (await dependencies.readFile(resolve(parsed.digestPath))).toString(
          "utf8",
        )
      : parsed.digestValue;
    const summary = await dependencies.importManifest(raw, {
      dryRun: parsed.dryRun,
      expectedDigest,
      maximumUnmappedRate: parsed.maximumUnmappedRate,
    });
    dependencies.stdout(
      parsed.json ? JSON.stringify(summary) : humanSummary(summary),
    );
    return summary.status === "busy" ? 2 : 0;
  } catch (error) {
    const safe = safeError(error);
    dependencies.stderr(
      json
        ? JSON.stringify({ event: "trajectory_import_failed", ...safe })
        : `Trajectory import failed (${safe.code}): ${safe.message}`,
    );
    return 1;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (
  invokedPath &&
  pathToFileURL(invokedPath).href === import.meta.url
) {
  runTrajectoryImportCli(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .finally(async () => {
      await db.$disconnect();
    });
}
