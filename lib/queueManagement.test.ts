import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import { db } from "./db";
import { resolveContactAuditJob } from "./contactAudit";
import { CONTACT_AUDIT_RESOLUTION_CLAIM_TTL_MS } from "./contactAuditResolutionPolicy";
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

function sqlValues(value: unknown): readonly unknown[] {
  return (value as { values?: readonly unknown[] }).values ?? [];
}

function auditTarget(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const contact = {
    id: "contact-1",
    artistId: "artist-1",
    state: "active",
    email: "manager@example.com",
    phone: "+1 212 555 0100",
    directOutreachNote: "@manager",
    name: "Manager Name",
    role: "management",
    source: "sheet",
    notes: "Primary manager",
    isFullTeam: true,
    sourceKey: "sheet/tab/row/slot",
    updatedAt: new Date("2026-07-22T03:00:00.000Z"),
    artist: { name: "Artist" },
  };
  return {
    id: "job-1",
    status: "complete",
    verifiedAt: new Date("2026-07-22T03:30:00.000Z"),
    finding: "changed",
    resolution: null,
    resolutionClaimToken: null,
    resolutionClaimedAt: null,
    snapshotArtistName: "Artist",
    snapshotEmail: contact.email,
    snapshotPhone: contact.phone,
    snapshotDirectOutreachNote: contact.directOutreachNote,
    snapshotName: contact.name,
    snapshotRole: contact.role,
    snapshotSource: contact.source,
    snapshotNotes: contact.notes,
    snapshotIsFullTeam: contact.isFullTeam,
    contactId: contact.id,
    artistId: contact.artistId,
    contact,
    ...overrides,
  };
}

