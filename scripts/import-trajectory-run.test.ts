import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTrajectoryImportCliArguments,
  runTrajectoryImportCli,
} from "./import-trajectory-run";
import { TRAJECTORY_RAW_SIZE_LIMIT_BYTES } from "../lib/trajectoryContract";

test("CLI requires an explicit manifest and rejects unknown or conflicting flags", () => {
  assert.throws(
    () => parseTrajectoryImportCliArguments(["--dry-run"]),
    /--manifest/,
  );
  assert.throws(
    () =>
      parseTrajectoryImportCliArguments([
        "--manifest",
        "manifest.json",
        "--unknown",
      ]),
    /Unknown argument/,
  );
  assert.throws(
    () =>
      parseTrajectoryImportCliArguments([
        "--manifest",
        "manifest.json",
        "--digest",
        "a".repeat(64),
        "--digest-file",
        "manifest.sha256",
      ]),
    /only one/,
  );
});

test("CLI dry-run supports producer sha256 files and performs no write mode", async () => {
  const outputs: string[] = [];
  const errors: string[] = [];
  const importOptions: Array<Record<string, unknown>> = [];
  const manifest = Buffer.from("{}");
  const digest = Buffer.from(`${"a".repeat(64)}\n`);

  const exitCode = await runTrajectoryImportCli(
    [
      "--manifest",
      "manifest.json",
      "--digest-file",
      "manifest.sha256",
      "--dry-run",
      "--json",
    ],
    {
      stat: async () => ({ size: manifest.length }),
      readFile: async (path) =>
        path.endsWith(".sha256") ? digest : manifest,
      importManifest: async (_raw, options) => {
        importOptions.push(options as Record<string, unknown>);
        return {
          mode: "dry-run",
          status: "planned",
          producerRunId: "run",
          artifactSha256: "b".repeat(64),
          artifactByteLength: 2,
          validUntil: "2026-07-23T00:00:00.000Z",
          recommendationCount: 1,
          mappedRecommendationCount: 1,
          issueCount: 0,
          unresolvedNonSuggestedRate: 0,
          previousReadyRunsSuperseded: 0,
          runId: null,
        };
      },
      stdout: (value) => outputs.push(value),
      stderr: (value) => errors.push(value),
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(importOptions.length, 1);
  assert.equal(importOptions[0].dryRun, true);
  assert.equal(importOptions[0].expectedDigest, digest.toString("utf8"));
  assert.equal(errors.length, 0);
  assert.equal(JSON.parse(outputs[0]).status, "planned");
});

test("CLI checks file size before reading and redacts unexpected errors", async () => {
  let reads = 0;
  const errors: string[] = [];
  const oversized = await runTrajectoryImportCli(
    ["--manifest", "oversized.json"],
    {
      stat: async () => ({ size: TRAJECTORY_RAW_SIZE_LIMIT_BYTES + 1 }),
      readFile: async () => {
        reads++;
        return Buffer.alloc(0);
      },
      importManifest: async () => {
        throw new Error("should not import");
      },
      stdout: () => undefined,
      stderr: (value) => errors.push(value),
    },
  );
  assert.equal(oversized, 1);
  assert.equal(reads, 0);
  assert.match(errors[0], /exceeds/);

  errors.length = 0;
  const unexpected = await runTrajectoryImportCli(
    ["--manifest", "manifest.json"],
    {
      stat: async () => ({ size: 2 }),
      readFile: async () => Buffer.from("{}"),
      importManifest: async () => {
        throw new Error("postgres://user:secret@private-host/db");
      },
      stdout: () => undefined,
      stderr: (value) => errors.push(value),
    },
  );
  assert.equal(unexpected, 1);
  assert.doesNotMatch(errors[0], /secret|private-host|postgres/i);
  assert.match(errors[0], /without changing the active run/);
});
