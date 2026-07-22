import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createTrajectoryHmacSignature,
  TRAJECTORY_INGEST_PATH,
  trajectoryHmacCanonicalMessage,
  type TrajectoryIngestMode,
} from "@/lib/trajectoryIngest";
import { TRAJECTORY_RAW_SIZE_LIMIT_BYTES } from "@/lib/trajectoryContract";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export interface TrajectoryPromotionCliArguments {
  baseUrl: string;
  manifestPath: string;
  digestPath: string;
  mode: TrajectoryIngestMode;
  receiptPath: string;
  idempotencyKey: string | null;
}

interface TrajectoryPromotionDependencies {
  environment: Readonly<Record<string, string | undefined>>;
  fetch: typeof fetch;
  now(): Date;
  randomUUID(): string;
  readFile(path: string): Promise<Buffer>;
  stat(path: string): Promise<{ size: number }>;
  writeReceipt(path: string, receipt: string): Promise<void>;
  stdout(value: string): void;
  stderr(value: string): void;
}

interface TrajectoryManifestIdentity {
  producer_run_id: string;
}

function argumentValue(args: readonly string[], index: number): string {
  const value = args[index + 1]?.trim();
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${args[index]}`);
  }
  return value;
}

export function parseTrajectoryPromotionCliArguments(
  args: readonly string[],
): TrajectoryPromotionCliArguments {
  let baseUrl: string | null = null;
  let manifestPath: string | null = null;
  let digestPath: string | null = null;
  let receiptPath: string | null = null;
  let idempotencyKey: string | null = null;
  let mode: TrajectoryIngestMode | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--base-url") {
      baseUrl = argumentValue(args, index);
      index += 1;
    } else if (argument === "--manifest") {
      manifestPath = argumentValue(args, index);
      index += 1;
    } else if (argument === "--digest-file") {
      digestPath = argumentValue(args, index);
      index += 1;
    } else if (argument === "--receipt-file") {
      receiptPath = argumentValue(args, index);
      index += 1;
    } else if (argument === "--idempotency-key") {
      idempotencyKey = argumentValue(args, index);
      index += 1;
    } else if (argument === "--dry-run" || argument === "--apply") {
      if (mode) throw new Error("Provide only one of --dry-run or --apply");
      mode = argument === "--dry-run" ? "dry-run" : "apply";
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!baseUrl) throw new Error("--base-url <https-origin> is required");
  if (!manifestPath) throw new Error("--manifest <path> is required");
  if (!digestPath) throw new Error("--digest-file <path> is required");
  if (!receiptPath) throw new Error("--receipt-file <path> is required");
  if (!mode) throw new Error("Provide exactly one of --dry-run or --apply");
  if (idempotencyKey && !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw new Error("--idempotency-key must be 8-128 safe ASCII characters");
  }

  const parsedBaseUrl = new URL(baseUrl);
  if (
    parsedBaseUrl.protocol !== "https:" ||
    parsedBaseUrl.pathname !== "/" ||
    parsedBaseUrl.search ||
    parsedBaseUrl.hash ||
    parsedBaseUrl.username ||
    parsedBaseUrl.password
  ) {
    throw new Error("--base-url must be an HTTPS origin without credentials or a path");
  }

  return {
    baseUrl: parsedBaseUrl.origin,
    manifestPath: resolve(manifestPath),
    digestPath: resolve(digestPath),
    mode,
    receiptPath: resolve(receiptPath),
    idempotencyKey,
  };
}

function parseDigest(raw: Buffer): string {
  const digest = raw.toString("utf8").trim().split(/\s+/)[0] ?? "";
  if (!SHA256_PATTERN.test(digest)) {
    throw new Error("Digest file must begin with a lowercase SHA-256 value");
  }
  return digest;
}

function parseManifestIdentity(raw: Buffer): TrajectoryManifestIdentity {
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("Trajectory manifest is not valid JSON");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as Partial<TrajectoryManifestIdentity>).producer_run_id !==
      "string" ||
    !(value as Partial<TrajectoryManifestIdentity>).producer_run_id?.trim()
  ) {
    throw new Error("Trajectory manifest is missing producer_run_id");
  }
  return value as TrajectoryManifestIdentity;
}

function safeResponseBody(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Trajectory ingest returned an invalid response");
  }
  return value as Record<string, unknown>;
}

async function defaultWriteReceipt(
  path: string,
  receipt: string,
): Promise<void> {
  await writeFile(path, `${receipt}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

export async function runTrajectoryPromotionCli(
  args: readonly string[],
  dependencies: TrajectoryPromotionDependencies = {
    environment: process.env,
    fetch,
    now: () => new Date(),
    randomUUID,
    readFile,
    stat,
    writeReceipt: defaultWriteReceipt,
    stdout: (value) => console.log(value),
    stderr: (value) => console.error(value),
  },
): Promise<number> {
  try {
    const parsed = parseTrajectoryPromotionCliArguments(args);
    const secret = dependencies.environment.TRAJECTORY_INGEST_HMAC_SECRET;
    if (!secret || Buffer.byteLength(secret) < 32) {
      throw new Error(
        "TRAJECTORY_INGEST_HMAC_SECRET must contain a dedicated secret of at least 32 bytes",
      );
    }

    const manifestStat = await dependencies.stat(parsed.manifestPath);
    if (
      manifestStat.size < 1 ||
      manifestStat.size > TRAJECTORY_RAW_SIZE_LIMIT_BYTES
    ) {
      throw new Error(
        `Trajectory manifest must be 1-${TRAJECTORY_RAW_SIZE_LIMIT_BYTES} bytes`,
      );
    }
    const [raw, digestRaw] = await Promise.all([
      dependencies.readFile(parsed.manifestPath),
      dependencies.readFile(parsed.digestPath),
    ]);
    if (raw.length !== manifestStat.size) {
      throw new Error("Trajectory manifest changed while it was being read");
    }
    const expectedDigest = parseDigest(digestRaw);
    const actualDigest = createHash("sha256").update(raw).digest("hex");
    if (actualDigest !== expectedDigest) {
      throw new Error("Trajectory manifest does not match its digest file");
    }
    const identity = parseManifestIdentity(raw);
    const idempotencyKey =
      parsed.idempotencyKey ??
      `trajectory-${parsed.mode}-${dependencies.randomUUID()}`;
    const producedAt = dependencies.now().toISOString();
    const applyConfirmation =
      parsed.mode === "apply"
        ? `apply:${identity.producer_run_id}:${expectedDigest}`
        : "";
    const dryRunReceipt =
      parsed.mode === "apply"
        ? (await dependencies.readFile(parsed.receiptPath))
            .toString("utf8")
            .trim()
        : "";
    if (parsed.mode === "apply" && !dryRunReceipt) {
      throw new Error("Apply requires a non-empty dry-run receipt file");
    }

    const canonical = trajectoryHmacCanonicalMessage({
      idempotencyKey,
      producedAt,
      artifactSha256: expectedDigest,
      mode: parsed.mode,
      contentLength: raw.length,
      applyConfirmation,
      dryRunReceipt,
    });
    const headers = new Headers({
      "Content-Type": "application/json",
      "Content-Length": String(raw.length),
      "Idempotency-Key": idempotencyKey,
      "X-Produced-At": producedAt,
      "X-Content-SHA256": expectedDigest,
      "X-Trajectory-Mode": parsed.mode,
      "X-Signature": createTrajectoryHmacSignature(secret, canonical),
    });
    if (applyConfirmation) {
      headers.set("X-Trajectory-Apply-Confirmation", applyConfirmation);
    }
    if (dryRunReceipt) {
      headers.set("X-Trajectory-Dry-Run-Receipt", dryRunReceipt);
    }

    const response = await dependencies.fetch(
      `${parsed.baseUrl}${TRAJECTORY_INGEST_PATH}`,
      {
        method: "POST",
        headers,
        body: Uint8Array.from(raw),
        signal: AbortSignal.timeout(300_000),
      },
    );
    const body = safeResponseBody(await response.json());
    if (!response.ok) {
      const error =
        typeof body.error === "object" &&
        body.error !== null &&
        !Array.isArray(body.error)
          ? (body.error as Record<string, unknown>)
          : {};
      const code =
        typeof error.code === "string" ? error.code : "trajectory_ingest_failed";
      const message =
        typeof error.message === "string"
          ? error.message
          : `Trajectory ingest failed with HTTP ${response.status}`;
      throw new Error(`${code}: ${message}`);
    }

    const receipt =
      typeof body.dryRunReceipt === "string" ? body.dryRunReceipt : null;
    if (parsed.mode === "dry-run") {
      if (!receipt) throw new Error("Dry-run response did not include a receipt");
      await dependencies.writeReceipt(parsed.receiptPath, receipt);
    }
    const safeBody = { ...body };
    delete safeBody.dryRunReceipt;
    dependencies.stdout(
      JSON.stringify({
        ...safeBody,
        idempotencyKey,
        ...(receipt ? { receiptFile: parsed.receiptPath } : {}),
      }),
    );
    return 0;
  } catch (error) {
    dependencies.stderr(
      JSON.stringify({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Trajectory promotion failed",
      }),
    );
    return 1;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  runTrajectoryPromotionCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
