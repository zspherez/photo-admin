import Link from "next/link";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { getMe, saveStatsfmCredential, syncStatsfmTopArtists } from "@/lib/statsfm";

export const dynamic = "force-dynamic";

async function testAndSave() {
  "use server";
  const me = await getMe();
  await saveStatsfmCredential(me);
  revalidatePath("/settings/statsfm");
  revalidatePath("/");
}

async function syncLifetime() {
  "use server";
  const cred = await db.integrationCredential.findUnique({ where: { provider: "statsfm" } });
  if (!cred?.meta) return;
  const { userId } = JSON.parse(cred.meta);
  await syncStatsfmTopArtists(userId, "lifetime", 500);
  revalidatePath("/settings/statsfm");
  revalidatePath("/");
}

async function disconnect() {
  "use server";
  await db.integrationCredential.deleteMany({ where: { provider: "statsfm" } });
  revalidatePath("/settings/statsfm");
  revalidatePath("/");
}

export default async function StatsfmSettingsPage() {
  const [cred, lifetimeSync, lifetimeCount] = await Promise.all([
    db.integrationCredential.findUnique({ where: { provider: "statsfm" } }),
    db.setting.findUnique({ where: { key: "statsfm_last_sync_lifetime" } }),
    db.listenSignal.count({ where: { source: "statsfm_lifetime" } }),
  ]);
  const meta = cred?.meta ? JSON.parse(cred.meta) : null;
  const hasToken = !!process.env.STATSFM_TOKEN;

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <Link href="/" className="text-sm text-blue-600 hover:underline">← Home</Link>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">Stats.fm</h1>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        Pull your lifetime top artists (richer history than Spotify&apos;s own API).
      </p>

      {!hasToken && (
        <div className="mt-6 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          <code>STATSFM_TOKEN</code> not set in <code>.env</code>. Add it and restart dev.
        </div>
      )}

      <section className="mt-8 rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">Status</h2>
        {meta ? (
          <>
            <p className="mt-3">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" /> Connected as{" "}
              <b>{meta.displayName}</b> ({meta.userId}) {meta.isPlus ? "· Plus" : ""}
            </p>
            <p className="mt-2 text-sm text-zinc-500">
              Lifetime top artists stored: {lifetimeCount}
              {lifetimeSync && (
                <> · last sync {new Date(lifetimeSync.value).toLocaleString()}</>
              )}
            </p>
            <div className="mt-4 flex gap-3">
              <form action={syncLifetime}>
                <button
                  type="submit"
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
                >
                  Sync lifetime top 500
                </button>
              </form>
              <form action={disconnect}>
                <button
                  type="submit"
                  className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950"
                >
                  Disconnect
                </button>
              </form>
            </div>
          </>
        ) : (
          <>
            <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
              Not connected.{" "}
              {hasToken
                ? "Token is in .env — click Test & save to verify and store your user info."
                : "Add STATSFM_TOKEN to .env first."}
            </p>
            <form action={testAndSave} className="mt-4">
              <button
                type="submit"
                disabled={!hasToken}
                className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-zinc-300"
              >
                Test &amp; save
              </button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
