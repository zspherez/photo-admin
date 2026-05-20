import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  decodeStatsfmTokenExpiry,
  getMe,
  rotateStatsfmToken,
  saveStatsfmCredential,
  syncStatsfmTopArtists,
} from "@/lib/statsfm";

export const dynamic = "force-dynamic";

async function testAndSave() {
  "use server";
  const me = await getMe();
  await saveStatsfmCredential(me);
  revalidatePath("/settings/statsfm");
  revalidatePath("/");
}

async function rotateToken(formData: FormData) {
  "use server";
  const newToken = ((formData.get("token") as string) ?? "").trim();
  if (!newToken) redirect("/settings/statsfm?rotate=missing");
  try {
    await rotateStatsfmToken(newToken);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    redirect(`/settings/statsfm?rotate=error&detail=${encodeURIComponent(msg.slice(0, 200))}`);
  }
  revalidatePath("/settings/statsfm");
  revalidatePath("/");
  redirect("/settings/statsfm?rotate=ok");
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

export default async function StatsfmSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ rotate?: string; detail?: string }>;
}) {
  const sp = await searchParams;
  const [cred, lifetimeSync, lifetimeCount] = await Promise.all([
    db.integrationCredential.findUnique({ where: { provider: "statsfm" } }),
    db.setting.findUnique({ where: { key: "statsfm_last_sync_lifetime" } }),
    db.listenSignal.count({ where: { source: "statsfm_lifetime" } }),
  ]);
  const meta = cred?.meta ? JSON.parse(cred.meta) : null;
  const hasEnvToken = !!process.env.STATSFM_TOKEN;
  const activeToken = cred?.accessToken ?? process.env.STATSFM_TOKEN ?? null;
  const expiresAt = activeToken ? decodeStatsfmTokenExpiry(activeToken) : null;
  const now = Date.now();
  const hoursUntilExpiry = expiresAt ? (expiresAt.getTime() - now) / 3600_000 : null;
  const expiryColor =
    hoursUntilExpiry === null
      ? "text-zinc-500"
      : hoursUntilExpiry < 0
      ? "text-red-700 dark:text-red-400"
      : hoursUntilExpiry < 24
      ? "text-amber-700 dark:text-amber-400"
      : "text-emerald-700 dark:text-emerald-400";

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <Link href="/settings" className="text-sm text-blue-600 hover:underline">← Settings</Link>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">Stats.fm</h1>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        Pull your lifetime top artists. Tokens expire every ~7 days; rotate without redeploying via the form below.
      </p>

      {sp.rotate === "ok" && (
        <div className="mt-6 rounded-md border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-200">
          New token saved.
        </div>
      )}
      {sp.rotate === "error" && (
        <div className="mt-6 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-200">
          Token rejected{sp.detail ? `: ${sp.detail}` : "."}
        </div>
      )}
      {sp.rotate === "missing" && (
        <div className="mt-6 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-200">
          Paste a token first.
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
            <p className={`mt-2 text-sm ${expiryColor}`}>
              Token{" "}
              {hoursUntilExpiry === null
                ? "expiry unknown"
                : hoursUntilExpiry < 0
                ? `expired ${Math.abs(Math.round(hoursUntilExpiry))}h ago`
                : `expires in ${Math.round(hoursUntilExpiry)}h (${expiresAt!.toLocaleString()})`}
              {cred?.accessToken && cred.accessToken !== process.env.STATSFM_TOKEN && (
                <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                  rotated via UI
                </span>
              )}
            </p>
            <p className="mt-2 text-sm text-zinc-500">
              Lifetime top artists stored: {lifetimeCount}
              {lifetimeSync && <> · last sync {new Date(lifetimeSync.value).toLocaleString()}</>}
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <form action={syncLifetime}>
                <button type="submit" className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700">
                  Sync lifetime top 500
                </button>
              </form>
              <form action={disconnect}>
                <button type="submit" className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950">
                  Disconnect
                </button>
              </form>
            </div>
          </>
        ) : (
          <>
            <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
              Not connected.{" "}
              {hasEnvToken
                ? "Token is in .env — click Test & save to verify."
                : "Paste a token below to connect (or add STATSFM_TOKEN to env)."}
            </p>
            {hasEnvToken && (
              <form action={testAndSave} className="mt-4">
                <button type="submit" className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700">
                  Test &amp; save
                </button>
              </form>
            )}
          </>
        )}
      </section>

      <section className="mt-8 rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">Rotate token</h2>
        <p className="mt-2 text-xs text-zinc-500">
          Paste a fresh Stats.fm JWT (from stats.fm browser DevTools → Application → Local Storage → <code>token</code>). It&apos;s validated against <code>/me</code> before saving.
        </p>
        <form action={rotateToken} className="mt-3 flex flex-col gap-2">
          <textarea
            name="token"
            rows={3}
            placeholder="eyJhbGciOiJIUzI1NiIs..."
            className="block w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
          />
          <div>
            <button type="submit" className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700">
              Save new token
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}
