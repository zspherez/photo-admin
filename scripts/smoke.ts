import "dotenv/config";
import { db } from "@/lib/db";
import { syncEdmtrainShows } from "@/lib/edmtrain";
import { listTabs, syncContactsFromSheet } from "@/lib/sheets";
import { getMe, saveStatsfmCredential, syncStatsfmTopArtists } from "@/lib/statsfm";

async function main() {
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

  console.log("\n=== Sheets tabs ===");
  const tabs = await listTabs();
  console.log(tabs);

  console.log("\n=== Sheets sync (Artists) ===");
  try {
    const sheets = await syncContactsFromSheet("Artists");
    console.log(sheets);
  } catch (e) {
    console.log("Sheets sync failed:", e instanceof Error ? e.message : e);
  }

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
