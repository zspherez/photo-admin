import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { normalizeArtistName } from "@/lib/normalize";
import {
  asOperationDeadlineDeferredResult,
  assertOperationTimeRemaining,
  chunkItems,
  createOperationDeadline,
  makeIntegrationSyncLeaseKey,
  mapWithConcurrency,
  minimumDeadlineTransactionRemainingMs,
  operationDeadlineSignal,
  parseRetryAfterMs,
  PROVIDER_REQUEST_MIN_REMAINING_MS,
  ROUTE_DEADLINE_SAFETY_MARGIN_MS,
  runDeadlineBoundTransaction,
  waitForRetryBeforeDeadline,
  withIntegrationSyncLease,
  type DeadlineTransactionPolicy,
  type IntegrationSyncLeaseBusyResult,
  type IntegrationSyncLeaseCompletedResult,
  type IntegrationSyncLeaseGuard,
  type OperationDeadlineDeferredResult,
  type OperationDeadline,
} from "@/lib/integrationUtils";
import {
  resolveArtists,
  type ArtistIdentityConflict,
  type ArtistIdentityInput,
} from "@/lib/artistIdentity";

const SPOTIFY_AUTH_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API_BASE = "https://api.spotify.com/v1";
const SPOTIFY_MAX_ATTEMPTS = 4;
const RECENT_PLAY_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const SPOTIFY_DEFAULT_OPERATION_MS = 5 * 60 * 1_000;
const SPOTIFY_DEFAULT_REQUEST_OPERATION_MS = 60_000;
const SPOTIFY_RECONCILIATION_TRANSACTION = {
  operation: "Spotify reconciliation",
  maxWaitMs: 10_000,
  timeoutMs: 120_000,
  minimumTimeoutMs: 30_000,
  lockTimeoutMs: 10_000,
} satisfies DeadlineTransactionPolicy;
export const SPOTIFY_SYNC_LEASE_KEY = makeIntegrationSyncLeaseKey("spotify");

function defaultSpotifyDeadline(): OperationDeadline {
  return createOperationDeadline(SPOTIFY_DEFAULT_OPERATION_MS, {
    safetyMarginMs: ROUTE_DEADLINE_SAFETY_MARGIN_MS,
  });
}

function defaultSpotifyRequestDeadline(): OperationDeadline {
  return createOperationDeadline(SPOTIFY_DEFAULT_REQUEST_OPERATION_MS, {
    safetyMarginMs: ROUTE_DEADLINE_SAFETY_MARGIN_MS,
  });
}

export const SPOTIFY_SCOPES = [
  "user-read-private",
  "user-top-read",
  "user-read-recently-played",
  "user-follow-read",
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-private",
].join(" ");

export function getRedirectUri(): string {
  const base = process.env.APP_BASE_URL ?? "http://127.0.0.1:3000";
  return `${base}/api/spotify/callback`;
}

export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: requireEnv("SPOTIFY_CLIENT_ID"),
    scope: SPOTIFY_SCOPES,
    redirect_uri: getRedirectUri(),
    state,
    show_dialog: "false",
  });
  return `${SPOTIFY_AUTH_URL}?${params.toString()}`;
}

type TokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
};

export class SpotifyApiError extends Error {
  constructor(
    readonly status: number,
    readonly responseBody: string,
    readonly retryAfterMs: number | null
  ) {
    super(`Spotify API ${status}: ${responseBody}`);
    this.name = "SpotifyApiError";
  }
}

export class SpotifyPlaylistMutationUncertainError extends Error {
  readonly code = "spotify_playlist_mutation_uncertain";

  constructor(
    readonly playlistId: string,
    readonly desiredTrackCount: number,
    readonly mutationFailure: unknown
  ) {
    super(
      `Spotify playlist ${playlistId} may have been replaced, but the provider response was inconclusive`,
      { cause: mutationFailure }
    );
    this.name = "SpotifyPlaylistMutationUncertainError";
  }
}

export class SpotifyPlaylistDetailsMutationUncertainError extends Error {
  readonly code = "spotify_playlist_details_mutation_uncertain";

  constructor(
    readonly playlistId: string,
    readonly mutationFailure: unknown
  ) {
    super(
      `Spotify playlist ${playlistId} details may have been updated, but the provider response was inconclusive`,
      { cause: mutationFailure }
    );
    this.name = "SpotifyPlaylistDetailsMutationUncertainError";
  }
}

type RetryMode = "safe" | "rate-limit-only" | "all" | "none";

interface SpotifyRequestPolicy {
  retryMode?: RetryMode;
  maxAttempts?: number;
  deadline?: OperationDeadline;
  onAmbiguousFailure?: () => void;
}

function isSafeMethod(method: string): boolean {
  return ["GET", "HEAD", "PUT", "DELETE", "OPTIONS"].includes(method);
}

