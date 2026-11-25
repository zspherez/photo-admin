import { randomUUID } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { db } from "@/lib/db";
import { appConfig, buildWorkflowRef } from "@/lib/appConfig";
import { festivalRunWindow } from "@/lib/festivalRuns";
import { activeListenSignalWhere } from "@/lib/listenSignal";
import { selectTopArtistSearchIds } from "@/lib/newYearSearchRanking";
import {
  festivalSuggestionsForConfirmedShows,
  validateFestivalRunEvidence,
  type FestivalRunEvidence,
} from "@/lib/festivalRunSearchEvidence";

const WORKFLOW = "festival-runs-search.yml";
const AUDIENCE = "photo-admin-festival-runs-search";
const issuer = "https://token.actions.githubusercontent.com";
const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks`));

export async function authorizedFestivalRunWorker(header: string | null): Promise<boolean> {
  if (!header?.startsWith("Bearer ")) return false;
  try {
    const { payload } = await jwtVerify(header.slice(7), jwks, {
      issuer, audience: AUDIENCE, maxTokenAge: "10m",
    });
    return payload.repository === appConfig.repository.slug &&
      payload.repository_owner === appConfig.repository.owner &&
      payload.ref === "refs/heads/main" &&
      payload.workflow_ref === buildWorkflowRef(appConfig.repository, WORKFLOW) &&
      payload.event_name === "workflow_dispatch";
  } catch {
    return false;
  }
}

export async function startFestivalRunSearch() {
  const { start, end } = festivalRunWindow();
  const now = new Date();
  await db.festivalRunSearchBatch.updateMany({
    where: {
      status: { in: ["queued", "running"] },
      updatedAt: { lt: new Date(now.getTime() - 4 * 60 * 60_000) },
    },
    data: { status: "timed_out" },
  });
  const existing = await db.festivalRunSearchBatch.findFirst({
    where: { status: { in: ["queued", "running"] } },
    orderBy: { createdAt: "desc" },
  });
  if (existing) return existing;
  const signals = await db.listenSignal.findMany({
    where: {
      AND: [
        activeListenSignalWhere(now),
        { source: { in: ["spotify_top_long", "spotify_top_medium", "spotify_top_short", "statsfm_lifetime", "statsfm_months", "statsfm_weeks"] } },
        { rank: { gte: 1, lte: 100 } },
      ],
    },
    select: { artistId: true, source: true, rank: true, expiresAt: true },
  });
  const artistIds = selectTopArtistSearchIds(signals, now);
  if (!artistIds.length) throw new Error("No active top-100 Spotify or Stats.fm artists found");
  let batch;
  try {
    batch = await db.festivalRunSearchBatch.create({
      data: { startDate: start, endDate: end, jobs: { create: artistIds.map((artistId) => ({ artistId })) } },
    });
  } catch (error) {
    const concurrent = await db.festivalRunSearchBatch.findFirst({
      where: { status: { in: ["queued", "running"] } },
    });
    if (concurrent) return concurrent;
    throw error;
  }
  try {
    const token = process.env.PROFESSIONAL_CONTACT_RESEARCH_DISPATCH_TOKEN?.trim();
    if (!token) throw new Error("GitHub workflow dispatch token is not configured");
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(appConfig.repository.owner)}/${encodeURIComponent(appConfig.repository.name)}/actions/workflows/${WORKFLOW}/dispatches`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({ ref: "main", inputs: { batch_id: batch.id } }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (response.status !== 204) throw new Error(`GitHub workflow dispatch returned ${response.status}`);
    return batch;
  } catch (error) {
    await db.festivalRunSearchBatch.update({ where: { id: batch.id }, data: { status: "dispatch_failed" } });
    throw error;
  }
}

