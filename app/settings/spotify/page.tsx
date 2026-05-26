import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { SPOTIFY_SCOPES, getValidAccessToken, syncSpotifyListens } from "@/lib/spotify";
import { Card, CardBody } from "@/components/ui/card";
import { Button, LinkButton } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SyncForm } from "@/components/sync-form";
import { SyncBanner } from "@/components/sync-banner";

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
  let redirectTo: string;
  try {
    const result = await syncSpotifyListens();
    await db.setting.upsert({
      where: { key: "spotify_last_result" },
      create: { key: "spotify_last_result", value: JSON.stringify(result) },
      update: { value: JSON.stringify(result) },
    });
    const total =
      result.topLong + result.topMedium + result.topShort + result.recent + result.followed + result.playlists.artists;
    const params = new URLSearchParams({
      synced: "ok",
      total: String(total),
      topLong: String(result.topLong),
      topMedium: String(result.topMedium),
      topShort: String(result.topShort),
      recent: String(result.recent),
      followed: String(result.followed),
      playlists: String(result.playlists.playlists),
      playlistArtists: String(result.playlists.artists),
    });
    redirectTo = `/settings/spotify?${params.toString()}`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.setting.upsert({
      where: { key: "spotify_last_result" },
      create: { key: "spotify_last_result", value: `ERROR: ${msg}` },
      update: { value: `ERROR: ${msg}` },
    });
    redirectTo = `/settings/spotify?synced=error&detail=${encodeURIComponent(msg.slice(0, 200))}`;
  }
  revalidatePath("/settings/spotify");
  revalidatePath("/dashboard");
  revalidatePath("/");
  redirect(redirectTo);
}

export default async function SpotifySettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    detail?: string;
    synced?: string;
    total?: string;
    topLong?: string;
    topMedium?: string;
    topShort?: string;
    recent?: string;
    followed?: string;
    playlists?: string;
    playlistArtists?: string;
  }>;
}) {
  const sp = await searchParams;
  const { status, detail } = sp;
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

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <Link href="/settings" className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">← Settings</Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Spotify</h1>
      <p className="mt-1 text-sm text-zinc-500">Top artists, recent plays, follows, playlists.</p>

      {status === "connected" && (
        <SyncBanner tone="success" title="Spotify connected." />
      )}
      {status === "error" && (
        <SyncBanner tone="error" title="Auth failed." detail={detail ?? "unknown"} />
      )}
      {sp.synced === "ok" && (
        <SyncBanner
          tone="success"
          title="Listens synced."
          detail={`${sp.total ?? "?"} signals · top long ${sp.topLong} · medium ${sp.topMedium} · short ${sp.topShort} · recent ${sp.recent} · followed ${sp.followed} · playlists ${sp.playlists} (${sp.playlistArtists} artists)`}
        />
      )}
      {sp.synced === "error" && (
        <SyncBanner tone="error" title="Sync failed." detail={sp.detail ?? "unknown error"} />
      )}

      <Card className="mt-6">
        <CardBody>
          {cred ? (
            <>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
                  <span className="text-sm font-medium">Connected</span>
                </div>
                <Badge tone="success" size="xs">Active</Badge>
              </div>
              <p className="mt-2 text-xs text-zinc-500">
                Token {cred.expiresAt ? `refreshes ${cred.expiresAt.toLocaleString()}` : "(no expiry)"}
              </p>
              <p className="mt-1 text-xs text-zinc-500">Scopes: {cred.scope ?? "—"}</p>

              <div className="mt-4 flex flex-wrap gap-2">
                <SyncForm action={syncListens} label="Sync listens" pendingLabel="Syncing…" size="sm" />
                <form action={testCall}>
                  <Button type="submit" variant="secondary" size="sm">Test API call</Button>
                </form>
                <form action={disconnect}>
                  <Button type="submit" variant="danger" size="sm">Disconnect</Button>
                </form>
              </div>

              {signalCounts.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {signalCounts.map((c) => (
                    <Badge key={c.source} tone="muted" size="xs">
                      {c.source.replace("spotify_", "")}: {c._count._all}
                    </Badge>
                  ))}
                </div>
              )}
              {lastSync && (
                <p className="mt-2 text-xs text-zinc-500">Last sync {new Date(lastSync.value).toLocaleString()}</p>
              )}
              {lastResult && !lastResult.value.startsWith("ERROR:") && (() => {
                try {
                  const r = JSON.parse(lastResult.value) as {
                    topLong: number; topMedium: number; topShort: number;
                    recent: number; followed: number;
                    playlists: { playlists: number; artists: number };
                  };
                  return (
                    <p className="mt-1 text-xs text-zinc-500">
                      Last result: top {r.topLong}/{r.topMedium}/{r.topShort} · recent {r.recent} · followed {r.followed} · playlists {r.playlists.playlists} ({r.playlists.artists} artists)
                    </p>
                  );
                } catch {
                  return null;
                }
              })()}
              {lastResult && lastResult.value.startsWith("ERROR:") && (
                <p className="mt-1 text-xs text-red-700 dark:text-red-400">{lastResult.value}</p>
              )}
              {lastTest && (
                <pre className="mt-2 overflow-auto rounded-md bg-zinc-50 p-3 text-xs dark:bg-zinc-900">
                  {lastTest.value}
                </pre>
              )}
            </>
          ) : (
            <>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">Not connected.</p>
              <LinkButton href="/api/spotify/login" variant="primary" className="mt-4">
                Connect Spotify
              </LinkButton>
              <p className="mt-3 text-xs text-zinc-500">Requested scopes: <code>{SPOTIFY_SCOPES}</code></p>
            </>
          )}
        </CardBody>
      </Card>
    </main>
  );
}
