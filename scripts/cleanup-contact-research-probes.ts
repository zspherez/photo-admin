import "dotenv/config";

import { Prisma, PrismaClient } from "@prisma/client";

import {
  CONTACT_RESEARCH_PROBE_CANDIDATE_IDS,
  CONTACT_RESEARCH_PROBE_JOB_IDS,
  type CleanupCandidateRow,
  type CleanupJobRow,
  type CleanupMode,
  type ContactResearchProbeCleanupStore,
  ContactResearchProbeCleanupError,
  runContactResearchProbeCleanup,
} from "@/lib/contactResearchProbeCleanup";
import { reconcileContactResearchJobAfterProbeCleanup } from "@/lib/contactResearch";

const REQUIRED_CONFIRMATION = "CLEANUP_RESEARCH_PROBES";

function parseMode(argv: string[]): CleanupMode {
  const apply = argv.includes("--apply");
  const verify = argv.includes("--verify");
  const dryRun = argv.includes("--dry-run");
  const knownFlags = new Set([
    "--apply",
    "--verify",
    "--dry-run",
    "--confirmation",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!knownFlags.has(argument)) {
      throw new ContactResearchProbeCleanupError(
        `Unknown cleanup argument: ${argument}`
      );
    }
    if (argument === "--confirmation") index += 1;
  }
  if ([apply, verify, dryRun].filter(Boolean).length > 1) {
    throw new ContactResearchProbeCleanupError(
      "Choose only one of --dry-run, --apply, or --verify"
    );
  }
  const confirmationIndex = argv.indexOf("--confirmation");
  const confirmation =
    confirmationIndex >= 0 ? argv[confirmationIndex + 1] : undefined;
  if (confirmationIndex >= 0 && !confirmation) {
    throw new ContactResearchProbeCleanupError(
      "--confirmation requires a value"
    );
  }
  if (apply && confirmation !== REQUIRED_CONFIRMATION) {
    throw new ContactResearchProbeCleanupError(
      `--apply requires --confirmation ${REQUIRED_CONFIRMATION}`
    );
  }
  if (!apply && confirmation !== undefined) {
    throw new ContactResearchProbeCleanupError(
      "--confirmation is accepted only with --apply"
    );
  }
  return apply ? "apply" : verify ? "verify" : "dry-run";
}

type CleanupDb = PrismaClient | Prisma.TransactionClient;

function cleanupStore(db: CleanupDb): ContactResearchProbeCleanupStore {
  return {
    async readJobs(lock) {
      if (lock) {
        return db.$queryRaw<CleanupJobRow[]>(Prisma.sql`
          SELECT
            job."id",
            artist."name" AS "artistName",
            job."agentNotes"
          FROM "ContactResearchJob" AS job
          INNER JOIN "Artist" AS artist ON artist."id" = job."artistId"
          WHERE job."id" IN (${Prisma.join(CONTACT_RESEARCH_PROBE_JOB_IDS)})
          ORDER BY job."id"
          FOR UPDATE OF job
        `);
      }
      const jobs = await db.contactResearchJob.findMany({
        where: { id: { in: [...CONTACT_RESEARCH_PROBE_JOB_IDS] } },
        select: {
          id: true,
          agentNotes: true,
          artist: { select: { name: true } },
        },
        orderBy: { id: "asc" },
      });
      return jobs.map((job) => ({
        id: job.id,
        artistName: job.artist.name,
        agentNotes: job.agentNotes,
      }));
    },
    async readManifestCandidates(lock) {
      if (lock) {
        return db.$queryRaw<CleanupCandidateRow[]>(Prisma.sql`
          SELECT candidate."id", candidate."jobId", candidate."evidence"
          FROM "ContactResearchCandidate" AS candidate
          WHERE candidate."id" IN (
            ${Prisma.join(CONTACT_RESEARCH_PROBE_CANDIDATE_IDS)}
          )
          ORDER BY candidate."id"
          FOR UPDATE
        `);
      }
      return db.contactResearchCandidate.findMany({
        where: { id: { in: [...CONTACT_RESEARCH_PROBE_CANDIDATE_IDS] } },
        select: { id: true, jobId: true, evidence: true },
        orderBy: { id: "asc" },
      });
    },
    async readCandidatesForManifestJobs(lock) {
      if (lock) {
        return db.$queryRaw<CleanupCandidateRow[]>(Prisma.sql`
          SELECT candidate."id", candidate."jobId", candidate."evidence"
          FROM "ContactResearchCandidate" AS candidate
          WHERE candidate."jobId" IN (
            ${Prisma.join(CONTACT_RESEARCH_PROBE_JOB_IDS)}
          )
          ORDER BY candidate."id"
          FOR UPDATE
        `);
      }
      return db.contactResearchCandidate.findMany({
        where: { jobId: { in: [...CONTACT_RESEARCH_PROBE_JOB_IDS] } },
        select: { id: true, jobId: true, evidence: true },
        orderBy: { id: "asc" },
      });
    },
    async deleteCandidates(ids) {
      if (ids.length === 0) return 0;
      const result = await db.contactResearchCandidate.deleteMany({
        where: { id: { in: ids } },
      });
      return result.count;
    },
    async updateAgentNotes(id, expected, next) {
      const result = await db.contactResearchJob.updateMany({
        where: { id, agentNotes: expected },
        data: { agentNotes: next },
      });
      return result.count === 1;
    },
    async reconcileJob(id, now) {
      return reconcileContactResearchJobAfterProbeCleanup(
        db as Prisma.TransactionClient,
        id,
        now
      );
    },
  };
}

function outputSummary(
  summary: Awaited<ReturnType<typeof runContactResearchProbeCleanup>>
) {
  const reconciledCount = Object.values(summary.reconciled).reduce(
    (total, ids) => total + ids.length,
    0
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        ...summary,
        counts: {
          syntheticCandidates: summary.candidates.syntheticIds.length,
          deletedCandidates: summary.candidates.deletedIds.length,
          preservedCandidates:
            summary.candidates.preservedSubstantiveIds.length,
          clearedAgentNotes: summary.agentNotes.clearIds.length,
          trimmedDrinkurwaterNotes:
            summary.agentNotes.drinkurwaterTrimIds.length,
          reconciledJobs: reconciledCount,
        },
      },
      null,
      2
    )}\n`
  );
}

async function main() {
  const mode = parseMode(process.argv.slice(2));
  if (!process.env.DATABASE_URL?.trim()) {
    throw new ContactResearchProbeCleanupError("DATABASE_URL is required");
  }
  const prisma = new PrismaClient({ errorFormat: "minimal" });
  try {
    const summary =
      mode === "apply"
        ? await prisma.$transaction(
            (tx) =>
              runContactResearchProbeCleanup(cleanupStore(tx), {
                mode,
                now: new Date(),
              }),
            {
              isolationLevel:
                Prisma.TransactionIsolationLevel.Serializable,
              maxWait: 30_000,
              timeout: 120_000,
            }
          )
        : await runContactResearchProbeCleanup(cleanupStore(prisma), {
            mode,
            now: new Date(),
          });
    outputSummary(summary);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof ContactResearchProbeCleanupError
      ? error.message
      : "Contact research probe cleanup failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
