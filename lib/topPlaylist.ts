import { db } from "@/lib/db";
import { getTopTracks } from "@/lib/statsfm";
import {
  getCurrentSpotifyUserId,
  searchTrackUri,
  createPlaylist,
  playlistExists,
  replacePlaylistItems,
} from "@/lib/spotify";

const PLAYLIST_ID_KEY = "top_tracks_playlist_id";
const PLAYLIST_LAST_SYNC_KEY = "top_tracks_playlist_last_sync";
const PLAYLIST_NAME = "My Top Songs · Last 4 Weeks";
const PLAYLIST_DESCRIPTION =
  "Auto-updated every morning — my top tracks from the last 4 weeks (via stats.fm).";

export interface TopPlaylistResult {
  sourceTracks: number;
  matchedUris: number;
  unmatched: string[];
  playlistId: string;
  playlistUrl: string;
  created: boolean;
}

// Rebuilds the "top songs, last 4 weeks" playlist from stats.fm weekly data,
// mapping each track to a Spotify URI (external id first, search fallback) and
// replacing the playlist's contents. Idempotent — safe to run daily.
export async function refreshTopTracksPlaylist(limit = 50): Promise<TopPlaylistResult> {
  const cred = await db.integrationCredential.findUnique({ where: { provider: "statsfm" } });
  if (!cred?.meta) throw new Error("Stats.fm not connected");
  const { userId } = JSON.parse(cred.meta) as { userId: string };

  const items = await getTopTracks(userId, "weeks", limit);

  const uris: string[] = [];
  const unmatched: string[] = [];
  for (const it of items) {
    const spotifyId = it.track.externalIds?.spotify?.[0];
    if (spotifyId) {
      uris.push(`spotify:track:${spotifyId}`);
      continue;
    }
    const artist = it.track.artists?.[0]?.name ?? "";
    const uri = await searchTrackUri(it.track.name, artist);
    if (uri) uris.push(uri);
    else unmatched.push(`${it.track.name}${artist ? ` — ${artist}` : ""}`);
  }
  // Preserve rank order while dropping duplicates (same track can chart twice
  // across remixes/versions that resolve to the same URI via search).
  const uniqueUris = Array.from(new Set(uris));

  const spotifyUserId = await getCurrentSpotifyUserId();

  let playlistId = (await db.setting.findUnique({ where: { key: PLAYLIST_ID_KEY } }))?.value ?? null;
  let playlistUrl = playlistId ? `https://open.spotify.com/playlist/${playlistId}` : "";
  let created = false;

  if (!playlistId || !(await playlistExists(playlistId))) {
    const pl = await createPlaylist(spotifyUserId, PLAYLIST_NAME, PLAYLIST_DESCRIPTION, false);
    playlistId = pl.id;
    playlistUrl = pl.url;
    created = true;
    await db.setting.upsert({
      where: { key: PLAYLIST_ID_KEY },
      create: { key: PLAYLIST_ID_KEY, value: playlistId },
      update: { value: playlistId },
    });
  }

  await replacePlaylistItems(playlistId, uniqueUris);

  await db.setting.upsert({
    where: { key: PLAYLIST_LAST_SYNC_KEY },
    create: { key: PLAYLIST_LAST_SYNC_KEY, value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  });

  return {
    sourceTracks: items.length,
    matchedUris: uniqueUris.length,
    unmatched,
    playlistId,
    playlistUrl,
    created,
  };
}
