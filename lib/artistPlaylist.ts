import {
  spotifyFetch,
  getCurrentSpotifyUserId,
  createPlaylist,
} from "@/lib/spotify";

const MARKET = "US";
const WELL_KNOWN_PER_ARTIST = 3; // most popular
const UNDERGROUND_PER_ARTIST = 2; // deep cuts (lowest popularity)

// Raw list as given. Parenthetical notes (set type / b2b partners) get stripped;
// explicit b2b/x collab markers get split into separate acts.
const RAW = [
  "Andy Frasco & The U.N.",
  "Andreasone",
  "Arts & Crafts",
  "Baby Kush",
  "Bass Temple",
  "Bawab x Sydka",
  "Casey Club",
  "Chef Boyarbeatz B2B Contra",
  "Conrxd",
  "Curly Brown (MNTRA B2B Tchilt)",
  "Danny Grisa",
  "Diggin Dirt",
  "Effin",
  "FMLY BZNS",
  "Geo Smith",
  "GKAT",
  "Gramatik",
  "Helix Moon",
  "Hyperlight",
  "Izzy Wise",
  "JustJoe (Vinyl)",
  "Juush",
  "Kaipora (Sunset Set)",
  "Kasablanca",
  "KLO",
  "Koastle",
  "Lidija x Monción",
  "LSDREAM",
  "Lumi",
  "Marta",
  "Mishell",
  "MNTRA",
  "Mocha",
  "Nariman",
  "No Suits",
  "Novodor",
  "Of The Trees",
  "Peace Control",
  "Ship Wrek",
  "Sosh & Mosh",
  "Steller",
  "Strawberry Disco Circus",
  "Tape B",
  "Tara Brooks",
  "The Botanist",
  "The Floridians",
  "Tone Ranger",
  "Très Mortimer",
  "Twin Diplomacy",
  "Wonky",
  "Willa & Strawberry Disco Circus",
  "Yamagocci",
  "Zoska",
];

// Names that are genuinely a single act despite containing "&" — don't split.
const KEEP_AS_ONE = new Set([
  "andy frasco & the u.n.",
  "arts & crafts",
  "sosh & mosh",
]);

function expand(entry: string): string[] {
  const cleaned = entry.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  if (KEEP_AS_ONE.has(cleaned.toLowerCase())) return [cleaned];
  return cleaned
    .split(/\s+B2B\s+|\s+x\s+|\s+&\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]/g, "");
}

interface SpotifyArtist {
  id: string;
  name: string;
  followers?: { total: number };
  popularity?: number;
}
interface SpotifyTrack {
  id: string;
  uri: string;
  name: string;
  popularity?: number;
}

async function resolveArtist(query: string): Promise<SpotifyArtist | null> {
  const q = new URLSearchParams({ q: query, type: "artist", limit: "8" });
  const res = await spotifyFetch<{ artists?: { items?: SpotifyArtist[] } }>(
    `/search?${q.toString()}`
  );
  const items = res.artists?.items ?? [];
  if (items.length === 0) return null;
  const target = norm(query);
  const exact = items
    .filter((a) => norm(a.name) === target)
    .sort((a, b) => (b.followers?.total ?? 0) - (a.followers?.total ?? 0));
  if (exact.length) return exact[0];
  const partial = items.find(
    (a) => norm(a.name).includes(target) || target.includes(norm(a.name))
  );
  return partial ?? items[0];
}

async function topTracks(artistId: string): Promise<SpotifyTrack[]> {
  const res = await spotifyFetch<{ tracks?: SpotifyTrack[] }>(
    `/artists/${artistId}/top-tracks?market=${MARKET}`
  );
  return res.tracks ?? [];
}

