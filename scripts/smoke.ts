import "dotenv/config";
import { db } from "@/lib/db";
import { assertSafeDatabaseTestWrite } from "@/lib/databaseWriteSafety";
import { syncEdmtrainShows } from "@/lib/edmtrain";
import { getMe, saveStatsfmCredential, syncStatsfmTopArtists } from "@/lib/statsfm";

async function main() {
  assertSafeDatabaseTestWrite([
    process.env.DATABASE_URL,
    process.env.DIRECT_URL ?? process.env.DATABASE_URL,
  ]);

  console.log("\n=== EDMTrain sync ===");
  const edm = await syncEdmtrainShows(90);
  console.log(edm);

  console.log("\n=== Stats.fm /me ===");
  const me = await getMe();
  console.log({ id: me.id, name: me.displayName, plus: me.isPlus });
  await saveStatsfmCredential(me);

  console.log("\n=== Stats.fm lifetime top 100 ===");
  const sfm = await syncStatsfmTopArtists(me.id, "lifetime", 100);
  console.log(sfm);

  console.log("\n=== Totals ===");
  const [shows, artists, contacts, signals] = await Promise.all([
    db.show.count(),
    db.artist.count(),
    db.contact.count(),
    db.listenSignal.count(),
  ]);
  console.log({ shows, artists, contacts, listenSignals: signals });

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
