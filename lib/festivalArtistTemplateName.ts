import { db } from "@/lib/db";

export async function festivalArtistTemplateName({
  showId,
  artistId,
  artistName,
  isFestival,
  readPairings = async (showId, artistId) => db.festivalB2b.findMany({
    where: { showId, members: { some: { artistId } } },
    select: { name: true },
    take: 2,
  }),
}: {
  showId: string;
  artistId: string;
  artistName: string;
  isFestival: boolean;
  readPairings?: (showId: string, artistId: string) => Promise<readonly { name: string }[]>;
}): Promise<string> {
  if (!isFestival) return artistName;
  const pairings = await readPairings(showId, artistId);
  if (pairings.length > 1) {
    throw new Error("Artist belongs to multiple B2B pairings for this festival");
  }
  if (pairings.length === 0) return artistName;
  if (!pairings[0].name.trim()) {
    throw new Error("Festival B2B pairing name is empty");
  }
  return pairings[0].name;
}

export async function festivalArtistsTemplateName({
  showId,
  isFestival,
  artists,
  readPairings = async (showId, artistIds) => db.festivalB2b.findMany({
    where: {
      showId,
      members: { some: { artistId: { in: artistIds } } },
    },
    select: {
      id: true,
      name: true,
      members: {
        where: { artistId: { in: artistIds } },
        select: { artistId: true },
      },
    },
  }),
}: {
  showId: string;
  isFestival: boolean;
  artists: readonly { artistId: string; artistName: string }[];
  readPairings?: (
    showId: string,
    artistIds: string[],
  ) => Promise<readonly {
    id: string;
    name: string;
    members: readonly { artistId: string }[];
  }[]>;
}): Promise<string> {
  if (!isFestival) return artists.map(({ artistName }) => artistName).join(", ");
  const pairings = await readPairings(showId, artists.map(({ artistId }) => artistId));
  const pairingByArtist = new Map<string, { id: string; name: string }>();
  for (const pairing of pairings) {
    if (!pairing.name.trim()) throw new Error("Festival B2B pairing name is empty");
    for (const { artistId } of pairing.members) {
      if (pairingByArtist.has(artistId)) {
        throw new Error("Artist belongs to multiple B2B pairings for this festival");
      }
      pairingByArtist.set(artistId, pairing);
    }
  }
  const included = new Set<string>();
  const names: string[] = [];
  for (const { artistId, artistName } of artists) {
    const pairing = pairingByArtist.get(artistId);
    const key = pairing ? `pair:${pairing.id}` : `artist:${artistId}`;
    if (included.has(key)) continue;
    included.add(key);
    names.push(pairing?.name ?? artistName);
  }
  return names.join(", ");
}
