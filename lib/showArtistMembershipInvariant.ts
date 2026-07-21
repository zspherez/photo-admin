import { Prisma } from "@prisma/client";

export const SHOW_ARTIST_MEMBERSHIP_LOCK_CLASS = 1_397_570_115;
export const SHOW_ARTIST_MEMBERSHIP_LOCK_KEY = 1_294_269_777;

type MembershipInvariantTransaction = Pick<
  Prisma.TransactionClient,
  "$queryRaw"
>;

export async function acquireShowArtistMembershipLock(
  tx: MembershipInvariantTransaction,
): Promise<void> {
  await tx.$queryRaw<Array<{ locked: number }>>(
    Prisma.sql`
      SELECT 1 AS "locked"
      FROM (
        SELECT pg_advisory_xact_lock(
          CAST(${SHOW_ARTIST_MEMBERSHIP_LOCK_CLASS} AS INTEGER),
          CAST(${SHOW_ARTIST_MEMBERSHIP_LOCK_KEY} AS INTEGER)
        )
      ) AS "showArtistMembershipLock"
    `,
  );
}

export async function staleReadyTrajectoryRunsWithMissingMembership(
  tx: MembershipInvariantTransaction,
): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`
      UPDATE "TrajectoryModelRun" AS model_run
      SET
        "status" = 'stale',
        "updatedAt" = clock_timestamp()
      WHERE model_run."producer" = 'artist_trajectory'
        AND model_run."status" = 'ready'
        AND EXISTS (
          SELECT 1
          FROM "TrajectoryRecommendation" AS recommendation
          JOIN "TrajectoryRunArtist" AS run_artist
            ON run_artist."id" = recommendation."runArtistId"
          LEFT JOIN "ShowArtist" AS membership
            ON membership."showId" = recommendation."showId"
            AND membership."artistId" = run_artist."artistId"
          WHERE recommendation."runId" = model_run."id"
            AND (
              run_artist."artistId" IS NULL
              OR membership."showId" IS NULL
            )
        )
      RETURNING model_run."id"
    `,
  );
  return rows.map((row) => row.id);
}
