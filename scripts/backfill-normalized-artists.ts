import "dotenv/config";
import { Prisma } from "@prisma/client";
import {
  acquireArtistIdentityLock,
} from "@/lib/artistIdentity";
import { db } from "@/lib/db";
import { normalizeArtistName } from "@/lib/normalize";

const BATCH_SIZE = 250;
const COLLISION_BATCH_SIZE = 100;

interface CollisionRow {
  normalizedName: string;
  artistCount: number;
  artistIds: string[];
  artistNames: string[];
}

async function updateBatch(ids: readonly string[]): Promise<number> {
  return db.$transaction(
    async (tx) => {
      await acquireArtistIdentityLock(tx);
      const artists = await tx.artist.findMany({
        where: { id: { in: [...ids] } },
        orderBy: { id: "asc" },
        select: { id: true, name: true, normalizedName: true },
      });
      const stale = artists
        .map((artist) => ({
          ...artist,
          finalNormalizedName: normalizeArtistName(artist.name),
        }))
        .filter(
          (artist) => artist.normalizedName !== artist.finalNormalizedName
        );

      await Promise.all(
        stale.map((artist) =>
          tx.artist.update({
            where: { id: artist.id },
            data: { normalizedName: artist.finalNormalizedName },
          })
        )
      );
      return stale.length;
    },
    { maxWait: 10_000, timeout: 120_000 }
  );
}

async function reportCollisions(): Promise<number> {
  let cursor: string | null = null;
  let collisionCount = 0;

  while (true) {
    const cursorFilter: Prisma.Sql =
      cursor === null
        ? Prisma.empty
        : Prisma.sql`WHERE "normalizedName" > ${cursor}`;
    const rows: CollisionRow[] = await db.$queryRaw<CollisionRow[]>(
      Prisma.sql`
        SELECT
          "normalizedName",
          COUNT(*)::int AS "artistCount",
          array_agg("id" ORDER BY "id") AS "artistIds",
          array_agg("name" ORDER BY "id") AS "artistNames"
        FROM "Artist"
        ${cursorFilter}
        GROUP BY "normalizedName"
        HAVING COUNT(*) > 1
        ORDER BY "normalizedName"
        LIMIT ${COLLISION_BATCH_SIZE}
      `
    );
    if (rows.length === 0) return collisionCount;

    for (const row of rows) {
      collisionCount++;
      console.warn(
        JSON.stringify({
          event: "normalized_artist_collision",
          normalizedName: row.normalizedName,
          artistCount: row.artistCount,
          artists: row.artistIds.map((id: string, index: number) => ({
            id,
            name: row.artistNames[index],
          })),
        })
      );
    }
    cursor = rows.at(-1)!.normalizedName;
  }
}

async function main(): Promise<void> {
  let cursor: string | undefined;
  let scanned = 0;
  let updated = 0;
  let batches = 0;

  while (true) {
    const artists = await db.artist.findMany({
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true },
    });
    if (artists.length === 0) break;

    updated += await updateBatch(artists.map((artist) => artist.id));
    scanned += artists.length;
    batches++;
    cursor = artists.at(-1)!.id;
    console.log(
      JSON.stringify({
        event: "normalized_artist_backfill_batch",
        batch: batches,
        scanned,
        updated,
      })
    );
  }

  const collisions = await reportCollisions();
  console.log(
    JSON.stringify({
      event: "normalized_artist_backfill_complete",
      batches,
      scanned,
      updated,
      collisions,
    })
  );
}

main()
  .catch((error) => {
    console.error(
      "Normalized artist backfill failed:",
      error instanceof Error ? error.message : error
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
