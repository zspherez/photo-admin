import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { SPOTIFY_SCOPES, getValidAccessToken, syncSpotifyListens } from "@/lib/spotify";
import { refreshTopTracksPlaylist } from "@/lib/topPlaylist";
import { Card, CardBody } from "@/components/ui/card";
import { Button, LinkButton } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SyncForm } from "@/components/sync-form";
import { SyncBanner } from "@/components/sync-banner";
import { requireServerActionAuth } from "@/lib/auth";
import { firstSearchParam, type SearchParamValue } from "@/lib/searchParams";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Spotify settings" };

async function disconnect() {
  "use server";
  await requireServerActionAuth("/settings/spotify");
  await db.integrationCredential.deleteMany({ where: { provider: "spotify" } });
  revalidatePath("/settings/spotify");
  revalidatePath("/");
}

async function testCall() {
  "use server";
  await requireServerActionAuth("/settings/spotify");
  const token = await getValidAccessToken();
  if (!token) return;
  const res = await fetch("https://api.spotify.com/v1/me", {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(45_000),
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
  await requireServerActionAuth("/settings/spotify");
  let redirectTo: string;
  try {
    const execution = await syncSpotifyListens();
    await db.setting.upsert({
      where: { key: "spotify_last_result" },
      create: { key: "spotify_last_result", value: JSON.stringify(execution) },
      update: { value: JSON.stringify(execution) },
    });
    if (!execution.ok && execution.status === "busy") {
      redirectTo = `/settings/spotify?synced=busy&detail=${encodeURIComponent(
        `Another Spotify sync owns ${execution.leaseKey}; retry after it finishes.`
      )}`;
    } else if (!execution.ok && execution.status === "deferred") {
      redirectTo = `/settings/spotify?synced=deferred&detail=${encodeURIComponent(
        `Spotify sync was deferred during ${execution.details.phase}; the prior snapshot was preserved.`
      )}`;
    } else {
      const result = execution.data;
      const total =
        result.topLong +
        result.topMedium +
        result.topShort +
        result.recent +
        result.followed +
        result.playlists.artists;
      const params = new URLSearchParams({
        synced: execution.ok ? "ok" : "partial",
        total: String(total),
        topLong: String(result.topLong),
        topMedium: String(result.topMedium),
        topShort: String(result.topShort),
        recent: String(result.recent),
        followed: String(result.followed),
        playlists: String(result.playlists.playlists),
        playlistArtists: String(result.playlists.artists),
        incomplete: String(result.playlists.incomplete),
      });
      if (!execution.ok) {
        const names = execution.details.playlists
          .slice(0, 3)
          .map((playlist) => playlist.name)
          .join(", ");
        params.set(
          "detail",
          `${result.playlists.incomplete} playlist(s) could not be read; stale playlist data was preserved${
            names ? `: ${names}` : ""
          }. Verify playlist access and retry.`
        );
      }
      redirectTo = `/settings/spotify?${params.toString()}`;
    }
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

async function refreshTopPlaylist() {
  "use server";
  await requireServerActionAuth("/settings/spotify");
  let redirectTo: string;
  try {
    const execution = await refreshTopTracksPlaylist(50);
    if (!execution.ok) {
      let playlistStatus: string = execution.status;
      let detail: string;
      const params = new URLSearchParams();
      if (execution.status === "busy") {
        detail = `Another Spotify operation owns ${execution.leaseKey}; retry after it finishes.`;
      } else if (execution.status === "stale") {
        detail = `This playlist refresh lost the Spotify lease ${execution.leaseKey}; retry to apply a fresh snapshot.`;
      } else if (execution.status === "deferred") {
        detail = `This playlist refresh was deferred during ${execution.details.phase}; the prior playlist snapshot was preserved.`;
      } else if (
        execution.reason === "playlist_creation_outcome_uncertain"
      ) {
        playlistStatus = "uncertain";
        detail =
          "Spotify received a playlist creation request, but the response and automatic recovery were inconclusive. Inspect Spotify for a newly created playlist before retrying.";
      } else if (execution.reason === "created_playlist_incomplete") {
        playlistStatus = "recoverable";
        detail = `Spotify created playlist ${execution.data.playlistId}, but ${execution.details.phase.replaceAll("_", " ")} did not complete. The created playlist ID is retained here; open it and retry to reconcile it.`;
        params.set("playlistId", execution.data.playlistId);
        params.set("url", execution.data.playlistUrl);
      } else if (execution.reason === "external_write_outcome_uncertain") {
        playlistStatus = "uncertain";
        detail =
          "Spotify may have completed the playlist replacement, but its response was lost. Freshness was not advanced; inspect the playlist and retry.";
        params.set("playlistId", execution.data.playlistId);
        params.set("url", execution.data.playlistUrl);
      } else {
        detail =
          "Spotify completed the playlist replacement, but freshness could not be saved. Freshness was not advanced; retry.";
        params.set("playlistId", execution.data.playlistId);
        params.set("url", execution.data.playlistUrl);
      }
      params.set("playlist", playlistStatus);
      params.set("detail", detail);
      redirectTo = `/settings/spotify?${params.toString()}`;
    } else {
      const result = execution.data;
      const params = new URLSearchParams({
        playlist: "ok",
        tracks: String(result.matchedUris),
        source: String(result.sourceTracks),
        unmatched: String(result.unmatched.length),
        url: result.playlistUrl,
      });
      redirectTo = `/settings/spotify?${params.toString()}`;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    redirectTo = `/settings/spotify?playlist=error&detail=${encodeURIComponent(msg.slice(0, 200))}`;
  }
  revalidatePath("/settings/spotify");
  redirect(redirectTo);
}

export default async function SpotifySettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: SearchParamValue;
    detail?: SearchParamValue;
    synced?: SearchParamValue;
    total?: SearchParamValue;
    topLong?: SearchParamValue;
    topMedium?: SearchParamValue;
    topShort?: SearchParamValue;
    recent?: SearchParamValue;
    followed?: SearchParamValue;
    playlists?: SearchParamValue;
    playlistArtists?: SearchParamValue;
    incomplete?: SearchParamValue;
    playlist?: SearchParamValue;
    tracks?: SearchParamValue;
    source?: SearchParamValue;
    unmatched?: SearchParamValue;
    playlistId?: SearchParamValue;
    url?: SearchParamValue;
  }>;
}) {
  const rawSearchParams = await searchParams;
  const sp = Object.fromEntries(
    Object.entries(rawSearchParams).map(([key, value]) => [
      key,
      firstSearchParam(value),
    ]),
  ) as Record<keyof typeof rawSearchParams, string | undefined>;
  const { status, detail } = sp;
  const [cred, lastTest, lastSync, lastResult, signalCounts, playlistId, playlistLastSync] = await Promise.all([
    db.integrationCredential.findUnique({ where: { provider: "spotify" } }),
    db.setting.findUnique({ where: { key: "spotify_last_test" } }),
    db.setting.findUnique({ where: { key: "spotify_last_sync" } }),
    db.setting.findUnique({ where: { key: "spotify_last_result" } }),
    db.listenSignal.groupBy({
      by: ["source"],
      where: { source: { startsWith: "spotify_" } },
      _count: { _all: true },
    }),
    db.setting.findUnique({ where: { key: "top_tracks_playlist_id" } }),
    db.setting.findUnique({ where: { key: "top_tracks_playlist_last_sync" } }),
  ]);
  const playlistUrl = playlistId ? `https://open.spotify.com/playlist/${playlistId.value}` : null;
  const hasModifyScope = cred?.scope?.includes("playlist-modify-private") ?? false;

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
      {sp.synced === "busy" && (
        <SyncBanner
          tone="error"
          title="Sync already running."
          detail={sp.detail ?? "Retry shortly."}
        />
      )}
      {sp.synced === "partial" && (
        <SyncBanner
          tone="error"
          title="Listen sync incomplete."
          detail={
            sp.detail ??
            `${sp.incomplete ?? "Some"} playlist snapshot(s) were preserved but not reconciled.`
          }
        />
      )}
      {sp.playlist === "ok" && (
        <SyncBanner
          tone="success"
          title="Top-tracks playlist refreshed."
          detail={`${sp.tracks ?? "?"} tracks from ${sp.source ?? "?"} stats.fm entries${Number(sp.unmatched) > 0 ? ` · ${sp.unmatched} unmatched` : ""}`}
        />
      )}
      {sp.playlist === "error" && (
        <SyncBanner tone="error" title="Playlist refresh failed." detail={sp.detail ?? "unknown error"} />
      )}
      {(sp.playlist === "busy" || sp.playlist === "stale") && (
        <SyncBanner
          tone="error"
          title={
            sp.playlist === "busy"
              ? "Playlist refresh already running."
              : "Playlist refresh lost its lease."
          }
          detail={sp.detail ?? "Retry the playlist refresh."}
        />
      )}
      {sp.playlist === "deferred" && (
        <SyncBanner
          tone="error"
          title="Playlist refresh deferred."
          detail={sp.detail ?? "Retry with a fresh execution budget."}
        />
      )}
      {(sp.playlist === "partial" ||
        sp.playlist === "uncertain" ||
        sp.playlist === "recoverable") && (
        <>
          <SyncBanner
            tone="error"
            title={
              sp.playlist === "uncertain"
                ? "Playlist refresh outcome uncertain."
                : sp.playlist === "recoverable"
                  ? "Created playlist needs reconciliation."
                  : "Playlist refreshed, freshness not saved."
            }
            detail={sp.detail ?? "Inspect the playlist and retry."}
          />
          {sp.url && (
            <a
              href={sp.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-block text-xs text-emerald-700 hover:underline dark:text-emerald-400"
            >
              Open playlist {sp.playlistId ? `(${sp.playlistId})` : ""} ↗
            </a>
          )}
        </>
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
                  const stored = JSON.parse(lastResult.value) as {
                    status?: "completed" | "partial" | "busy";
                    data?: {
                      topLong: number; topMedium: number; topShort: number;
                      recent: number; followed: number;
                      playlists: { playlists: number; artists: number; incomplete?: number };
                    };
                    leaseKey?: string;
                    topLong: number; topMedium: number; topShort: number;
                    recent: number; followed: number;
                    playlists: { playlists: number; artists: number; incomplete?: number };
                  };
                  if (stored.status === "busy") {
                    return (
                      <p className="mt-1 text-xs text-red-700 dark:text-red-400">
                        Last result: sync already running ({stored.leaseKey ?? "lease conflict"}).
                      </p>
                    );
                  }
                  const r = stored.data ?? stored;
                  const partial =
                    stored.status === "partial" ||
                    Number(r.playlists.incomplete ?? 0) > 0;
                  return (
                    <p className={partial ? "mt-1 text-xs text-red-700 dark:text-red-400" : "mt-1 text-xs text-zinc-500"}>
                      Last result{partial ? " (incomplete)" : ""}: top {r.topLong}/{r.topMedium}/{r.topShort} · recent {r.recent} · followed {r.followed} · playlists {r.playlists.playlists} ({r.playlists.artists} artists)
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

      {cred && (
        <Card className="mt-6">
          <CardBody>
            <div className="flex items-baseline justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Top-tracks playlist</h2>
              {playlistLastSync && (
                <span className="text-xs text-zinc-500">refreshed {new Date(playlistLastSync.value).toLocaleString()}</span>
              )}
            </div>
            <p className="mt-2 text-xs text-zinc-500">
              Rebuilds a private &ldquo;My Top Songs · Last 4 Weeks&rdquo;
              playlist from stats.fm weekly data daily at 08:00 UTC.
            </p>

            {!hasModifyScope && (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                Your connection predates the playlist-write scope. Click <b>Reconnect Spotify</b> below to grant <code>playlist-modify-private</code>, then refresh.
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <SyncForm action={refreshTopPlaylist} label="Refresh now" pendingLabel="Refreshing…" size="sm" disabled={!hasModifyScope} />
              {!hasModifyScope && (
                <LinkButton href="/api/spotify/login" variant="secondary" size="sm">Reconnect Spotify</LinkButton>
              )}
              {playlistUrl && (
                <a
                  href={playlistUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-emerald-700 hover:underline dark:text-emerald-400"
                >
                  Open playlist ↗
                </a>
              )}
            </div>
          </CardBody>
        </Card>
      )}
    </main>
  );
}
