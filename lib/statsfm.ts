import { db } from "@/lib/db";
import { normalizeArtistName } from "@/lib/normalize";

const STATSFM_BASE = "https://api.stats.fm/api/v1";

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
  const cred = await db.integrationCredential.findUnique({ where: { provider: "statsfm" } });
  if (cred?.accessToken) return cred.accessToken;
  const env = process.env.STATSFM_TOKEN;
  if (env) return env;
  throw new Error("No Stats.fm token configured");
}

export function decodeStatsfmTokenExpiry(token: string): Date | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8")) as {
      exp?: number;
    };
    if (typeof payload.exp !== "number") return null;
    return new Date(payload.exp * 1000);
  } catch {
    return null;
  }
}

async function statsfmFetch<T>(path: string): Promise<T> {
  const token = await getStatsfmToken();
  const res = await fetch(`${STATSFM_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Stats.fm ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export async function getMe(): Promise<StatsfmUser> {
  const data = await statsfmFetch<{ item: StatsfmUser }>("/me");
  return data.item;
}

export async function getTopArtists(
  userId: string,
  range: StatsfmRange = "lifetime",
  limit = 500
): Promise<StatsfmTopArtistItem[]> {
  const collected: StatsfmTopArtistItem[] = [];
  const pageSize = Math.min(limit, 100);
  for (let offset = 0; offset < limit; offset += pageSize) {
    const data = await statsfmFetch<{ items: StatsfmTopArtistItem[] }>(
      `/users/${userId}/top/artists?range=${range}&limit=${pageSize}&offset=${offset}`
    );
    if (!data.items || data.items.length === 0) break;
    collected.push(...data.items);
    if (data.items.length < pageSize) break;
  }
  return collected;
}

export async function saveStatsfmCredential(user: StatsfmUser, tokenOverride?: string): Promise<void> {
  const token = tokenOverride ?? (await getStatsfmToken());
  const expiresAt = decodeStatsfmTokenExpiry(token);
  await db.integrationCredential.upsert({
    where: { provider: "statsfm" },
    create: {
      provider: "statsfm",
      accessToken: token,
      expiresAt,
      meta: JSON.stringify({ userId: user.id, displayName: user.displayName, isPlus: user.isPlus }),
    },
    update: {
      accessToken: token,
      expiresAt,
      meta: JSON.stringify({ userId: user.id, displayName: user.displayName, isPlus: user.isPlus }),
    },
  });
}

export async function rotateStatsfmToken(newToken: string): Promise<{ userId: string; displayName: string; expiresAt: Date | null }> {
  // Validate the token by calling /me with it directly (don't write yet).
  const res = await fetch(`${STATSFM_BASE}/me`, {
    headers: { Authorization: `Bearer ${newToken}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Stats.fm token invalid: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { item: StatsfmUser };
  await saveStatsfmCredential(data.item, newToken);
  return {
    userId: data.item.id,
    displayName: data.item.displayName,
    expiresAt: decodeStatsfmTokenExpiry(newToken),
  };
}

export async function syncStatsfmTopArtists(
  userId: string,
  range: StatsfmRange = "lifetime",
  limit = 500
): Promise<{ fetched: number; written: number }> {
  const items = await getTopArtists(userId, range, limit);
  let written = 0;
  for (const it of items) {
    const normalized = normalizeArtistName(it.artist.name);
    const spotifyId = it.artist.externalIds?.spotify?.[0] ?? null;
    const existing = await db.artist.findFirst({
      where: {
        OR: [
          { statsfmId: String(it.artist.id) },
          { normalizedName: normalized },
          ...(spotifyId ? [{ spotifyId }] : []),
        ],
      },
    });
    const artistData = {
      name: it.artist.name,
      normalizedName: normalized,
      statsfmId: String(it.artist.id),
      ...(spotifyId ? { spotifyId } : {}),
      genres: JSON.stringify(it.artist.genres ?? []),
      popularity: it.artist.spotifyPopularity ?? null,
      imageUrl: it.artist.image,
    };
    const artist = existing
      ? await db.artist.update({ where: { id: existing.id }, data: artistData })
      : await db.artist.create({ data: artistData });

    await db.listenSignal.upsert({
      where: { artistId_source: { artistId: artist.id, source: `statsfm_${range}` } },
      create: {
        artistId: artist.id,
        source: `statsfm_${range}`,
        rank: it.position,
        playCount: it.streams,
        score: it.playedMs,
        lastSeenAt: new Date(),
      },
      update: {
        rank: it.position,
        playCount: it.streams,
        score: it.playedMs,
        lastSeenAt: new Date(),
        fetchedAt: new Date(),
      },
    });
    written++;
  }
  await db.setting.upsert({
    where: { key: `statsfm_last_sync_${range}` },
    create: { key: `statsfm_last_sync_${range}`, value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  });
  return { fetched: items.length, written };
}
