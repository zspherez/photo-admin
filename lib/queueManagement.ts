import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

const FLAGGED_AUDIT_FINDINGS = ["changed", "stale", "ambiguous"] as const;

export interface QueueManagementCounts {
  auditDecisions: number;
  researchReviews: number;
  pendingResearchJobs: number;
  claimedResearchJobs: number;
}

export interface AuditRejectionResult {
  rejected: number;
  changed: number;
  stale: number;
  ambiguous: number;
}

export interface ResearchQueueDeactivationResult {
  deactivated: number;
  pending: number;
  claimed: number;
}

export type QueueManagementTransactionRunner = <T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
) => Promise<T>;

async function withSerializableRetry<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await db.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      const code =
        error instanceof Prisma.PrismaClientKnownRequestError
          ? error.code
          : null;
      if (code === "P2034" && attempt < 3) continue;
      throw error;
    }
  }
  throw new Error("Unable to complete serializable queue management");
}

export async function readQueueManagementCounts(): Promise<QueueManagementCounts> {
  const [auditDecisions, researchReviews, queueStatuses] = await Promise.all([
    db.contactAuditJob.count({
      where: {
        status: "complete",
        finding: { in: [...FLAGGED_AUDIT_FINDINGS] },
        resolution: null,
      },
    }),
    db.contactResearchJob.count({ where: { status: "review" } }),
    db.contactResearchJob.groupBy({
      by: ["status"],
      where: { status: { in: ["pending", "claimed"] } },
      _count: { _all: true },
    }),
  ]);
  const counts = new Map(
    queueStatuses.map((row) => [row.status, row._count._all]),
  );
  return {
    auditDecisions,
    researchReviews,
    pendingResearchJobs: counts.get("pending") ?? 0,
    claimedResearchJobs: counts.get("claimed") ?? 0,
  };
}

export async function rejectUnresolvedFlaggedAuditDecisions(
  now: Date = new Date(),
  runTransaction: QueueManagementTransactionRunner = withSerializableRetry,
): Promise<AuditRejectionResult> {
  return runTransaction(async (tx) => {
    const rows = await tx.$queryRaw<AuditRejectionResult[]>(Prisma.sql`
      WITH targets AS (
        SELECT
          job."id",
          contact."state"::text AS "contactState"
        FROM "ContactAuditJob" job
        LEFT JOIN "Contact" contact ON contact."id" = job."contactId"
        WHERE job."status" = 'complete'
          AND job."finding" IN ('changed', 'stale', 'ambiguous')
          AND job."resolution" IS NULL
        ORDER BY job."id"
        FOR UPDATE OF job
      ),
      updated AS (
        UPDATE "ContactAuditJob" AS job
        SET
          "resolution" = 'rejected',
          "resolvedAt" = ${now},
          "reviewedAt" = ${now},
          "selectedAlternativeId" = NULL,
          "resolvedContactId" = job."contactId",
          "resolvedArtistId" = job."artistId",
          "resolvedArtistName" = job."snapshotArtistName",
          "resolvedEmail" = job."snapshotEmail",
          "resolvedPhone" = job."snapshotPhone",
          "resolvedDirectOutreachNote" = job."snapshotDirectOutreachNote",
          "resolvedName" = job."snapshotName",
          "resolvedRole" = job."snapshotRole",
          "resolvedSource" = job."snapshotSource",
          "resolvedState" = targets."contactState",
          "resolutionClaimToken" = NULL,
          "resolutionClaimedAt" = NULL,
          "updatedAt" = ${now}
        FROM targets
        WHERE job."id" = targets."id"
          AND job."resolution" IS NULL
        RETURNING job."finding"
      )
      SELECT
        COUNT(*)::integer AS "rejected",
        COUNT(*) FILTER (WHERE "finding" = 'changed')::integer AS "changed",
        COUNT(*) FILTER (WHERE "finding" = 'stale')::integer AS "stale",
        COUNT(*) FILTER (WHERE "finding" = 'ambiguous')::integer AS "ambiguous"
      FROM updated
    `);
    return (
      rows[0] ?? {
        rejected: 0,
        changed: 0,
        stale: 0,
        ambiguous: 0,
      }
    );
  });
}

export async function deactivatePendingAndClaimedResearchJobs(
  now: Date = new Date(),
  runTransaction: QueueManagementTransactionRunner = withSerializableRetry,
): Promise<ResearchQueueDeactivationResult> {
  return runTransaction(async (tx) => {
    const rows = await tx.$queryRaw<ResearchQueueDeactivationResult[]>(
      Prisma.sql`
        WITH targets AS (
          SELECT job."id", job."status"
          FROM "ContactResearchJob" job
          WHERE job."status" IN ('pending', 'claimed')
          ORDER BY job."id"
          FOR UPDATE
        ),
        updated AS (
          UPDATE "ContactResearchJob" AS job
          SET
            "status" = 'inactive',
            "claimToken" = NULL,
            "claimedAt" = NULL,
            "claimExpiresAt" = NULL,
            "completedAt" = NULL,
            "updatedAt" = ${now}
          FROM targets
          WHERE job."id" = targets."id"
            AND job."status" = targets."status"
          RETURNING targets."status" AS "previousStatus"
        )
        SELECT
          COUNT(*)::integer AS "deactivated",
          COUNT(*) FILTER (
            WHERE "previousStatus" = 'pending'
          )::integer AS "pending",
          COUNT(*) FILTER (
            WHERE "previousStatus" = 'claimed'
          )::integer AS "claimed"
        FROM updated
      `,
    );
    return rows[0] ?? { deactivated: 0, pending: 0, claimed: 0 };
  });
}
