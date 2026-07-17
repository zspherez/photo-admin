import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  getConfiguredSheetTarget,
  listTabs,
  syncContactsFromSheet,
} from "@/lib/sheets";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SyncForm } from "@/components/sync-form";
import { SyncBanner } from "@/components/sync-banner";
import { requireServerActionAuth } from "@/lib/auth";
import { firstSearchParam, type SearchParamValue } from "@/lib/searchParams";
import {
  contactDisplayValue,
  directOutreachNoteValue,
  hasDirectOutreachNote,
  isDirectOutreachOnly,
} from "@/lib/contactDisplay";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Contact sync" };

async function syncContacts(formData: FormData) {
  "use server";
  await requireServerActionAuth("/settings/contacts");
  const rawTab = formData.get("tab");
  const tab = typeof rawTab === "string" ? rawTab.trim() : "";
  let redirectTo: string;
  try {
    if (!tab) throw new Error("Google Sheet tab is required");
    const result = await syncContactsFromSheet(tab);
    await db.setting.upsert({
      where: { key: "sheets_last_result" },
      create: { key: "sheets_last_result", value: JSON.stringify(result) },
      update: { value: JSON.stringify(result) },
    });
    const params = new URLSearchParams({
      synced: "ok",
      read: String(result.read),
      upserted: String(result.contactsUpserted),
      artists: String(result.artistsCreated),
      skipped: String(result.skipped),
    });
    redirectTo = `/settings/contacts?${params.toString()}`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    redirectTo = `/settings/contacts?synced=error&detail=${encodeURIComponent(msg.slice(0, 200))}`;
  }
  revalidatePath("/settings/contacts");
  revalidatePath("/");
  redirect(redirectTo);
}

export default async function ContactsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    synced?: SearchParamValue;
    read?: SearchParamValue;
    upserted?: SearchParamValue;
    artists?: SearchParamValue;
    skipped?: SearchParamValue;
    detail?: SearchParamValue;
  }>;
}) {
  const rawSearchParams = await searchParams;
  const sp = {
    synced: firstSearchParam(rawSearchParams.synced),
    read: firstSearchParam(rawSearchParams.read),
    upserted: firstSearchParam(rawSearchParams.upserted),
    artists: firstSearchParam(rawSearchParams.artists),
    skipped: firstSearchParam(rawSearchParams.skipped),
    detail: firstSearchParam(rawSearchParams.detail),
  };
  const hasCreds =
    !!process.env.GOOGLE_CREDENTIALS_JSON ||
    !!process.env.GOOGLE_CREDENTIALS_PATH;
  let configuredTarget: Awaited<
    ReturnType<typeof getConfiguredSheetTarget>
  > = null;
  let targetError: string | null = null;
  try {
    configuredTarget = await getConfiguredSheetTarget();
  } catch (error) {
    targetError = error instanceof Error ? error.message : String(error);
  }
  const sheetId =
    configuredTarget?.spreadsheetId ?? process.env.SPREADSHEET_ID?.trim();
  const hasConfig = hasCreds && !!sheetId && !targetError;

  let tabs: string[] = [];
  let tabError: string | null = null;
  if (hasConfig) {
    try {
      tabs = await listTabs(sheetId!);
    } catch (e) {
      tabError = e instanceof Error ? e.message : String(e);
    }
  }

  const [contactCount, lastSync, lastResult, recentContacts] = await Promise.all([
    db.contact.count({ where: { state: "active" } }),
    db.setting.findUnique({ where: { key: "sheets_last_sync" } }),
    db.setting.findUnique({ where: { key: "sheets_last_result" } }),
    db.contact.findMany({
      where: { state: "active" },
      take: 25,
      orderBy: { updatedAt: "desc" },
      include: { artist: true },
    }),
  ]);

  const result = lastResult ? JSON.parse(lastResult.value) : null;

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Link href="/settings" className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">← Settings</Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Contacts</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Sync writes stable <code>photo_admin_id</code> values to the Sheet, so
        the service account needs Editor access.
      </p>

      {sp.synced === "ok" && (
        <SyncBanner
          tone="success"
          title="Sync complete."
          detail={`${sp.read ?? "?"} rows read · ${sp.upserted ?? "?"} contacts upserted · ${sp.artists ?? "?"} new artists · ${sp.skipped ?? "?"} skipped`}
        />
      )}
      {sp.synced === "error" && (
        <SyncBanner tone="error" title="Sync failed." detail={sp.detail ?? "unknown error"} />
      )}

      {!hasConfig && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          Google Sheets needs a configured spreadsheet plus one of <code>GOOGLE_CREDENTIALS_JSON</code> (Vercel) or <code>GOOGLE_CREDENTIALS_PATH</code> (local).
        </div>
      )}
      {targetError && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          Sheets target error: {targetError}
        </div>
      )}
      {tabError && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          Sheets API error: {tabError}
        </div>
      )}

      <Card className="mt-6">
        <CardBody>
          <div className="flex items-baseline justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Sync</h2>
            <span className="text-xs text-zinc-500">
              {contactCount.toLocaleString()} contacts
              {lastSync && <> · {new Date(lastSync.value).toLocaleString()}</>}
            </span>
          </div>
          {tabs.length > 0 && (
            <p className="mt-2 text-xs text-zinc-500">Tabs: {tabs.join(", ")}</p>
          )}
          {configuredTarget && (
            <p className="mt-2 text-xs text-zinc-500">
              Configured tab: {configuredTarget.tabName}
            </p>
          )}
          <SyncForm action={syncContacts} label="Sync from Sheet" pendingLabel="Syncing…" disabled={!hasConfig} className="mt-3 flex items-center gap-2">
            <input
              name="tab"
              defaultValue={configuredTarget?.tabName ?? ""}
              placeholder="Tab name"
              className="h-9 flex-1 rounded-md border border-zinc-200 bg-white px-3 text-sm placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
            />
          </SyncForm>
          {result && (
            <p className="mt-3 text-xs text-zinc-500">
              Last result: {result.read} rows read · {result.contactsUpserted} contacts upserted · {result.artistsCreated} new artists · {result.skipped} skipped
            </p>
          )}
        </CardBody>
      </Card>

      {recentContacts.length > 0 && (
        <section className="mt-8">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Recent contacts</h2>
          <Card className="mt-3">
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {recentContacts.map((c: {
                id: string;
                email: string | null;
                phone: string | null;
                directOutreachNote: string | null;
                name: string | null;
                role: string | null;
                customPrice: string | null;
                artist: { name: string };
              }) => (
                <li key={c.id} className="px-4 py-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{c.artist.name}</p>
                      <p className="truncate text-xs text-zinc-500">
                        {c.name ? `${c.name} · ` : ""}
                        {contactDisplayValue(c, "—")}
                        {hasDirectOutreachNote(c) &&
                        !isDirectOutreachOnly(c)
                          ? ` · ${directOutreachNoteValue(c)}`
                          : ""}
                        {hasDirectOutreachNote(c) ? " · direct outreach" : ""}
                        {c.role ? ` · ${c.role}` : ""}
                      </p>
                    </div>
                    {c.customPrice && (
                      <Badge tone="default">{c.customPrice}</Badge>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}
    </main>
  );
}