async function requestWithSpotifyRetry(
  url: string,
  init: RequestInit,
  policy: SpotifyRequestPolicy = {}
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const retryMode = policy.retryMode ?? "safe";
  const maxAttempts = policy.maxAttempts ?? SPOTIFY_MAX_ATTEMPTS;
  const deadline = policy.deadline ?? defaultSpotifyRequestDeadline();
  const operation = `Spotify ${method} ${new URL(url).pathname} request`;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    assertOperationTimeRemaining(
      deadline,
      PROVIDER_REQUEST_MIN_REMAINING_MS,
      operation
    );
    const signal = operationDeadlineSignal(
      deadline,
      operation,
      init.signal
    );
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        cache: "no-store",
        signal,
      });
    } catch (error) {
      policy.onAmbiguousFailure?.();
      const canRetry =
        attempt < maxAttempts &&
        (retryMode === "all" || (retryMode === "safe" && isSafeMethod(method)));
      if (!canRetry) throw error;
      await waitForRetryBeforeDeadline(
        deadline,
        attempt,
        null,
        `${operation} retry`
      );
      continue;
    }

    if (response.ok) return response;
    if (response.status >= 500) policy.onAmbiguousFailure?.();

    const body = await response.text();
    const retryAfterMs = parseRetryAfterMs(
      response.headers.get("retry-after"),
      deadline.now()
    );
    const retryableStatus = response.status === 429 || response.status >= 500;
    const canRetryMethod =
      retryMode === "all" ||
      (retryMode === "safe" && isSafeMethod(method)) ||
      (retryMode === "rate-limit-only" && response.status === 429);
    if (
      attempt < maxAttempts &&
      retryableStatus &&
      canRetryMethod
    ) {
      await waitForRetryBeforeDeadline(
        deadline,
        attempt,
        retryAfterMs,
        `${operation} retry`
      );
      continue;
    }
    throw new SpotifyApiError(response.status, body.slice(0, 2_000), retryAfterMs);
  }

  throw new Error("Spotify retry loop exhausted");
}

export async function exchangeCodeForToken(
  code: string,
  deadline: OperationDeadline = defaultSpotifyRequestDeadline()
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: getRedirectUri(),
  });
  return tokenRequest(body, "rate-limit-only", deadline);
}

export async function refreshAccessToken(
  refreshToken: string,
  deadline: OperationDeadline = defaultSpotifyRequestDeadline()
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  return tokenRequest(body, "all", deadline);
}

async function tokenRequest(
  body: URLSearchParams,
  retryMode: RetryMode,
  deadline?: OperationDeadline
): Promise<TokenResponse> {
  const basic = Buffer.from(
    `${requireEnv("SPOTIFY_CLIENT_ID")}:${requireEnv("SPOTIFY_CLIENT_SECRET")}`
  ).toString("base64");

  const response = await requestWithSpotifyRetry(
    SPOTIFY_TOKEN_URL,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    },
    { retryMode, deadline }
  );
  return response.json() as Promise<TokenResponse>;
}

export async function saveTokens(tokens: TokenResponse): Promise<void> {
  const expiresAt = new Date(Date.now() + (tokens.expires_in - 60) * 1_000);
  await db.integrationCredential.upsert({
    where: { provider: "spotify" },
    create: {
      provider: "spotify",
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt,
      scope: tokens.scope,
    },
    update: {
      accessToken: tokens.access_token,
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
      expiresAt,
      scope: tokens.scope,
    },
  });
}

export async function getValidAccessToken(
  deadline?: OperationDeadline
): Promise<string | null> {
  const credential = await db.integrationCredential.findUnique({
    where: { provider: "spotify" },
  });
  if (!credential) return null;
  const stillFresh =
    credential.expiresAt && credential.expiresAt.getTime() > Date.now();
  if (stillFresh) return credential.accessToken;
  if (!credential.refreshToken) return null;
  const refreshed = await refreshAccessToken(credential.refreshToken, deadline);
  await saveTokens(refreshed);
  return refreshed.access_token;
}

async function spotifyResponseWithToken(
  token: string,
  path: string,
  init: RequestInit = {},
  policy: SpotifyRequestPolicy = {}
): Promise<Response> {
  const url = path.startsWith("http")
    ? new URL(path)
    : new URL(`${SPOTIFY_API_BASE}${path}`);
  if (
    url.origin !== "https://api.spotify.com" ||
    !url.pathname.startsWith("/v1/")
  ) {
    throw new Error(`Spotify API returned an unexpected URL: ${url}`);
  }
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return requestWithSpotifyRetry(
    url.toString(),
    {
      ...init,
      headers,
    },
    policy
  );
}

