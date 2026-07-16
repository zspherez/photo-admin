import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  resolveArtists,
  type ArtistIdentityConflict,
  type ArtistIdentityInput,
} from "@/lib/artistIdentity";
import {
  asOperationDeadlineDeferredResult,
  assertOperationTimeRemaining,
  createOperationDeadline,
  makeIntegrationSyncLeaseKey,
  minimumDeadlineTransactionRemainingMs,
  operationDeadlineSignal,
  parseRetryAfterMs,
  PROVIDER_REQUEST_MIN_REMAINING_MS,
  ROUTE_DEADLINE_SAFETY_MARGIN_MS,
  runDeadlineBoundTransaction,
  waitForRetryBeforeDeadline,
  withIntegrationSyncLease,
  type DeadlineTransactionPolicy,
  type IntegrationSyncLeaseGuard,
  type IntegrationSyncLeaseResult,
  type OperationDeadline,
  type OperationDeadlineDeferredResult,
} from "@/lib/integrationUtils";

const STATSFM_BASE = "https://api.stats.fm/api/v1";
const STATSFM_MAX_ATTEMPTS = 4;
const STATSFM_DEFAULT_OPERATION_MS = 5 * 60 * 1_000;
const STATSFM_DEFAULT_REQUEST_OPERATION_MS = 60_000;
const STATSFM_RECONCILIATION_TRANSACTION = {
  operation: "Stats.fm reconciliation",
  maxWaitMs: 10_000,
  timeoutMs: 120_000,
  minimumTimeoutMs: 30_000,
  lockTimeoutMs: 10_000,
} satisfies DeadlineTransactionPolicy;
const STATSFM_SYNC_LEASE_KEY = makeIntegrationSyncLeaseKey("statsfm");

function defaultStatsfmDeadline(): OperationDeadline {
  return createOperationDeadline(STATSFM_DEFAULT_OPERATION_MS, {
    safetyMarginMs: ROUTE_DEADLINE_SAFETY_MARGIN_MS,
  });
}

function defaultStatsfmRequestDeadline(): OperationDeadline {
  return createOperationDeadline(STATSFM_DEFAULT_REQUEST_OPERATION_MS, {
    safetyMarginMs: ROUTE_DEADLINE_SAFETY_MARGIN_MS,
  });
}

export type StatsfmRange = "weeks" | "months" | "lifetime";

export interface StatsfmUser {
  id: string;
  displayName: string;
  isPlus: boolean;
  image: string | null;
}

export interface StatsfmTopArtistItem {
  position: number;
  streams: number;
  playedMs: number;
  artist: {
    id: number;
    name: string;
    genres: string[];
    image: string | null;
    spotifyPopularity: number | null;
    followers: number | null;
    externalIds: { spotify?: string[] } | null;
  };
}

export async function getStatsfmToken(): Promise<string> {
  const credential = await db.integrationCredential.findUnique({
    where: { provider: "statsfm" },
  });
  if (credential?.accessToken) return credential.accessToken;
  const env = process.env.STATSFM_TOKEN;
  if (env) return env;
  throw new Error("No Stats.fm token configured");
}

export function decodeStatsfmTokenExpiry(token: string): Date | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf-8")
    ) as { exp?: number };
    if (typeof payload.exp !== "number") return null;
    return new Date(payload.exp * 1_000);
  } catch {
    return null;
  }
}