async function deepCuts(
  artistId: string,
  excludeIds: Set<string>
): Promise<SpotifyTrack[]> {
  const albumIds: string[] = [];
  let url:
    | string
    | null = `/artists/${artistId}/albums?include_groups=album,single&market=${MARKET}&limit=50`;
  while (url) {
    const res: { items?: { id: string }[]; next?: string | null } =
      await spotifyFetch(url);
    for (const a of res.items ?? []) albumIds.push(a.id);
    url = res.next ?? null;
  }
  if (albumIds.length === 0) return [];

  const trackIds = new Set<string>();
  for (let i = 0; i < albumIds.length; i += 20) {
    const batch = albumIds.slice(i, i + 20);
    const res = await spotifyFetch<{
      albums?: { tracks?: { items?: { id: string }[] } }[];
    }>(`/albums?ids=${batch.join(",")}&market=${MARKET}`);
    for (const al of res.albums ?? [])
      for (const t of al.tracks?.items ?? []) if (t.id) trackIds.add(t.id);
  }

  const tracks: SpotifyTrack[] = [];
  const ids = [...trackIds].filter((id) => !excludeIds.has(id));
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const res = await spotifyFetch<{ tracks?: SpotifyTrack[] }>(
      `/tracks?ids=${batch.join(",")}&market=${MARKET}`
    );
    for (const t of res.tracks ?? []) if (t) tracks.push(t);
  }

  const byName = new Map<string, SpotifyTrack>();
  for (const t of tracks) {
    const key = t.name.toLowerCase().replace(/\s*[-(].*$/, "").trim();
    const cur = byName.get(key);
    if (!cur || (t.popularity ?? 0) < (cur.popularity ?? 0)) byName.set(key, t);
  }
  return [...byName.values()].sort(
    (a, b) => (a.popularity ?? 0) - (b.popularity ?? 0)
  );
}

export interface ArtistPlaylistResult {
  playlistUrl: string | null;
  playlistId: string | null;
  trackCount: number;
  artistsResolved: number;
  unresolved: string[];
  report: { artist: string; searchedAs?: string; tracks: { name: string; kind: "hit" | "deep"; popularity: number | null }[] }[];
}

export async function buildArtistPlaylist(
  opts: { dryRun?: boolean } = {}
): Promise<ArtistPlaylistResult> {
  const terms = [...new Set(RAW.flatMap(expand))];

  const seenArtistIds = new Set<string>();
  const seenTrackUris = new Set<string>();
  const ordered: string[] = [];
  const report: ArtistPlaylistResult["report"] = [];
  const unresolved: string[] = [];

  for (const term of terms) {
    const artist = await resolveArtist(term);
    if (!artist) {
      unresolved.push(term);
      continue;
    }
    if (seenArtistIds.has(artist.id)) continue;
    seenArtistIds.add(artist.id);

    const tops = await topTracks(artist.id);
    const wellKnown = tops.slice(0, WELL_KNOWN_PER_ARTIST);
    const wellKnownIds = new Set(wellKnown.map((t) => t.id));

    const cuts = (await deepCuts(artist.id, wellKnownIds)).filter(
      (t) => !wellKnownIds.has(t.id)
    );
    const underground = cuts.slice(0, UNDERGROUND_PER_ARTIST);

    const tracks: ArtistPlaylistResult["report"][number]["tracks"] = [];
    for (const t of wellKnown) {
      if (seenTrackUris.has(t.uri)) continue;
      seenTrackUris.add(t.uri);
      ordered.push(t.uri);
      tracks.push({ name: t.name, kind: "hit", popularity: t.popularity ?? null });
    }
    for (const t of underground) {
      if (seenTrackUris.has(t.uri)) continue;
      seenTrackUris.add(t.uri);
      ordered.push(t.uri);
      tracks.push({ name: t.name, kind: "deep", popularity: t.popularity ?? null });
    }

    report.push({
      artist: artist.name,
      ...(norm(artist.name) === norm(term) ? {} : { searchedAs: term }),
      tracks,
    });
  }

  if (opts.dryRun) {
    return {
      playlistUrl: null,
      playlistId: null,
      trackCount: ordered.length,
      artistsResolved: seenArtistIds.size,
      unresolved,
      report,
    };
  }

  const userId = await getCurrentSpotifyUserId();
  const pl = await createPlaylist(
    userId,
    "Festival Discovery — Mixed Bag",
    "A few hits + a few deep cuts from each of these artists, auto-built from the lineup.",
    false
  );

  for (let i = 0; i < ordered.length; i += 100) {
    const batch = ordered.slice(i, i + 100);
    await spotifyFetch(`/playlists/${pl.id}/tracks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uris: batch }),
    });
  }

  return {
    playlistUrl: pl.url,
    playlistId: pl.id,
    trackCount: ordered.length,
    artistsResolved: seenArtistIds.size,
    unresolved,
    report,
  };
}