async function spotifyFetchWithToken<T>(
  token: string,
  path: string,
  init: RequestInit = {},
  policy: SpotifyRequestPolicy = {}
): Promise<T> {
  const response = await spotifyResponseWithToken(token, path, init, policy);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Spotify returned invalid JSON for ${path}`);
  }
}

export async function spotifyFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
  policy: SpotifyRequestPolicy = {}
): Promise<T> {
  const token = await getValidAccessToken(policy.deadline);
  if (!token) throw new Error("Spotify not connected");
  return spotifyFetchWithToken<T>(token, path, init, policy);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

interface SpotifyTrackSearchItem {
  uri: string;
  name: string;
  artists: Array<{ name: string }>;
}

export function selectUnambiguousTrackUri(
  items: readonly SpotifyTrackSearchItem[],
  trackName: string,
  artistName: string
): string | null {
  const normalizedTrack = normalizeArtistName(trackName);
  const normalizedArtist = normalizeArtistName(artistName);
  const matches = items.filter((item) => {
    if (normalizeArtistName(item.name) !== normalizedTrack) return false;
    if (!normalizedArtist) return true;
    return item.artists.some(
      (artist) => normalizeArtistName(artist.name) === normalizedArtist
    );
  });
  const uris = Array.from(new Set(matches.map((item) => item.uri)));
  return uris.length === 1 ? uris[0] : null;
}

// Name search is accepted only when it has one exact track/artist match.
export async function searchTrackUri(
  name: string,
  artist: string,
  tokenOverride?: string,
  deadline: OperationDeadline = defaultSpotifyDeadline()
): Promise<string | null> {
  const token = tokenOverride ?? (await getValidAccessToken(deadline));
  if (!token) throw new Error("Spotify not connected");
  const query = new URLSearchParams({
    q: artist ? `track:${name} artist:${artist}` : `track:${name}`,
    type: "track",
    limit: "10",
  });
  const items: SpotifyTrackSearchItem[] = [];
  const visited = new Set<string>();
  let cursor: string | null = `/search?${query.toString()}`;
  for (let page = 0; cursor && page < 10; page++) {
    if (visited.has(cursor)) {
      throw new Error(`Spotify search pagination repeated cursor: ${cursor}`);
    }
    visited.add(cursor);
    const result: {
      tracks?: { items?: SpotifyTrackSearchItem[]; next?: string | null };
    } = await spotifyFetchWithToken(token, cursor, {}, { deadline });
    if (!Array.isArray(result.tracks?.items)) {
      throw new Error("Spotify track search response omitted items");
    }
    items.push(...result.tracks.items);
    cursor = result.tracks.next ?? null;
  }
  if (cursor) return null;
  return selectUnambiguousTrackUri(items, name, artist);
}

export async function getCurrentSpotifyUserId(
  tokenOverride?: string,
  deadline: OperationDeadline = defaultSpotifyRequestDeadline()
): Promise<string> {
  const token = tokenOverride ?? (await getValidAccessToken(deadline));
  if (!token) throw new Error("Spotify not connected");
  const user = await spotifyFetchWithToken<{ id?: unknown }>(
    token,
    "/me",
    {},
    { deadline }
  );
  if (typeof user.id !== "string" || !user.id) {
    throw new Error("Spotify current-user response omitted the user id");
  }
  return user.id;
}

export async function createPlaylist(
  name: string,
  description: string,
  isPublic = false,
  tokenOverride?: string,
  deadline: OperationDeadline = defaultSpotifyRequestDeadline()
): Promise<{ id: string; url: string }> {
  const path = "/me/playlists";
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, description, public: isPublic }),
  };
  const policy: SpotifyRequestPolicy = {
    retryMode: "rate-limit-only",
    deadline,
  };
  const result = tokenOverride
    ? await spotifyFetchWithToken<{
        id: string;
        external_urls?: { spotify?: string };
      }>(tokenOverride, path, init, policy)
    : await spotifyFetch<{
        id: string;
        external_urls?: { spotify?: string };
      }>(path, init, policy);
  // A 429 is known not to have created the resource. Ambiguous network/5xx
  // failures are not replayed; the caller recovers by listing playlists.
  return {
    id: result.id,
    url:
      result.external_urls?.spotify ??
      `https://open.spotify.com/playlist/${result.id}`,
  };
}

export async function playlistExists(
  playlistId: string,
  tokenOverride?: string,
  deadline: OperationDeadline = defaultSpotifyRequestDeadline()
): Promise<boolean> {
  try {
    if (tokenOverride) {
      await spotifyFetchWithToken(
        tokenOverride,
        `/playlists/${playlistId}?fields=id`,
        {},
        { deadline }
      );
    } else {
      await spotifyFetch(
        `/playlists/${playlistId}?fields=id`,
        {},
        { deadline }
      );
    }
    return true;
  } catch (error) {
    if (error instanceof SpotifyApiError && error.status === 404) return false;
    throw error;
  }
}

export async function playlistOwnedByUser(
  playlistId: string,
  userId: string,
  tokenOverride?: string,
  deadline: OperationDeadline = defaultSpotifyRequestDeadline()
): Promise<boolean> {
  if (!userId) throw new Error("Spotify user id is required");
  const token = tokenOverride ?? (await getValidAccessToken(deadline));
  if (!token) throw new Error("Spotify not connected");
  try {
    const playlist = await spotifyFetchWithToken<CurrentUserPlaylist>(
      token,
      `/playlists/${encodeURIComponent(playlistId)}?fields=id,owner(id)`,
      {},
      { deadline }
    );
    return isSpotifyPlaylistOwnedByUser(playlist, userId);
  } catch (error) {
    if (error instanceof SpotifyApiError && error.status === 404) return false;
    throw error;
  }
}