export async function claimFestivalRunSearchJob(batchId: string) {
  const batch = await db.festivalRunSearchBatch.findUnique({ where: { id: batchId } });
  if (!batch || !["queued", "running"].includes(batch.status)) return { done: true as const };
  await db.festivalRunSearchBatch.updateMany({ where: { id: batchId, status: "queued" }, data: { status: "running" } });
  await db.festivalRunSearchJob.updateMany({
    where: { batchId, status: "claimed", claimedAt: { lt: new Date(Date.now() - 10 * 60_000) }, attemptCount: { gte: 2 } },
    data: { status: "failed", claimToken: null, error: "Worker claim timed out twice" },
  });
  for (let attempt = 0; attempt < 4; attempt++) {
    const job = await db.festivalRunSearchJob.findFirst({
      where: {
        batchId,
        OR: [
          { status: "pending" },
          { status: "claimed", claimedAt: { lt: new Date(Date.now() - 10 * 60_000) }, attemptCount: { lt: 2 } },
        ],
      },
      include: { artist: { select: { name: true } } },
      orderBy: { id: "asc" },
    });
    if (!job) break;
    const token = randomUUID();
    const updated = await db.festivalRunSearchJob.updateMany({
      where: { id: job.id, status: job.status, claimedAt: job.claimedAt },
      data: { status: "claimed", claimedAt: new Date(), claimToken: token, attemptCount: { increment: 1 } },
    });
    if (updated.count) return {
      done: false as const,
      jobId: job.id,
      claimToken: token,
      artist: job.artist.name,
      startDate: batch.startDate.toISOString().slice(0, 10),
      endDate: batch.endDate.toISOString().slice(0, 10),
    };
  }
  const remaining = await db.festivalRunSearchJob.count({ where: { batchId, status: { in: ["pending", "claimed"] } } });
  if (!remaining) await db.festivalRunSearchBatch.updateMany({ where: { id: batchId, status: "running" }, data: { status: "complete" } });
  return { done: !remaining, waiting: !!remaining };
}

export async function finishFestivalRunSearchJob(
  batchId: string,
  jobId: string,
  token: string,
  rows: FestivalRunEvidence[],
  error?: string,
) {
  const job = await db.festivalRunSearchJob.findFirst({
    where: { id: jobId, batchId, status: "claimed", claimToken: token },
    include: { artist: { select: { name: true } }, batch: { select: { startDate: true, endDate: true } } },
  });
  if (!job) throw new Error("Job claim expired or was already completed");
  const range = { start: job.batch.startDate, end: job.batch.endDate };
  if (!Array.isArray(rows) || rows.length > 12 || rows.some((row) =>
    !validateFestivalRunEvidence(job.artist.name, row, range)
  )) throw new Error("Invalid festival evidence");
  const existing = await db.show.findMany({
    where: {
      date: { gte: range.start, lt: range.end },
      isFestival: true,
      syncStatus: "active",
      dismissedAt: null,
      artists: { some: { artistId: job.artistId, rejectedAt: null } },
    },
    select: { date: true, eventName: true, venueName: true },
  });
  const suggestions = festivalSuggestionsForConfirmedShows(rows, existing);
  await db.$transaction(async (tx) => {
    const claimed = await tx.festivalRunSearchJob.updateMany({
      where: { id: jobId, status: "claimed", claimToken: token },
      data: { status: error ? "failed" : "complete", claimToken: null, error: error?.slice(0, 300) ?? null },
    });
    if (!claimed.count) throw new Error("Job claim expired");
    if (error) return;
    for (const row of suggestions) {
      const prior = await tx.festivalRunSearchSuggestion.findFirst({
        where: {
          job: { artistId: job.artistId },
          date: new Date(`${row.date}T00:00:00Z`),
          festivalName: { equals: row.festivalName, mode: "insensitive" },
        },
        select: { id: true },
      });
      if (prior) continue;
      await tx.festivalRunSearchSuggestion.create({
        data: {
          jobId, date: new Date(`${row.date}T00:00:00Z`),
          festivalName: row.festivalName, city: row.city, region: row.region,
          countryCode: row.countryCode, sourceUrl: row.sourceUrl, evidence: row.evidence,
        },
      });
    }
  });
}
