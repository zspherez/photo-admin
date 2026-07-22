import "dotenv/config";
import { db } from "@/lib/db";

interface CanonicalStateRow {
  artistCount: number;
  artistStateHash: string;
  showCount: number;
  showStateHash: string;
}

async function main(): Promise<void> {
  const result = await db.$transaction(
    async (transaction) => {
      await transaction.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      const [
        canonicalRows,
        runs,
        recommendationArms,
        recommendationSlate,
        issueCodes,
        outreachCount,
        attributedOutreachCount,
        feedbackCount,
        outcomeCount,
        ingestRequests,
      ] = await Promise.all([
        transaction.$queryRaw<CanonicalStateRow[]>`
          SELECT
            (SELECT count(*)::int FROM "Artist") AS "artistCount",
            (
              SELECT md5(
                coalesce(
                  string_agg(id || ':' || "updatedAt"::text, ',' ORDER BY id),
                  ''
                )
              )
              FROM "Artist"
            ) AS "artistStateHash",
            (SELECT count(*)::int FROM "Show") AS "showCount",
            (
              SELECT md5(
                coalesce(
                  string_agg(id || ':' || "updatedAt"::text, ',' ORDER BY id),
                  ''
                )
              )
              FROM "Show"
            ) AS "showStateHash"
        `,
        transaction.trajectoryModelRun.findMany({
          where: { producer: "artist_trajectory" },
          orderBy: [{ generatedAt: "desc" }, { id: "desc" }],
          select: {
            id: true,
            producerRunId: true,
            artifactSha256: true,
            generatedAt: true,
            validUntil: true,
            status: true,
            activatedAt: true,
            _count: {
              select: {
                artists: true,
                recommendations: true,
                importIssues: true,
              },
            },
          },
        }),
        transaction.trajectoryRecommendation.groupBy({
          by: ["arm"],
          _count: { _all: true },
          orderBy: { arm: "asc" },
        }),
        transaction.trajectoryRecommendation.groupBy({
          by: ["isSuggested", "slatePosition"],
          _count: { _all: true },
          orderBy: [{ isSuggested: "desc" }, { slatePosition: "asc" }],
        }),
        transaction.trajectoryImportIssue.groupBy({
          by: ["code"],
          _count: { _all: true },
          orderBy: { code: "asc" },
        }),
        transaction.outreach.count(),
        transaction.outreach.count({
          where: { trajectoryRecommendationId: { not: null } },
        }),
        transaction.trajectoryFeedbackEvent.count(),
        transaction.trajectoryShowOutcome.count(),
        transaction.trajectoryIngestRequest.groupBy({
          by: ["mode", "status"],
          _count: { _all: true },
          orderBy: [{ mode: "asc" }, { status: "asc" }],
        }),
      ]);
      const canonical = canonicalRows[0];
      if (!canonical) throw new Error("Canonical state query returned no rows");
      return {
        canonical,
        readyRunCount: runs.filter((run) => run.status === "ready").length,
        runs: runs.map((run) => ({
          ...run,
          generatedAt: run.generatedAt.toISOString(),
          validUntil: run.validUntil.toISOString(),
          activatedAt: run.activatedAt?.toISOString() ?? null,
        })),
        recommendationArms: recommendationArms.map((row) => ({
          arm: row.arm,
          count: row._count._all,
        })),
        recommendationSlate: recommendationSlate.map((row) => ({
          isSuggested: row.isSuggested,
          slatePosition: row.slatePosition,
          count: row._count._all,
        })),
        issueCodes: issueCodes.map((row) => ({
          code: row.code,
          count: row._count._all,
        })),
        outreachCount,
        attributedOutreachCount,
        feedbackCount,
        outcomeCount,
        ingestRequests: ingestRequests.map((row) => ({
          mode: row.mode,
          status: row.status,
          count: row._count._all,
        })),
      };
    },
    { timeout: 30_000 },
  );
  console.log(JSON.stringify(result));
}

main()
  .catch(() => {
    console.error(
      JSON.stringify({
        ok: false,
        error: "Trajectory production verification failed",
      }),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