export async function replacePlaylistItems(
  playlistId: string,
  uris: string[],
  tokenOverride?: string,
  deadline: OperationDeadline = defaultSpotifyRequestDeadline()
): Promise<void> {
  const path = `/playlists/${playlistId}/items`;
  const init: RequestInit = {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uris: uris.slice(0, 100) }),
  };
  const token = tokenOverride ?? (await getValidAccessToken(deadline));
  if (!token) throw new Error("Spotify not connected");
  let outcomeUncertain = false;
  try {
    await spotifyResponseWithToken(token, path, init, {
      deadline,
      retryMode: "rate-limit-only",
      onAmbiguousFailure: () => {
        outcomeUncertain = true;
      },
    });
  } catch (error) {
    if (outcomeUncertain) {
      throw new SpotifyPlaylistMutationUncertainError(
        playlistId,
        uris.slice(0, 100).length,
        error
      );
    }
    throw error;
  }
}

export async function updatePlaylistDescription(
  playlistId: string,
  description: string,
  tokenOverride?: string,
  deadline: OperationDeadline = defaultSpotifyRequestDeadline()
): Promise<void> {
  const path = `/playlists/${encodeURIComponent(playlistId)}`;
  const init: RequestInit = {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description }),
  };
  const token = tokenOverride ?? (await getValidAccessToken(deadline));
  if (!token) throw new Error("Spotify not connected");
  let outcomeUncertain = false;
  try {
    await spotifyResponseWithToken(token, path, init, {
      deadline,
      retryMode: "rate-limit-only",
      onAmbiguousFailure: () => {
        outcomeUncertain = true;
      },
    });
  } catch (error) {
    if (outcomeUncertain) {
      throw new SpotifyPlaylistDetailsMutationUncertainError(
        playlistId,
        error
      );
    }
    throw error;
  }
}

interface SpotifyArtistLite {
  id: string;
  name: string;
  genres?: string[];
  popularity?: number;
  images?: { url: string }[];
}

export interface CurrentUserPlaylist {
  id: string;
  name: string;
  description?: string;
  collaborative?: boolean;
  owner?: { id?: string };
  external_urls?: { spotify?: string };
}

export function isSpotifyPlaylistOwnedByUser(
  playlist: Pick<CurrentUserPlaylist, "owner">,
  userId: string
): boolean {
  return Boolean(userId) && playlist.owner?.id === userId;
}

async function collectCurrentUserPlaylists(
  token: string,
  deadline: OperationDeadline
): Promise<CurrentUserPlaylist[]> {
  const items: CurrentUserPlaylist[] = [];
  for (let page = 0; page < 1_000; page++) {
    const response = await spotifyFetchWithToken<{
      items?: CurrentUserPlaylist[];
      next?: string | null;
    }>(
      token,
      `/me/playlists?limit=50&offset=${items.length}`,
      {},
      { deadline }
    );
    if (!Array.isArray(response.items)) {
      throw new Error("Spotify current-user playlists response omitted items");
    }
    items.push(...response.items);
    if (!response.next) return items;
    if (response.items.length === 0) {
      throw new Error("Spotify current-user playlists pagination did not advance");
    }
  }
  throw new Error("Spotify current-user playlists pagination exceeded 1000 pages");
}

export async function listAllCurrentUserPlaylists(
  tokenOverride?: string,
  deadline: OperationDeadline = defaultSpotifyDeadline()
): Promise<CurrentUserPlaylist[]> {
  const token = tokenOverride ?? (await getValidAccessToken(deadline));
  if (!token) throw new Error("Spotify not connected");
  return collectCurrentUserPlaylists(token, deadline);
}

export type SpotifyTopRange = "long_term" | "medium_term" | "short_term";

const TOP_SOURCE: Record<SpotifyTopRange, string> = {
  long_term: "spotify_top_long",
  medium_term: "spotify_top_medium",
  short_term: "spotify_top_short",
};

async function fetchTopArtistsSnapshot(
  token: string,
  range: SpotifyTopRange,
  deadline: OperationDeadline,
  limit = 50
): Promise<SpotifyArtistLite[]> {
  const items: SpotifyArtistLite[] = [];
  const visited = new Set<string>();
  let cursor: string | null =
    `/me/top/artists?time_range=${range}&limit=${Math.min(50, limit)}&offset=0`;
  while (cursor && items.length < limit) {
    if (visited.has(cursor)) {
      throw new Error(`Spotify top-${range} pagination repeated cursor: ${cursor}`);
    }
    visited.add(cursor);
    const page: {
      items?: SpotifyArtistLite[];
      next?: string | null;
    } = await spotifyFetchWithToken(token, cursor, {}, { deadline });
    if (!Array.isArray(page.items)) {
      throw new Error(`Spotify top-${range} response omitted items`);
    }
    items.push(...page.items);
    cursor = page.next ?? null;
  }
  return items.slice(0, limit);
}

interface RecentPlayItem {
  played_at: string;
  track: { artists: SpotifyArtistLite[] };
}

interface RecentArtist {
  artist: SpotifyArtistLite;
  playedAt: Date;
}

