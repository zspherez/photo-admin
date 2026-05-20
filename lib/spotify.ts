import { db } from "@/lib/db";
import { normalizeArtistName } from "@/lib/normalize";

const SPOTIFY_AUTH_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API_BASE = "https://api.spotify.com/v1";

export const SPOTIFY_SCOPES = [
  "user-top-read",
  "user-read-recently-played",
  "user-follow-read",
  "playlist-read-private",
  "playlist-read-collaborative",
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

export async function exchangeCodeForToken(code: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: getRedirectUri(),
  });
  return tokenRequest(body);
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  return tokenRequest(body);
}

async function tokenRequest(body: URLSearchParams): Promise<TokenResponse> {
  const basic = Buffer.from(
    `${requireEnv("SPOTIFY_CLIENT_ID")}:${requireEnv("SPOTIFY_CLIENT_SECRET")}`
  ).toString("base64");

  const res = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Spotify token request failed: ${res.status} ${text}`);
  }
  return res.json();
}

export async function saveTokens(tokens: TokenResponse): Promise<void> {
  const expiresAt = new Date(Date.now() + (tokens.expires_in - 60) * 1000);
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

export async function getValidAccessToken(): Promise<string | null> {
  const cred = await db.integrationCredential.findUnique({ where: { provider: "spotify" } });
  if (!cred) return null;
  const stillFresh = cred.expiresAt && cred.expiresAt.getTime() > Date.now();
  if (stillFresh) return cred.accessToken;
  if (!cred.refreshToken) return null;
  const refreshed = await refreshAccessToken(cred.refreshToken);
  await saveTokens(refreshed);
  return refreshed.access_token;
}

export async function spotifyFetch<T = unknown>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const token = await getValidAccessToken();
  if (!token) throw new Error("Spotify not connected");
  const url = path.startsWith("http") ? path : `${SPOTIFY_API_BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Spotify API ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

interface SpotifyArtistLite {
  id: string;
  name: string;
  genres?: string[];
  popularity?: number;
  images?: { url: string }[];
}

async function upsertArtistFromSpotify(a: { id: string; name: string; genres?: string[]; popularity?: number; image?: string | null }) {
  const normalized = normalizeArtistName(a.name);
  const existing = await db.artist.findFirst({
    where: { OR: [{ spotifyId: a.id }, { normalizedName: normalized }] },
  });
  const baseData = {
    name: a.name,
    normalizedName: normalized,
    spotifyId: a.id,
    ...(a.genres ? { genres: JSON.stringify(a.genres) } : {}),
    ...(a.popularity != null ? { popularity: a.popularity } : {}),
    ...(a.image ? { imageUrl: a.image } : {}),
  };
  if (!existing) return db.artist.create({ data: baseData });
  return db.artist.update({ where: { id: existing.id }, data: baseData });
}

async function writeSignal(artistId: string, source: string, rank: number | null, lastSeenAt?: Date) {
  await db.listenSignal.upsert({
    where: { artistId_source: { artistId, source } },
    create: { artistId, source, rank, lastSeenAt: lastSeenAt ?? new Date() },
    update: { rank, lastSeenAt: lastSeenAt ?? new Date(), fetchedAt: new Date() },
  });
}

export type SpotifyTopRange = "long_term" | "medium_term" | "short_term";

const TOP_SOURCE: Record<SpotifyTopRange, string> = {
  long_term: "spotify_top_long",
  medium_term: "spotify_top_medium",
  short_term: "spotify_top_short",
};

export async function pullTopArtists(range: SpotifyTopRange): Promise<number> {
  const res = await spotifyFetch<{ items: SpotifyArtistLite[] }>(
    `/me/top/artists?time_range=${range}&limit=50`
  );
  let n = 0;
  for (const [i, a] of (res.items ?? []).entries()) {
    const artist = await upsertArtistFromSpotify({
      id: a.id,
      name: a.name,
      genres: a.genres,
      popularity: a.popularity,
      image: a.images?.[0]?.url ?? null,
    });
    await writeSignal(artist.id, TOP_SOURCE[range], i + 1);
    n++;
  }
  return n;
}

export async function pullRecentlyPlayed(): Promise<number> {
  const res = await spotifyFetch<{
    items: { played_at: string; track: { artists: SpotifyArtistLite[] } }[];
  }>("/me/player/recently-played?limit=50");
  const seen = new Map<string, Date>();
  for (const item of res.items ?? []) {
    const playedAt = new Date(item.played_at);
    for (const a of item.track.artists ?? []) {
      if (!seen.has(a.id) || seen.get(a.id)! < playedAt) seen.set(a.id, playedAt);
    }
  }
  let n = 0;
  for (const [spotifyId, playedAt] of seen) {
    const a = (res.items ?? [])
      .flatMap((it) => it.track.artists)
      .find((x) => x.id === spotifyId);
    if (!a) continue;
    const artist = await upsertArtistFromSpotify({ id: a.id, name: a.name });
    await writeSignal(artist.id, "spotify_recent", null, playedAt);
    n++;
  }
  return n;
}

interface FollowingResponse {
  artists: {
    items: SpotifyArtistLite[];
    next: string | null;
    cursors: { after: string | null };
  };
}

export async function pullFollowedArtists(maxArtists = 500): Promise<number> {
  let after: string | null = null;
  let n = 0;
  while (n < maxArtists) {
    const endpoint: string =
      `/me/following?type=artist&limit=50` + (after ? `&after=${after}` : "");
    const res: FollowingResponse = await spotifyFetch<FollowingResponse>(endpoint);
    const items = res.artists?.items ?? [];
    if (items.length === 0) break;
    for (const a of items) {
      const artist = await upsertArtistFromSpotify({
        id: a.id,
        name: a.name,
        genres: a.genres,
        popularity: a.popularity,
        image: a.images?.[0]?.url ?? null,
      });
      await writeSignal(artist.id, "spotify_followed", null);
      n++;
      if (n >= maxArtists) break;
    }
    if (!res.artists.next || !res.artists.cursors.after) break;
    after = res.artists.cursors.after;
  }
  return n;
}

export async function pullPlaylistArtists(maxPlaylists = 100, maxTracksPerPlaylist = 100): Promise<{
  playlists: number;
  artists: number;
  removed: number;
}> {
  // Paginate the full playlist list so deletions are reflected accurately.
  const playlists: { id: string; name: string; external_urls?: { spotify?: string } }[] = [];
  let offset = 0;
  while (playlists.length < maxPlaylists) {
    const pageSize = Math.min(50, maxPlaylists - playlists.length);
    const res = await spotifyFetch<{
      items: { id: string; name: string; external_urls?: { spotify?: string } }[];
      next: string | null;
    }>(`/me/playlists?limit=${pageSize}&offset=${offset}`);
    const items = res.items ?? [];
    if (items.length === 0) break;
    playlists.push(...items);
    if (!res.next) break;
    offset += items.length;
  }

  const playlistDbIds = new Map<string, string>();
  for (const pl of playlists) {
    const url = pl.external_urls?.spotify ?? `https://open.spotify.com/playlist/${pl.id}`;
    const dbPlaylist = await db.spotifyPlaylist.upsert({
      where: { spotifyId: pl.id },
      create: { spotifyId: pl.id, name: pl.name, url },
      update: { name: pl.name, url },
    });
    playlistDbIds.set(pl.id, dbPlaylist.id);
  }

  const artistsByPlaylistDbId = new Map<string, Set<string>>();
  const nameById = new Map<string, string>();

  for (const pl of playlists) {
    const tracksRes = await spotifyFetch<{
      items: { track: { artists: SpotifyArtistLite[] } | null }[];
    }>(`/playlists/${pl.id}/tracks?limit=${maxTracksPerPlaylist}&fields=items(track(artists(id,name)))`);
    const dbId = playlistDbIds.get(pl.id)!;
    const set = artistsByPlaylistDbId.get(dbId) ?? new Set<string>();
    for (const it of tracksRes.items ?? []) {
      if (!it.track) continue;
      for (const a of it.track.artists ?? []) {
        if (!a.id) continue;
        set.add(a.id);
        nameById.set(a.id, a.name);
      }
    }
    artistsByPlaylistDbId.set(dbId, set);
  }

  const allSpotifyIds = new Set<string>();
  for (const set of artistsByPlaylistDbId.values()) for (const id of set) allSpotifyIds.add(id);

  const dbIdBySpotify = new Map<string, string>();
  for (const spotifyId of allSpotifyIds) {
    const name = nameById.get(spotifyId);
    if (!name) continue;
    const artist = await upsertArtistFromSpotify({ id: spotifyId, name });
    dbIdBySpotify.set(spotifyId, artist.id);
    await writeSignal(artist.id, "spotify_playlist", null);
  }

  for (const [playlistDbId, spotifyIds] of artistsByPlaylistDbId) {
    for (const sid of spotifyIds) {
      const artistDbId = dbIdBySpotify.get(sid);
      if (!artistDbId) continue;
      await db.artistPlaylist.upsert({
        where: { artistId_playlistId: { artistId: artistDbId, playlistId: playlistDbId } },
        create: { artistId: artistDbId, playlistId: playlistDbId },
        update: {},
      });
    }
  }

  // Reconcile: delete any SpotifyPlaylist (and via cascade, ArtistPlaylist) that
  // is no longer in your account. Also drop ArtistPlaylist links for playlists
  // that survived but no longer contain the artist (e.g. you removed the track).
  const seenSpotifyIds = playlists.map((p) => p.id);
  const removedPlaylists = await db.spotifyPlaylist.deleteMany({
    where: { spotifyId: { notIn: seenSpotifyIds } },
  });
  for (const [playlistDbId, currentArtistDbIds] of (() => {
    const m = new Map<string, string[]>();
    for (const [pid, sids] of artistsByPlaylistDbId) {
      m.set(pid, Array.from(sids).map((s) => dbIdBySpotify.get(s)).filter((x): x is string => !!x));
    }
    return m;
  })()) {
    await db.artistPlaylist.deleteMany({
      where: { playlistId: playlistDbId, artistId: { notIn: currentArtistDbIds } },
    });
  }
  // Clean up spotify_playlist signals for artists with zero remaining playlist links.
  await db.listenSignal.deleteMany({
    where: { source: "spotify_playlist", artist: { playlists: { none: {} } } },
  });

  return {
    playlists: playlists.length,
    artists: allSpotifyIds.size,
    removed: removedPlaylists.count,
  };
}

export async function syncSpotifyListens(): Promise<{
  topLong: number;
  topMedium: number;
  topShort: number;
  recent: number;
  followed: number;
  playlists: { playlists: number; artists: number };
}> {
  const topLong = await pullTopArtists("long_term");
  const topMedium = await pullTopArtists("medium_term");
  const topShort = await pullTopArtists("short_term");
  const recent = await pullRecentlyPlayed();
  const followed = await pullFollowedArtists(500);
  const playlists = await pullPlaylistArtists(30, 100);
  await db.setting.upsert({
    where: { key: "spotify_last_sync" },
    create: { key: "spotify_last_sync", value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  });
  return { topLong, topMedium, topShort, recent, followed, playlists };
}
