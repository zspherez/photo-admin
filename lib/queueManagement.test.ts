import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import {
  deactivatePendingAndClaimedResearchJobs,
  rejectUnresolvedFlaggedAuditDecisions,
  type QueueManagementTransactionRunner,
} from "./queueManagement";

function runWithTransaction(tx: unknown): QueueManagementTransactionRunner {
  return async (work) => work(tx as Prisma.TransactionClient);
}

function sqlText(value: unknown): string {
  const strings = (value as { strings?: readonly string[] }).strings;
  return strings ? strings.join("?") : String(value);
}

test("bulk audit rejection is atomic and preserves contacts and evidence", async () => {
  let query = "";
  const result = await rejectUnresolvedFlaggedAuditDecisions(
    new Date("2026-07-22T04:00:00.000Z"),
    runWithTransaction({
      $queryRaw: async (value: unknown) => {
        query = sqlText(value);
        return [{ rejected: 6, changed: 3, stale: 2, ambiguous: 1 }];
      },
    }),
  );

  assert.deepEqual(result, {
    rejected: 6,
    changed: 3,
    stale: 2,
    ambiguous: 1,
  });
  assert.match(query, /FOR UPDATE OF job/);
  assert.match(query, /job\."resolution" IS NULL/);
  assert.match(query, /"resolution" = 'rejected'/);
  assert.match(query, /"resolvedEmail" = job\."snapshotEmail"/);
  assert.match(query, /"resolutionClaimToken" = NULL/);
  assert.doesNotMatch(query, /\bDELETE\b/i);
  assert.doesNotMatch(query, /UPDATE "Contact" /);
  assert.doesNotMatch(query, /UPDATE "ContactAuditAlternative"/);
});

test("research queue deactivation releases pending and claimed ownership", async () => {
  let query = "";
  const result = await deactivatePendingAndClaimedResearchJobs(
    new Date("2026-07-22T04:00:00.000Z"),
    runWithTransaction({
      $queryRaw: async (value: unknown) => {
        query = sqlText(value);
        return [{ deactivated: 9, pending: 7, claimed: 2 }];
      },
    }),
  );

  assert.deepEqual(result, { deactivated: 9, pending: 7, claimed: 2 });
  assert.match(query, /job\."status" IN \('pending', 'claimed'\)/);
  assert.match(query, /FOR UPDATE/);
  assert.match(query, /"status" = 'inactive'/);
  assert.match(query, /"claimToken" = NULL/);
  assert.match(query, /"claimedAt" = NULL/);
  assert.match(query, /"claimExpiresAt" = NULL/);
  assert.doesNotMatch(query, /\bDELETE\b/i);
});

test("queue management retries serializable races and never deletes records", () => {
  const source = readFileSync(
    new URL("./queueManagement.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /isolationLevel: Prisma\.TransactionIsolationLevel\.Serializable/,
  );
  assert.match(source, /code === "P2034"/);
  assert.doesNotMatch(source, /\.delete(?:Many)?\(/);
  assert.doesNotMatch(source, /\bDELETE FROM\b/i);
});