async function fetchRecentlyPlayedSnapshot(
  token: string,
  now: Date,
  deadline: OperationDeadline
): Promise<RecentArtist[]> {
  const cutoff = now.getTime() - RECENT_PLAY_TTL_MS;
  const seen = new Map<string, RecentArtist>();
  // Spotify exposes only the latest 50 plays, not a complete TTL window.
  // Absence is therefore non-destructive; unseen rows age out via expiresAt.
  const page = await spotifyFetchWithToken<{ items?: RecentPlayItem[] }>(
    token,
    "/me/player/recently-played?limit=50",
    {},
    { deadline }
  );
  if (!Array.isArray(page.items)) {
    throw new Error("Spotify recent-play response omitted items");
  }
  for (const item of page.items) {
    const playedAt = new Date(item.played_at);
    if (Number.isNaN(playedAt.getTime())) {
      throw new Error(`Spotify returned invalid played_at: ${item.played_at}`);
    }
    if (playedAt.getTime() <= cutoff) continue;
    for (const artist of item.track.artists ?? []) {
      const prior = seen.get(artist.id);
      if (!prior || prior.playedAt < playedAt) {
        seen.set(artist.id, { artist, playedAt });
      }
    }
  }
  return Array.from(seen.values());
}

async function fetchFollowedArtistsSnapshot(
  token: string,
  deadline: OperationDeadline
): Promise<SpotifyArtistLite[]> {
  const items: SpotifyArtistLite[] = [];
  const visited = new Set<string>();
  let cursor: string | null = "/me/following?type=artist&limit=50";

  while (cursor) {
    if (visited.has(cursor)) {
      throw new Error(`Spotify followed-artists pagination repeated cursor: ${cursor}`);
    }
    visited.add(cursor);
    const page: {
      artists?: {
        items?: SpotifyArtistLite[];
        next?: string | null;
      };
    } = await spotifyFetchWithToken(token, cursor, {}, { deadline });
    if (!Array.isArray(page.artists?.items)) {
      throw new Error("Spotify followed-artists response omitted items");
    }
    items.push(...page.artists.items);
    cursor = page.artists.next ?? null;
    if (visited.size > 1_000) {
      throw new Error("Spotify followed-artists pagination exceeded 1000 pages");
    }
  }
  return items;
}

export type SpotifyPlaylistSnapshotState =
  | "complete"
  | "forbidden"
  | "not-found";

interface PlaylistSnapshot {
  playlist: CurrentUserPlaylist;
  artists: SpotifyArtistLite[];
  state: SpotifyPlaylistSnapshotState;
}

export function classifySpotifyPlaylistItemsError(
  error: unknown
): Exclude<SpotifyPlaylistSnapshotState, "complete"> | null {
  if (!(error instanceof SpotifyApiError)) return null;
  if (error.status === 403) return "forbidden";
  if (error.status === 404) return "not-found";
  return null;
}

export interface SpotifyPlaylistSnapshotDescriptor {
  playlistId: string;
  state: SpotifyPlaylistSnapshotState;
  artistIds: readonly string[];
}

export function buildSpotifyPlaylistReconciliationPlan(
  snapshots: readonly SpotifyPlaylistSnapshotDescriptor[]
): {
  presentPlaylistIds: string[];
  replacePlaylistIds: string[];
  preservePlaylistIds: string[];
  observedArtistIds: string[];
  complete: boolean;
} {
  const presentPlaylistIds: string[] = [];
  const replacePlaylistIds: string[] = [];
  const preservePlaylistIds: string[] = [];
  const observedArtistIds = new Set<string>();

  for (const snapshot of snapshots) {
    if (snapshot.state === "not-found") continue;
    presentPlaylistIds.push(snapshot.playlistId);
    if (snapshot.state === "forbidden") {
      preservePlaylistIds.push(snapshot.playlistId);
      continue;
    }
    replacePlaylistIds.push(snapshot.playlistId);
    for (const artistId of snapshot.artistIds) observedArtistIds.add(artistId);
  }

  return {
    presentPlaylistIds,
    replacePlaylistIds,
    preservePlaylistIds,
    observedArtistIds: Array.from(observedArtistIds),
    complete: preservePlaylistIds.length === 0,
  };
}

export function spotifyPlaylistSignalArtistIds(
  linkedArtistIds: Iterable<string>
): string[] {
  return Array.from(new Set(linkedArtistIds));
}

async function fetchPlaylistSnapshot(
  token: string,
  deadline: OperationDeadline
): Promise<PlaylistSnapshot[]> {
  const playlists = await collectCurrentUserPlaylists(token, deadline);
  const uniquePlaylists = Array.from(
    new Map(playlists.map((playlist) => [playlist.id, playlist])).values()
  );

  return mapWithConcurrency(uniquePlaylists, 3, async (playlist) => {
    const artists = new Map<string, SpotifyArtistLite>();
    let offset = 0;
    for (let page = 0; page < 10_000; page++) {
      const params = new URLSearchParams({
        limit: "50",
        offset: String(offset),
        fields: "items(item(artists(id,name))),next",
      });
      let response: {
        items?: Array<{
          item: { artists?: SpotifyArtistLite[] } | null;
        }>;
        next?: string | null;
      };
      try {
        response = await spotifyFetchWithToken(
          token,
          `/playlists/${playlist.id}/items?${params.toString()}`,
          {},
          { deadline }
        );
      } catch (error) {
        const state = classifySpotifyPlaylistItemsError(error);
        if (state) return { playlist, artists: [], state };
        throw error;
      }
      if (!Array.isArray(response.items)) {
        throw new Error(
          `Spotify playlist-items response omitted items for ${playlist.id}`
        );
      }
      for (const entry of response.items) {
        for (const artist of entry.item?.artists ?? []) {
          if (artist.id) artists.set(artist.id, artist);
        }
      }
      if (!response.next) break;
      if (response.items.length === 0) {
        throw new Error(
          `Spotify playlist-items pagination did not advance for ${playlist.id}`
        );
      }
      offset += response.items.length;
      if (page === 9_999) {
        throw new Error(
          `Spotify playlist-items pagination exceeded 10000 pages for ${playlist.id}`
        );
      }
    }
    return {
      playlist,
      artists: Array.from(artists.values()),
      state: "complete" as const,
    };
  });
}

