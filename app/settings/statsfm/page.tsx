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
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TextArea } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { SyncForm } from "@/components/sync-form";
import { SyncBanner } from "@/components/sync-banner";

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
  if (!cred?.meta) redirect("/settings/statsfm?synced=error&detail=not_connected");
  const { userId } = JSON.parse(cred!.meta!);
  let redirectTo: string;
  try {
    const result = await syncStatsfmTopArtists(userId, "lifetime", 500);
    const params = new URLSearchParams({
      synced: "ok",
      fetched: String(result.fetched),
      written: String(result.written),
    });
    redirectTo = `/settings/statsfm?${params.toString()}`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    redirectTo = `/settings/statsfm?synced=error&detail=${encodeURIComponent(msg.slice(0, 200))}`;
  }
  revalidatePath("/settings/statsfm");
  revalidatePath("/");
  redirect(redirectTo);
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
  searchParams: Promise<{ rotate?: string; detail?: string; synced?: string; fetched?: string; written?: string }>;
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
  // eslint-disable-next-line react-hooks/purity -- async Server Component, runs per-request
  const now = Date.now();
  const hoursUntilExpiry = expiresAt ? (expiresAt.getTime() - now) / 3600_000 : null;
  const expiryClass =
    hoursUntilExpiry === null
      ? "text-zinc-500"
      : hoursUntilExpiry < 0
      ? "text-red-700 dark:text-red-400"
      : hoursUntilExpiry < 24
      ? "text-amber-700 dark:text-amber-400"
      : "text-emerald-700 dark:text-emerald-400";
  const rotatedViaUI = !!(cred?.accessToken && cred.accessToken !== process.env.STATSFM_TOKEN);

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <Link href="/settings" className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">← Settings</Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Stats.fm</h1>
      <p className="mt-1 text-sm text-zinc-500">Lifetime listening history. Tokens expire every ~7 days — rotate below.</p>

      {sp.rotate === "ok" && <SyncBanner tone="success" title="New token saved." />}
      {sp.rotate === "error" && (
        <SyncBanner tone="error" title="Token rejected." detail={sp.detail ?? undefined} />
      )}
      {sp.rotate === "missing" && <SyncBanner tone="error" title="Paste a token first." />}
      {sp.synced === "ok" && (
        <SyncBanner
          tone="success"
          title="Lifetime top artists synced."
          detail={`${sp.fetched ?? "?"} fetched · ${sp.written ?? "?"} written`}
        />
      )}
      {sp.synced === "error" && (
        <SyncBanner tone="error" title="Sync failed." detail={sp.detail ?? "unknown error"} />
      )}

      <Card className="mt-6">
        <CardBody>
          {meta ? (
            <>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
                  <span className="text-sm font-medium">{meta.displayName} ({meta.userId})</span>
                </div>
                <div className="flex gap-1.5">
                  {meta.isPlus && <Badge tone="success" size="xs">Plus</Badge>}
                  {rotatedViaUI && <Badge tone="muted" size="xs">UI</Badge>}
                </div>
              </div>
              <p className={cn("mt-2 text-xs", expiryClass)}>
                Token{" "}
                {hoursUntilExpiry === null
                  ? "expiry unknown"
                  : hoursUntilExpiry < 0
                  ? `expired ${Math.abs(Math.round(hoursUntilExpiry))}h ago`
                  : `expires in ${Math.round(hoursUntilExpiry)}h · ${expiresAt!.toLocaleString()}`}
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                {lifetimeCount.toLocaleString()} lifetime top artists stored
                {lifetimeSync && <> · last sync {new Date(lifetimeSync.value).toLocaleString()}</>}
              </p>

              <div className="mt-4 flex flex-wrap gap-2">
                <SyncForm action={syncLifetime} label="Sync lifetime top 500" pendingLabel="Syncing…" size="sm" />
                <form action={disconnect}>
                  <Button type="submit" variant="danger" size="sm">Disconnect</Button>
                </form>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">Not connected.</p>
              <p className="mt-1 text-xs text-zinc-500">
                {hasEnvToken
                  ? "Token in .env — click Test & save."
                  : "Paste a token below (or add STATSFM_TOKEN to env)."}
              </p>
              {hasEnvToken && (
                <form action={testAndSave} className="mt-3">
                  <Button type="submit" variant="primary">Test &amp; save</Button>
                </form>
              )}
            </>
          )}
        </CardBody>
      </Card>

      <Card className="mt-6">
        <CardBody>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Rotate token</h2>
          <p className="mt-2 text-xs text-zinc-500">
            Paste a fresh Stats.fm JWT (stats.fm DevTools → Application → Local Storage → <code>token</code>). Validated against <code>/me</code> before saving.
          </p>
          <form action={rotateToken} className="mt-3 space-y-2">
            <TextArea name="token" label="" rows={3} placeholder="eyJhbGciOiJIUzI1NiIs..." mono />
            <Button type="submit" variant="primary">Save new token</Button>
          </form>
        </CardBody>
      </Card>
    </main>
  );
}
