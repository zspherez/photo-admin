import Link from "next/link";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { SPOTIFY_SCOPES, getValidAccessToken, syncSpotifyListens } from "@/lib/spotify";

export const dynamic = "force-dynamic";

async function disconnect() {
  "use server";
  await db.integrationCredential.deleteMany({ where: { provider: "spotify" } });
  revalidatePath("/settings/spotify");
  revalidatePath("/");
}

async function testCall() {
  "use server";
  const token = await getValidAccessToken();
  if (!token) return;
  const res = await fetch("https://api.spotify.com/v1/me", {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const body = await res.text();
  await db.setting.upsert({
    where: { key: "spotify_last_test" },
    create: { key: "spotify_last_test", value: `${res.status} ${body.slice(0, 500)}` },
    update: { value: `${res.status} ${body.slice(0, 500)}` },
  });
  revalidatePath("/settings/spotify");
}

async function syncListens() {
  "use server";
  try {
    const result = await syncSpotifyListens();
    await db.setting.upsert({
      where: { key: "spotify_last_result" },
      create: { key: "spotify_last_result", value: JSON.stringify(result) },
      update: { value: JSON.stringify(result) },
    });
  } catch (e) {
    await db.setting.upsert({
      where: { key: "spotify_last_result" },
      create: { key: "spotify_last_result", value: `ERROR: ${e instanceof Error ? e.message : String(e)}` },
      update: { value: `ERROR: ${e instanceof Error ? e.message : String(e)}` },
    });
  }
  revalidatePath("/settings/spotify");
  revalidatePath("/dashboard");
  revalidatePath("/");
}

export default async function SpotifySettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; detail?: string }>;
}) {
  const { status, detail } = await searchParams;
  const [cred, lastTest, lastSync, lastResult, signalCounts] = await Promise.all([
    db.integrationCredential.findUnique({ where: { provider: "spotify" } }),
    db.setting.findUnique({ where: { key: "spotify_last_test" } }),
    db.setting.findUnique({ where: { key: "spotify_last_sync" } }),
    db.setting.findUnique({ where: { key: "spotify_last_result" } }),
    db.listenSignal.groupBy({
      by: ["source"],
      where: { source: { startsWith: "spotify_" } },
      _count: { _all: true },
    }),
  ]);
  const signalSummary = signalCounts
    .map((c) => `${c.source}: ${c._count._all}`)
    .join(" · ");

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <Link href="/" className="text-sm text-blue-600 hover:underline">
        ← Home
      </Link>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">Spotify</h1>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        Connect your Spotify account to pull top artists, recent plays, follows, and playlists.
      </p>

      {status === "connected" && (
        <div className="mt-6 rounded-md border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-200">
          Spotify connected.
        </div>
      )}
      {status === "error" && (
        <div className="mt-6 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-200">
          Auth failed: {detail ?? "unknown"}
        </div>
      )}

      <section className="mt-8 rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">Status</h2>
        {cred ? (
          <>
            <p className="mt-3">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" /> Connected
              <span className="ml-2 text-sm text-zinc-500">
                (token refresh{" "}
                {cred.expiresAt
                  ? `expires ${cred.expiresAt.toLocaleString()}`
                  : "no expiry"}
                )
              </span>
            </p>
            <p className="mt-2 text-xs text-zinc-500">Scopes: {cred.scope ?? "—"}</p>
            <div className="mt-4 flex flex-wrap gap-3">
              <form action={syncListens}>
                <button
                  type="submit"
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
                >
                  Sync listens
                </button>
              </form>
              <form action={testCall}>
                <button
                  type="submit"
                  className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                >
                  Test API call
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
            <p className="mt-4 text-xs text-zinc-500">
              {signalSummary || "No Spotify signals yet — click Sync listens."}
              {lastSync && (
                <> · last sync {new Date(lastSync.value).toLocaleString()}</>
              )}
            </p>
            {lastResult && (
              <pre className="mt-2 overflow-auto rounded bg-zinc-100 p-3 text-xs dark:bg-zinc-900">
                {lastResult.value}
              </pre>
            )}
            {lastTest && (
              <pre className="mt-2 overflow-auto rounded bg-zinc-100 p-3 text-xs dark:bg-zinc-900">
                {lastTest.value}
              </pre>
            )}
          </>
        ) : (
          <>
            <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
              Not connected.
            </p>
            <a
              href="/api/spotify/login"
              className="mt-4 inline-block rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
            >
              Connect Spotify
            </a>
            <p className="mt-3 text-xs text-zinc-500">
              Requested scopes: <code>{SPOTIFY_SCOPES}</code>
            </p>
          </>
        )}
      </section>
    </main>
  );
}
