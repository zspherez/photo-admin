import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  CONTACT_AUDIT_FLAGGED_FINDINGS,
  contactAuditResolutionClaimIsActive,
  contactAuditResolutionClaimStaleBefore,
  contactAuditResolutionEligibility,
} from "@/lib/contactAuditResolutionPolicy";

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
  skipped: {
    active_claim: number;
    contact_changed: number;
    contact_missing: number;
  };
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
        verifiedAt: { not: null },
        finding: { in: [...CONTACT_AUDIT_FLAGGED_FINDINGS] },
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
    const targetRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT job."id"
      FROM "ContactAuditJob" job
      WHERE job."status" = 'complete'
        AND job."verifiedAt" IS NOT NULL
        AND job."finding" IN (${Prisma.join([
          ...CONTACT_AUDIT_FLAGGED_FINDINGS,
        ])})
        AND job."resolution" IS NULL
      ORDER BY job."id"
      FOR UPDATE
    `);
    const emptyResult: AuditRejectionResult = {
      rejected: 0,
      changed: 0,
      stale: 0,
      ambiguous: 0,
      skipped: {
        active_claim: 0,
        contact_changed: 0,
        contact_missing: 0,
      },
    };
    if (targetRows.length === 0) return emptyResult;

    const targetIds = targetRows.map((row) => row.id);
    const initialJobs = await tx.contactAuditJob.findMany({
      where: { id: { in: targetIds } },
      include: { contact: true },
      orderBy: { id: "asc" },
    });
    const contactIds = Array.from(
      new Set(
        initialJobs.flatMap((job) =>
          !contactAuditResolutionClaimIsActive(job, now) && job.contact
            ? [job.contact.id]
            : [],
        ),
      ),
    );
    if (contactIds.length > 0) {
      await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT contact."id"
        FROM "Contact" contact
        WHERE contact."id" IN (${Prisma.join(contactIds)})
        ORDER BY contact."id"
        FOR SHARE
      `);
    }

    const jobs = await tx.contactAuditJob.findMany({
      where: { id: { in: targetIds } },
      include: { contact: true },
      orderBy: { id: "asc" },
    });
    const eligibleIds: string[] = [];
    const result: AuditRejectionResult = structuredClone(emptyResult);
    for (const job of jobs) {
      const eligibility = contactAuditResolutionEligibility(job, now);
      if (eligibility === "eligible") {
        eligibleIds.push(job.id);
      } else if (eligibility === "active_claim") {
        result.skipped.active_claim += 1;
      } else if (eligibility === "contact_changed") {
        result.skipped.contact_changed += 1;
      } else if (eligibility === "contact_missing") {
        result.skipped.contact_missing += 1;
      }
    }
    if (eligibleIds.length === 0) return result;

    const staleClaimBefore = contactAuditResolutionClaimStaleBefore(now);
    const updated = await tx.$queryRaw<
      Array<{ id: string; finding: string }>
    >(Prisma.sql`
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
        "resolvedState" = 'active',
        "resolutionClaimToken" = NULL,
        "resolutionClaimedAt" = NULL,
        "updatedAt" = ${now}
      WHERE job."id" IN (${Prisma.join(eligibleIds)})
        AND job."status" = 'complete'
        AND job."verifiedAt" IS NOT NULL
        AND job."finding" IN (${Prisma.join([
          ...CONTACT_AUDIT_FLAGGED_FINDINGS,
        ])})
        AND job."resolution" IS NULL
        AND (
          job."resolutionClaimToken" IS NULL
          OR job."resolutionClaimedAt" <= ${staleClaimBefore}
        )
      RETURNING job."id", job."finding"
    `);
    result.rejected = updated.length;
    for (const row of updated) {
      if (row.finding === "changed") result.changed += 1;
      if (row.finding === "stale") result.stale += 1;
      if (row.finding === "ambiguous") result.ambiguous += 1;
    }
    return result;
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