test("bulk audit rejection reclaims only stale claims and reports freshness skips", async () => {
  const now = new Date("2026-07-22T04:00:00.000Z");
  const jobs = [
    auditTarget({ id: "eligible", finding: "changed" }),
    auditTarget({
      id: "stale-claim",
      finding: "stale",
      resolutionClaimToken: "stale-token",
      resolutionClaimedAt: new Date(
        now.getTime() - CONTACT_AUDIT_RESOLUTION_CLAIM_TTL_MS,
      ),
    }),
    auditTarget({
      id: "active-claim",
      finding: "ambiguous",
      resolutionClaimToken: "active-token",
      resolutionClaimedAt: new Date(now.getTime() - 60_000),
    }),
    auditTarget({
      id: "active-claim-without-timestamp",
      resolutionClaimToken: "active-token-without-timestamp",
      resolutionClaimedAt: null,
    }),
    auditTarget({
      id: "contact-changed",
      contact: {
        ...(auditTarget().contact as Record<string, unknown>),
        notes: "Changed after audit",
      },
    }),
    auditTarget({ id: "contact-missing", contact: null }),
  ];
  const queries: string[] = [];
  const result = await rejectUnresolvedFlaggedAuditDecisions(
    now,
    runWithTransaction({
      contactAuditJob: {
        findMany: async () => jobs,
      },
      $queryRaw: async (value: unknown) => {
        const query = sqlText(value);
        queries.push(query);
        if (query.includes('UPDATE "ContactAuditJob"')) {
          const values = sqlValues(value);
          assert.ok(values.includes("eligible"));
          assert.ok(values.includes("stale-claim"));
          assert.equal(values.includes("active-claim"), false);
          assert.equal(
            values.includes("active-claim-without-timestamp"),
            false,
          );
          assert.equal(values.includes("contact-changed"), false);
          assert.equal(values.includes("contact-missing"), false);
          return [
            { id: "eligible", finding: "changed" },
            { id: "stale-claim", finding: "stale" },
          ];
        }
        if (query.includes('FROM "Contact" contact')) {
          return [{ id: "contact-1" }];
        }
        return jobs.map((job) => ({ id: job.id }));
      },
    }),
  );

  assert.deepEqual(result, {
    rejected: 2,
    changed: 1,
    stale: 1,
    ambiguous: 0,
    skipped: {
      active_claim: 2,
      contact_changed: 1,
      contact_missing: 1,
    },
  });
  const combined = queries.join("\n");
  assert.match(combined, /job\."verifiedAt" IS NOT NULL/);
  assert.match(combined, /FOR UPDATE/);
  assert.match(combined, /FOR SHARE/);
  assert.match(combined, /job\."resolution" IS NULL/);
  assert.match(
    combined,
    /NOT EXISTS \([\s\S]*FROM "ContactAuditArtistDecision" decision[\s\S]*decision\."runId" = job\."runId"[\s\S]*decision\."artistId" = job\."artistId"/,
  );
  assert.match(combined, /"resolution" = 'rejected'/);
  assert.match(combined, /"resolvedEmail" = job\."snapshotEmail"/);
  assert.match(
    combined,
    /"resolutionClaimToken" IS NULL[\s\S]*"resolutionClaimedAt" <=/,
  );
  assert.doesNotMatch(combined, /\bDELETE\b/i);
  assert.doesNotMatch(combined, /UPDATE "Contact" /);
  assert.doesNotMatch(combined, /UPDATE "ContactAuditAlternative"/);
});

test("bulk rejection preserves an in-flight approval claim through Sheet rollback", async () => {
  const mutableDb = db as unknown as {
    $transaction: (
      work: (tx: Record<string, unknown>) => Promise<unknown>,
      options?: unknown,
    ) => Promise<unknown>;
    contactAuditJob: {
      updateMany: (args: unknown) => Promise<{ count: number }>;
    };
  };
  const originalTransaction = mutableDb.$transaction;
  const originalUpdateMany = mutableDb.contactAuditJob.updateMany;
  const now = new Date("2026-07-22T04:00:00.000Z");
  let contact = auditTarget().contact as Record<string, unknown>;
  let resolutionClaimToken: string | null = null;
  let resolutionClaimedAt: Date | null = null;
  let sheetStarted!: () => void;
  let releaseSheet!: () => void;
  const sheetStartedPromise = new Promise<void>((resolve) => {
    sheetStarted = resolve;
  });
  const releaseSheetPromise = new Promise<void>((resolve) => {
    releaseSheet = resolve;
  });
  let rollbackCount = 0;
  let releaseCount = 0;
  const alternative = {
    id: "alternative-1",
    jobId: "job-1",
    normalizedEmail: "new-manager@example.com",
    email: "new-manager@example.com",
    name: "New Manager",
    role: "management",
  };
  const currentJob = () => ({
    ...auditTarget({
      contact,
      resolutionClaimToken,
      resolutionClaimedAt,
    }),
    rosterSnapshotId: "roster-1",
    alternatives: [alternative],
  });
  const tx = {
    contactAuditArtistDecision: {
      findUnique: async () => null,
    },
    contactAuditJob: {
      findUnique: async () => currentJob(),
      updateMany: async ({
        data,
      }: {
        data: Record<string, unknown>;
      }) => {
        if (typeof data.resolutionClaimToken === "string") {
          resolutionClaimToken = data.resolutionClaimToken;
          resolutionClaimedAt = data.resolutionClaimedAt as Date;
        }
        return { count: 1 };
      },
      findUniqueOrThrow: async () => ({ resolutionClaimToken }),
    },
    contactAuditRosterEntry: {
      findFirst: async () => null,
    },
    contact: {
      findFirst: async () => null,
      update: async () => {
        throw new Error("Contact update must not run after freshness loss");
      },
    },
  };
  mutableDb.$transaction = async (work) => work(tx);
  mutableDb.contactAuditJob.updateMany = async () => {
    releaseCount += 1;
    resolutionClaimToken = null;
    resolutionClaimedAt = null;
    return { count: 1 };
  };

  try {
    const approval = resolveContactAuditJob(
      "job-1",
      "approved",
      alternative.id,
      now,
      {
        update: async () => {
          sheetStarted();
          await releaseSheetPromise;
          return {
            updated: true,
            rowIndex: 2,
            sourceKey: "sheet/tab/row/slot",
            rollback: {
              sourceKey: "sheet/tab/row/slot",
              rowId: "row-1",
              cells: [],
            },
          };
        },
        rollback: async () => {
          rollbackCount += 1;
        },
      },
    );
    await sheetStartedPromise;
    assert.ok(resolutionClaimToken, "approval must own a resolution claim");

    let bulkUpdateRan = false;
    const bulk = await rejectUnresolvedFlaggedAuditDecisions(
      now,
      runWithTransaction({
        contactAuditJob: {
          findMany: async () => [currentJob()],
        },
        $queryRaw: async (value: unknown) => {
          const query = sqlText(value);
          if (query.includes('UPDATE "ContactAuditJob"')) {
            bulkUpdateRan = true;
          }
          return query.includes('FROM "ContactAuditJob" job')
            ? [{ id: "job-1" }]
            : [];
        },
      }),
    );
    assert.equal(bulk.rejected, 0);
    assert.equal(bulk.skipped.active_claim, 1);
    assert.equal(bulkUpdateRan, false);
    assert.ok(
      resolutionClaimToken,
      "bulk rejection must not clear the in-flight owner's token",
    );

    contact = { ...contact, notes: "Changed during Sheet work" };
    releaseSheet();
    const approvalResult = await approval;
    assert.equal(approvalResult.ok, false);
    assert.match(approvalResult.error ?? "", /Sheet change was rolled back/);
    assert.equal(rollbackCount, 1);
    assert.equal(releaseCount, 1);
    assert.equal(resolutionClaimToken, null);
  } finally {
    mutableDb.$transaction = originalTransaction;
    mutableDb.contactAuditJob.updateMany = originalUpdateMany;
  }
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