function mergeArtist(
  artists: Map<string, SpotifyArtistLite>,
  artist: SpotifyArtistLite
) {
  const prior = artists.get(artist.id);
  artists.set(artist.id, {
    ...prior,
    ...artist,
    genres: artist.genres ?? prior?.genres,
    images: artist.images ?? prior?.images,
    popularity: artist.popularity ?? prior?.popularity,
  });
}

interface SpotifySnapshots {
  top: Record<SpotifyTopRange, SpotifyArtistLite[]>;
  recent: RecentArtist[];
  followed: SpotifyArtistLite[];
  playlists: PlaylistSnapshot[];
}

export interface SpotifyPlaylistSyncIssue {
  playlistId: string;
  name: string;
  state: Exclude<SpotifyPlaylistSnapshotState, "complete" | "not-found">;
}

export interface SpotifySyncResult {
  topLong: number;
  topMedium: number;
  topShort: number;
  recent: number;
  followed: number;
  playlists: {
    playlists: number;
    artists: number;
    removed: number;
    incomplete: number;
    complete: boolean;
    issues: SpotifyPlaylistSyncIssue[];
  };
  identityConflicts: ArtistIdentityConflict[];
}

export interface SpotifySyncPartialResult {
  ok: false;
  status: "partial";
  reason: "playlist_reconciliation_incomplete";
  data: SpotifySyncResult;
  details: {
    stalePlaylistDataPreserved: true;
    playlists: SpotifyPlaylistSyncIssue[];
    action: string;
  };
}

export type SpotifySyncExecutionResult =
  | IntegrationSyncLeaseCompletedResult<SpotifySyncResult>
  | IntegrationSyncLeaseBusyResult
  | OperationDeadlineDeferredResult
  | SpotifySyncPartialResult;

export function finalizeSpotifySyncResult(
  data: SpotifySyncResult
):
  | IntegrationSyncLeaseCompletedResult<SpotifySyncResult>
  | SpotifySyncPartialResult {
  if (data.playlists.complete) {
    return { ok: true, status: "completed", data };
  }
  return {
    ok: false,
    status: "partial",
    reason: "playlist_reconciliation_incomplete",
    data,
    details: {
      stalePlaylistDataPreserved: true,
      playlists: data.playlists.issues,
      action:
        "Verify that each listed playlist is still accessible to the connected Spotify account, then retry the sync.",
    },
  };
}

