import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createTrajectoryHmacSignature,
  trajectoryHmacCanonicalMessage,
} from "../lib/trajectoryIngest";
import {
  parseTrajectoryPromotionCliArguments,
  runTrajectoryPromotionCli,
} from "./promote-trajectory-run";

const secret = "s".repeat(48);
const manifest = Buffer.from(
  JSON.stringify({ producer_run_id: "producer-run-1" }),
);
const digest = createHash("sha256").update(manifest).digest("hex");
const baseArgs = [
  "--base-url",
  "https://photo-admin.example",
  "--manifest",
  "manifest.json",
  "--digest-file",
  "manifest.sha256",
  "--receipt-file",
  "receipt.txt",
] as const;

test("promotion CLI requires one mode and a safe HTTPS origin", () => {
  assert.throws(
    () => parseTrajectoryPromotionCliArguments(baseArgs),
    /exactly one/,
  );
  assert.throws(
    () =>
      parseTrajectoryPromotionCliArguments([
        ...baseArgs,
        "--dry-run",
        "--apply",
      ]),
    /only one/,
  );
  assert.throws(
    () =>
      parseTrajectoryPromotionCliArguments([
        ...baseArgs.slice(0, 1),
        "http://photo-admin.example/path",
        ...baseArgs.slice(2),
        "--dry-run",
      ]),
    /HTTPS origin/,
  );
});

test("dry-run sends exact signed headers and stores but does not print receipt", async () => {
  const outputs: string[] = [];
  const errors: string[] = [];
  const receipts: Array<{ path: string; value: string }> = [];
  let request: Request | null = null;
  const producedAt = new Date("2026-07-22T02:00:00.000Z");

  const exitCode = await runTrajectoryPromotionCli(
    [...baseArgs, "--dry-run", "--idempotency-key", "dry-run-key-001"],
    {
      environment: { TRAJECTORY_INGEST_HMAC_SECRET: secret },
      fetch: async (input, init) => {
        request = new Request(input, init);
        return Response.json({
          ok: true,
          event: "trajectory_ingest_dry_run_complete",
          summary: { status: "planned" },
          dryRunReceipt: "signed.receipt",
        });
      },
      now: () => producedAt,
      randomUUID: () => "unused",
      stat: async () => ({ size: manifest.length }),
      readFile: async (path) =>
        path.endsWith(".sha256")
          ? Buffer.from(`${digest}  manifest.json\n`)
          : manifest,
      writeReceipt: async (path, value) => {
        receipts.push({ path, value });
      },
      stdout: (value) => outputs.push(value),
      stderr: (value) => errors.push(value),
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(errors.length, 0);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].value, "signed.receipt");
  assert.doesNotMatch(outputs[0], /signed\.receipt/);
  assert.equal(JSON.parse(outputs[0]).idempotencyKey, "dry-run-key-001");
  const capturedRequest = request as Request | null;
  assert.ok(capturedRequest);
  const headers = capturedRequest.headers;
  assert.equal(headers.get("x-produced-at"), producedAt.toISOString());
  assert.equal(headers.get("x-content-sha256"), digest);
  assert.equal(headers.get("x-trajectory-mode"), "dry-run");
  assert.equal(headers.get("content-length"), String(manifest.length));
  const canonical = trajectoryHmacCanonicalMessage({
    idempotencyKey: "dry-run-key-001",
    producedAt: producedAt.toISOString(),
    artifactSha256: digest,
    mode: "dry-run",
    contentLength: manifest.length,
    applyConfirmation: "",
    dryRunReceipt: "",
  });
  assert.equal(
    headers.get("x-signature"),
    createTrajectoryHmacSignature(secret, canonical),
  );
});

test("apply signs the exact confirmation and stored receipt", async () => {
  const errors: string[] = [];
  let request: Request | null = null;
  const producedAt = new Date("2026-07-22T02:05:00.000Z");

  const exitCode = await runTrajectoryPromotionCli(
    [...baseArgs, "--apply", "--idempotency-key", "apply-key-001"],
    {
      environment: { TRAJECTORY_INGEST_HMAC_SECRET: secret },
      fetch: async (input, init) => {
        request = new Request(input, init);
        return Response.json(
          {
            ok: true,
            event: "trajectory_ingest_applied",
            summary: { status: "imported" },
          },
          { status: 201 },
        );
      },
      now: () => producedAt,
      randomUUID: () => "unused",
      stat: async () => ({ size: manifest.length }),
      readFile: async (path) => {
        if (path.endsWith(".sha256")) return Buffer.from(`${digest}\n`);
        if (path.endsWith("receipt.txt")) return Buffer.from("signed.receipt\n");
        return manifest;
      },
      writeReceipt: async () => {
        throw new Error("apply must not write a receipt");
      },
      stdout: () => undefined,
      stderr: (value) => errors.push(value),
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(errors.length, 0);
  const capturedRequest = request as Request | null;
  assert.ok(capturedRequest);
  const confirmation = `apply:producer-run-1:${digest}`;
  assert.equal(
    capturedRequest.headers.get("x-trajectory-apply-confirmation"),
    confirmation,
  );
  assert.equal(
    capturedRequest.headers.get("x-trajectory-dry-run-receipt"),
    "signed.receipt",
  );
  const canonical = trajectoryHmacCanonicalMessage({
    idempotencyKey: "apply-key-001",
    producedAt: producedAt.toISOString(),
    artifactSha256: digest,
    mode: "apply",
    contentLength: manifest.length,
    applyConfirmation: confirmation,
    dryRunReceipt: "signed.receipt",
  });
  assert.equal(
    capturedRequest.headers.get("x-signature"),
    createTrajectoryHmacSignature(secret, canonical),
  );
});

test("promotion rejects a local digest mismatch before contacting production", async () => {
  let calls = 0;
  const errors: string[] = [];
  const exitCode = await runTrajectoryPromotionCli(
    [...baseArgs, "--dry-run"],
    {
      environment: { TRAJECTORY_INGEST_HMAC_SECRET: secret },
      fetch: async () => {
        calls += 1;
        throw new Error("must not fetch");
      },
      now: () => new Date(),
      randomUUID: () => "unused",
      stat: async () => ({ size: manifest.length }),
      readFile: async (path) =>
        path.endsWith(".sha256")
          ? Buffer.from(`${"0".repeat(64)}\n`)
          : manifest,
      writeReceipt: async () => undefined,
      stdout: () => undefined,
      stderr: (value) => errors.push(value),
    },
  );
  assert.equal(exitCode, 1);
  assert.equal(calls, 0);
  assert.match(errors[0], /does not match/);
});