async function statsfmFetchWithToken<T>(
  token: string,
  path: string,
  deadline: OperationDeadline = defaultStatsfmRequestDeadline()
): Promise<T> {
  const operation = `Stats.fm GET ${new URL(path, STATSFM_BASE).pathname} request`;
  for (let attempt = 1; attempt <= STATSFM_MAX_ATTEMPTS; attempt++) {
    assertOperationTimeRemaining(
      deadline,
      PROVIDER_REQUEST_MIN_REMAINING_MS,
      operation
    );
    let response: Response;
    try {
      response = await fetch(`${STATSFM_BASE}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
        signal: operationDeadlineSignal(deadline, operation),
      });
    } catch (error) {
      if (attempt === STATSFM_MAX_ATTEMPTS) throw error;
      await waitForRetryBeforeDeadline(
        deadline,
        attempt,
        null,
        `${operation} retry`
      );
      continue;
    }
    if (response.ok) return response.json() as Promise<T>;

    const body = await response.text();
    if (
      attempt < STATSFM_MAX_ATTEMPTS &&
      (response.status === 429 || response.status >= 500)
    ) {
      await waitForRetryBeforeDeadline(
        deadline,
        attempt,
        parseRetryAfterMs(
          response.headers.get("retry-after"),
          deadline.now()
        ),
        `${operation} retry`
      );
      continue;
    }
    throw new Error(`Stats.fm ${response.status}: ${body.slice(0, 2_000)}`);
  }
  throw new Error("Stats.fm retry loop exhausted");
}

async function statsfmFetch<T>(
  path: string,
  deadline: OperationDeadline = defaultStatsfmRequestDeadline()
): Promise<T> {
  return statsfmFetchWithToken<T>(await getStatsfmToken(), path, deadline);
}

export async function getMe(
  deadline: OperationDeadline = defaultStatsfmRequestDeadline()
): Promise<StatsfmUser> {
  const data = await statsfmFetch<{ item: StatsfmUser }>("/me", deadline);
  return data.item;
}

export interface StatsfmTopTrackItem {
  position: number;
  streams: number;
  playedMs: number;
  track: {
    id: number;
    name: string;
    durationMs?: number;
    externalIds: { spotify?: string[] } | null;
    artists: { id: number; name: string }[];
  };
}

async function collectTopWindow<T>(
  token: string,
  path: string,
  limit: number,
  deadline: OperationDeadline
): Promise<T[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Stats.fm limit must be a positive integer");
  }
  const collected: T[] = [];
  while (collected.length < limit) {
    const pageSize = Math.min(100, limit - collected.length);
    const separator = path.includes("?") ? "&" : "?";
    const data = await statsfmFetchWithToken<{ items?: T[] }>(
      token,
      `${path}${separator}limit=${pageSize}&offset=${collected.length}`,
      deadline
    );
    if (!Array.isArray(data.items)) {
      throw new Error(`Stats.fm response omitted items for ${path}`);
    }
    collected.push(...data.items);
    if (data.items.length < pageSize) break;
  }
  return collected.slice(0, limit);
}

export async function getTopTracks(
  userId: string,
  range: StatsfmRange = "weeks",
  limit = 100,
  deadline: OperationDeadline = defaultStatsfmDeadline()
): Promise<StatsfmTopTrackItem[]> {
  const token = await getStatsfmToken();
  return collectTopWindow<StatsfmTopTrackItem>(
    token,
    `/users/${userId}/top/tracks?range=${range}`,
    limit,
    deadline
  );
}

export async function getTopArtists(
  userId: string,
  range: StatsfmRange = "lifetime",
  limit = 500,
  deadline: OperationDeadline = defaultStatsfmDeadline()
): Promise<StatsfmTopArtistItem[]> {
  const token = await getStatsfmToken();
  return collectTopWindow<StatsfmTopArtistItem>(
    token,
    `/users/${userId}/top/artists?range=${range}`,
    limit,
    deadline
  );
}

export async function saveStatsfmCredential(
  user: StatsfmUser,
  tokenOverride?: string
): Promise<void> {
  const token = tokenOverride ?? (await getStatsfmToken());
  const expiresAt = decodeStatsfmTokenExpiry(token);
  await db.integrationCredential.upsert({
    where: { provider: "statsfm" },
    create: {
      provider: "statsfm",
      accessToken: token,
      expiresAt,
      meta: JSON.stringify({
        userId: user.id,
        displayName: user.displayName,
        isPlus: user.isPlus,
      }),
    },
    update: {
      accessToken: token,
      expiresAt,
      meta: JSON.stringify({
        userId: user.id,
        displayName: user.displayName,
        isPlus: user.isPlus,
      }),
    },
  });
}

export async function rotateStatsfmToken(
  newToken: string,
  deadline: OperationDeadline = defaultStatsfmRequestDeadline()
): Promise<{
  userId: string;
  displayName: string;
  expiresAt: Date | null;
}> {
  const data = await statsfmFetchWithToken<{ item: StatsfmUser }>(
    newToken,
    "/me",
    deadline
  );
  await saveStatsfmCredential(data.item, newToken);
  return {
    userId: data.item.id,
    displayName: data.item.displayName,
    expiresAt: decodeStatsfmTokenExpiry(newToken),
  };
}

function spotifyIdFor(item: StatsfmTopArtistItem): string | null {
  const ids = Array.from(
    new Set((item.artist.externalIds?.spotify ?? []).filter(Boolean))
  );
  if (ids.length > 1) {
    throw new Error(
      `Stats.fm artist ${item.artist.id} has multiple Spotify identities`
    );
  }
  return ids[0] ?? null;
}

export interface StatsfmSyncResult {
  fetched: number;
  written: number;
  identityConflicts: ArtistIdentityConflict[];
}

export interface StatsfmRangeRequest {
  range: StatsfmRange;
  limit: number;
}

export type StatsfmSyncExecutionResult<T> =
  | IntegrationSyncLeaseResult<T>
  | OperationDeadlineDeferredResult;

async function syncStatsfmTopArtistRangesSnapshot(
  userId: string,
  requests: readonly StatsfmRangeRequest[],
  lease: IntegrationSyncLeaseGuard,
  deadline: OperationDeadline
): Promise<Record<StatsfmRange, StatsfmSyncResult | undefined>> {
  const ranges = new Set<StatsfmRange>();
  for (const request of requests) {
    if (ranges.has(request.range)) {
      throw new Error(`Duplicate Stats.fm range: ${request.range}`);
    }
    ranges.add(request.range);
  }

  const token = await getStatsfmToken();
  const snapshots = new Map<StatsfmRange, StatsfmTopArtistItem[]>();
  // Fetch every requested page before any destructive reconciliation.
  for (const request of requests) {
    snapshots.set(
      request.range,
      await collectTopWindow<StatsfmTopArtistItem>(
        token,
        `/users/${userId}/top/artists?range=${request.range}`,
        request.limit,
        deadline
      )
    );
  }

  const itemsByStatsfmId = new Map<string, StatsfmTopArtistItem>();
  for (const items of snapshots.values()) {
    for (const item of items) {
      itemsByStatsfmId.set(String(item.artist.id), item);
    }
  }
  const identities: ArtistIdentityInput[] = Array.from(
    itemsByStatsfmId.entries(),
    ([statsfmId, item]) => ({
      key: statsfmId,
      name: item.artist.name,
      statsfmId,
      spotifyId: spotifyIdFor(item),
      genres: JSON.stringify(item.artist.genres ?? []),
      popularity: item.artist.spotifyPopularity,
      imageUrl: item.artist.image,
    })
  );

  const now = new Date();
  const generation = randomUUID();
  return runDeadlineBoundTransaction(
    deadline,
    STATSFM_RECONCILIATION_TRANSACTION,
    async (tx) => {
      await lease.fenceTransaction(tx);
      const resolved = await resolveArtists(tx, identities);
      const result: Record<StatsfmRange, StatsfmSyncResult | undefined> = {
        weeks: undefined,
        months: undefined,
        lifetime: undefined,
      };

      for (const request of requests) {
        const items = snapshots.get(request.range);
        if (!items) throw new Error(`Missing Stats.fm snapshot: ${request.range}`);
        const source = `statsfm_${request.range}`;
        await tx.listenSignal.deleteMany({ where: { source } });
        const signals: Prisma.ListenSignalCreateManyInput[] = items.map((item) => {
          const artist = resolved.artistsByKey.get(String(item.artist.id));
          if (!artist) {
            throw new Error(`Stats.fm artist was not resolved: ${item.artist.id}`);
          }
          return {
            artistId: artist.id,
            source,
            rank: item.position,
            playCount: item.streams,
            score: item.playedMs,
            lastSeenAt: now,
            expiresAt: null,
            syncGeneration: generation,
            fetchedAt: now,
          };
        });
        if (signals.length > 0) {
          await tx.listenSignal.createMany({
            data: signals,
            skipDuplicates: true,
          });
        }
        await tx.setting.upsert({
          where: { key: `statsfm_last_sync_${request.range}` },
          create: {
            key: `statsfm_last_sync_${request.range}`,
            value: now.toISOString(),
          },
          update: { value: now.toISOString() },
        });
        result[request.range] = {
          fetched: items.length,
          written: signals.length,
          identityConflicts: resolved.conflicts,
        };
      }
      return result;
    }
  );
}

export async function syncStatsfmTopArtistRanges(
  userId: string,
  requests: readonly StatsfmRangeRequest[],
  deadline: OperationDeadline = defaultStatsfmDeadline()
): Promise<
  StatsfmSyncExecutionResult<
    Record<StatsfmRange, StatsfmSyncResult | undefined>
  >
> {
  try {
    return await withIntegrationSyncLease(
      STATSFM_SYNC_LEASE_KEY,
      (lease) =>
        syncStatsfmTopArtistRangesSnapshot(userId, requests, lease, deadline),
      {
        deadline,
        minimumRemainingMs: minimumDeadlineTransactionRemainingMs(
          STATSFM_RECONCILIATION_TRANSACTION
        ),
      }
    );
  } catch (error) {
    const deferred = asOperationDeadlineDeferredResult(error, {
      deadline,
      operation: "Stats.fm synchronization",
    });
    if (deferred) return deferred;
    throw error;
  }
}

export async function syncStatsfmTopArtists(
  userId: string,
  range: StatsfmRange = "lifetime",
  limit = 500,
  deadline: OperationDeadline = defaultStatsfmDeadline()
): Promise<StatsfmSyncExecutionResult<StatsfmSyncResult>> {
  const execution = await syncStatsfmTopArtistRanges(userId, [
    { range, limit },
  ], deadline);
  if (!execution.ok) return execution;
  const rangeResult = execution.data[range];
  if (!rangeResult) throw new Error(`Stats.fm range was not reconciled: ${range}`);
  return {
    ok: true,
    status: "completed",
    data: rangeResult,
  };
}