async function reconcileSpotifySnapshots(
  snapshots: SpotifySnapshots,
  now: Date,
  lease: IntegrationSyncLeaseGuard,
  deadline: OperationDeadline
): Promise<SpotifySyncResult> {
  const generation = randomUUID();
  const playlistPlan = buildSpotifyPlaylistReconciliationPlan(
    snapshots.playlists.map((snapshot) => ({
      playlistId: snapshot.playlist.id,
      state: snapshot.state,
      artistIds: snapshot.artists.map((artist) => artist.id),
    }))
  );
  const replacePlaylistIds = new Set(playlistPlan.replacePlaylistIds);
  const playlistSnapshotComplete = playlistPlan.complete;
  const completePlaylistSnapshots = snapshots.playlists.filter(
    (snapshot) => snapshot.state === "complete"
  );
  const playlistIssues: SpotifyPlaylistSyncIssue[] = snapshots.playlists
    .filter(
      (
        snapshot
      ): snapshot is PlaylistSnapshot & {
        state: SpotifyPlaylistSyncIssue["state"];
      } => snapshot.state === "forbidden"
    )
    .map((snapshot) => ({
      playlistId: snapshot.playlist.id,
      name: snapshot.playlist.name,
      state: snapshot.state,
    }));
  const artistDetails = new Map<string, SpotifyArtistLite>();
  for (const range of Object.keys(snapshots.top) as SpotifyTopRange[]) {
    for (const artist of snapshots.top[range]) mergeArtist(artistDetails, artist);
  }
  for (const item of snapshots.recent) mergeArtist(artistDetails, item.artist);
  for (const artist of snapshots.followed) mergeArtist(artistDetails, artist);
  for (const snapshot of completePlaylistSnapshots) {
    for (const artist of snapshot.artists) mergeArtist(artistDetails, artist);
  }

  const identityInputs: ArtistIdentityInput[] = Array.from(
    artistDetails.values(),
    (artist) => ({
      key: artist.id,
      name: artist.name,
      spotifyId: artist.id,
      genres: artist.genres ? JSON.stringify(artist.genres) : undefined,
      popularity: artist.popularity,
      imageUrl: artist.images?.[0]?.url,
    })
  );

  return runDeadlineBoundTransaction(
    deadline,
    SPOTIFY_RECONCILIATION_TRANSACTION,
    async (tx) => {
      await lease.fenceTransaction(tx);
      const resolved = await resolveArtists(tx, identityInputs);
      const artistId = (spotifyId: string) => {
        const artist = resolved.artistsByKey.get(spotifyId);
        if (!artist) throw new Error(`Spotify artist was not resolved: ${spotifyId}`);
        return artist.id;
      };

      const playlistRows = completePlaylistSnapshots.map(({ playlist }) => ({
        id: randomUUID(),
        spotifyId: playlist.id,
        name: playlist.name,
        url:
          playlist.external_urls?.spotify ??
          `https://open.spotify.com/playlist/${playlist.id}`,
      }));
      for (const playlistChunk of chunkItems(playlistRows, 500)) {
        const values = Prisma.join(
          playlistChunk.map(
            (playlist) =>
              Prisma.sql`(${playlist.id}, ${playlist.spotifyId}, ${playlist.name}, ${playlist.url}, ${now}, ${now})`
          )
        );
        await tx.$executeRaw(
          Prisma.sql`
            INSERT INTO "SpotifyPlaylist"
              ("id", "spotifyId", "name", "url", "createdAt", "updatedAt")
            VALUES ${values}
            ON CONFLICT ("spotifyId") DO UPDATE SET
              "name" = EXCLUDED."name",
              "url" = EXCLUDED."url",
              "updatedAt" = EXCLUDED."updatedAt"
          `
        );
      }

      const seenPlaylistIds = playlistPlan.presentPlaylistIds;
      const removed =
        seenPlaylistIds.length === 0
          ? await tx.spotifyPlaylist.deleteMany()
          : await tx.spotifyPlaylist.deleteMany({
              where: { spotifyId: { notIn: seenPlaylistIds } },
            });
      const dbPlaylists =
        seenPlaylistIds.length === 0
          ? []
          : await tx.spotifyPlaylist.findMany({
              where: { spotifyId: { in: seenPlaylistIds } },
              select: { id: true, spotifyId: true },
            });
      const playlistDbId = new Map(
        dbPlaylists.map((playlist) => [playlist.spotifyId, playlist.id])
      );
      const replacePlaylistDbIds = dbPlaylists
        .filter((playlist) => replacePlaylistIds.has(playlist.spotifyId))
        .map((playlist) => playlist.id);
      if (replacePlaylistDbIds.length > 0) {
        await tx.artistPlaylist.deleteMany({
          where: { playlistId: { in: replacePlaylistDbIds } },
        });
      }
      const playlistLinks = completePlaylistSnapshots.flatMap((snapshot) => {
        const playlistId = playlistDbId.get(snapshot.playlist.id);
        if (!playlistId) {
          throw new Error(
            `Spotify playlist was not persisted: ${snapshot.playlist.id}`
          );
        }
        return snapshot.artists.map((artist) => ({
          playlistId,
          artistId: artistId(artist.id),
        }));
      });
      for (const playlistLinkChunk of chunkItems(playlistLinks, 2_000)) {
        await tx.artistPlaylist.createMany({
          data: playlistLinkChunk,
          skipDuplicates: true,
        });
      }

      const linkedPlaylistArtists = await tx.artistPlaylist.findMany({
        distinct: ["artistId"],
        select: { artistId: true },
      });
      // Accessible links were replaced above while forbidden-playlist links
      // were preserved, so this union is authoritative even for a partial run.
      const allPlaylistArtistIds = new Set(
        spotifyPlaylistSignalArtistIds(
          linkedPlaylistArtists.map(({ artistId }) => artistId)
        )
      );
      await tx.listenSignal.deleteMany({
        where: { source: "spotify_playlist" },
      });

      const sources = [...Object.values(TOP_SOURCE), "spotify_followed"];
      await tx.listenSignal.deleteMany({ where: { source: { in: sources } } });
      const recentArtistIds = snapshots.recent.map((item) =>
        artistId(item.artist.id)
      );
      await tx.listenSignal.deleteMany({
        where: {
          source: "spotify_recent",
          OR: [
            { expiresAt: { lte: now } },
            {
              expiresAt: null,
              OR: [
                {
                  lastSeenAt: {
                    lte: new Date(now.getTime() - RECENT_PLAY_TTL_MS),
                  },
                },
                {
                  lastSeenAt: null,
                  fetchedAt: {
                    lte: new Date(now.getTime() - RECENT_PLAY_TTL_MS),
                  },
                },
              ],
            },
            ...(recentArtistIds.length > 0
              ? [{ artistId: { in: recentArtistIds } }]
              : []),
          ],
        },
      });

      const signals: Prisma.ListenSignalCreateManyInput[] = [];
      for (const range of Object.keys(snapshots.top) as SpotifyTopRange[]) {
        snapshots.top[range].forEach((artist, index) => {
          signals.push({
            artistId: artistId(artist.id),
            source: TOP_SOURCE[range],
            rank: index + 1,
            lastSeenAt: now,
            expiresAt: null,
            syncGeneration: generation,
            fetchedAt: now,
          });
        });
      }
      for (const item of snapshots.recent) {
        signals.push({
          artistId: artistId(item.artist.id),
          source: "spotify_recent",
          lastSeenAt: item.playedAt,
          expiresAt: new Date(item.playedAt.getTime() + RECENT_PLAY_TTL_MS),
          syncGeneration: generation,
          fetchedAt: now,
        });
      }
      for (const artist of snapshots.followed) {
        signals.push({
          artistId: artistId(artist.id),
          source: "spotify_followed",
          lastSeenAt: now,
          expiresAt: null,
          syncGeneration: generation,
          fetchedAt: now,
        });
      }
      for (const playlistArtistId of allPlaylistArtistIds) {
        signals.push({
          artistId: playlistArtistId,
          source: "spotify_playlist",
          lastSeenAt: now,
          expiresAt: null,
          syncGeneration: generation,
          fetchedAt: now,
        });
      }
      if (signals.length > 0) {
        await tx.listenSignal.createMany({ data: signals, skipDuplicates: true });
      }

      if (playlistSnapshotComplete) {
        await tx.setting.upsert({
          where: { key: "spotify_last_sync" },
          create: { key: "spotify_last_sync", value: now.toISOString() },
          update: { value: now.toISOString() },
        });
      }

      return {
        topLong: snapshots.top.long_term.length,
        topMedium: snapshots.top.medium_term.length,
        topShort: snapshots.top.short_term.length,
        recent: snapshots.recent.length,
        followed: snapshots.followed.length,
        playlists: {
          playlists: playlistPlan.presentPlaylistIds.length,
          artists: allPlaylistArtistIds.size,
          removed: removed.count,
          incomplete: playlistPlan.preservePlaylistIds.length,
          complete: playlistSnapshotComplete,
          issues: playlistIssues,
        },
        identityConflicts: resolved.conflicts,
      };
    }
  );
}

async function fetchAllSpotifySnapshots(
  token: string,
  now: Date,
  deadline: OperationDeadline
): Promise<SpotifySnapshots> {
  const ranges: SpotifyTopRange[] = [
    "long_term",
    "medium_term",
    "short_term",
  ];
  const topResults = await mapWithConcurrency(ranges, 2, (range) =>
    fetchTopArtistsSnapshot(token, range, deadline)
  );
  const top = Object.fromEntries(
    ranges.map((range, index) => [range, topResults[index]])
  ) as Record<SpotifyTopRange, SpotifyArtistLite[]>;

  // These can each paginate deeply; keep provider pressure bounded.
  const recent = await fetchRecentlyPlayedSnapshot(token, now, deadline);
  const followed = await fetchFollowedArtistsSnapshot(token, deadline);
  const playlists = await fetchPlaylistSnapshot(token, deadline);
  return { top, recent, followed, playlists };
}

export async function pullTopArtists(range: SpotifyTopRange): Promise<number> {
  const result = requireCompleteSpotifySync(await syncSpotifyListens());
  return range === "long_term"
    ? result.topLong
    : range === "medium_term"
      ? result.topMedium
      : result.topShort;
}

export async function pullRecentlyPlayed(): Promise<number> {
  return requireCompleteSpotifySync(await syncSpotifyListens()).recent;
}

export async function pullFollowedArtists(): Promise<number> {
  return requireCompleteSpotifySync(await syncSpotifyListens()).followed;
}

export async function pullPlaylistArtists(): Promise<{
  playlists: number;
  artists: number;
  removed: number;
  incomplete: number;
  complete: boolean;
  issues: SpotifyPlaylistSyncIssue[];
}> {
  return requireCompleteSpotifySync(await syncSpotifyListens()).playlists;
}

function requireCompleteSpotifySync(
  result: SpotifySyncExecutionResult
): SpotifySyncResult {
  if (result.ok) return result.data;
  if (result.status === "partial") {
    throw new Error(
      `Spotify playlist reconciliation was incomplete for ${result.data.playlists.incomplete} playlist(s)`
    );
  }
  if (result.status === "deferred") {
    throw new Error(
      `Spotify sync was deferred during ${result.details.phase}`
    );
  }
  throw new Error(
    `Spotify sync is already running for ${result.leaseKey}`
  );
}

export async function syncSpotifyListens(
  deadline: OperationDeadline = defaultSpotifyDeadline()
): Promise<SpotifySyncExecutionResult> {
  try {
    const execution = await withIntegrationSyncLease(
      SPOTIFY_SYNC_LEASE_KEY,
      async (lease) => {
        const token = await getValidAccessToken(deadline);
        if (!token) throw new Error("Spotify not connected");
        const now = new Date();
        const snapshots = await fetchAllSpotifySnapshots(token, now, deadline);
        return reconcileSpotifySnapshots(snapshots, now, lease, deadline);
      },
      {
        deadline,
        minimumRemainingMs: minimumDeadlineTransactionRemainingMs(
          SPOTIFY_RECONCILIATION_TRANSACTION
        ),
      }
    );
    if (!execution.ok) return execution;
    return finalizeSpotifySyncResult(execution.data);
  } catch (error) {
    const deferred = asOperationDeadlineDeferredResult(error, {
      deadline,
      operation: "Spotify synchronization",
    });
    if (deferred) return deferred;
    throw error;
  }
}
