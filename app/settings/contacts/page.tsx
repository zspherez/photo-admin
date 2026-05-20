import Link from "next/link";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { listTabs, syncContactsFromSheet } from "@/lib/sheets";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

async function syncContacts(formData: FormData) {
  "use server";
  const tab = (formData.get("tab") as string) || "Artists";
  const result = await syncContactsFromSheet(tab);
  await db.setting.upsert({
    where: { key: "sheets_last_result" },
    create: { key: "sheets_last_result", value: JSON.stringify(result) },
    update: { value: JSON.stringify(result) },
  });
  revalidatePath("/settings/contacts");
  revalidatePath("/");
}

export default async function ContactsSettingsPage() {
  const hasCreds = !!process.env.GOOGLE_CREDENTIALS_JSON || !!process.env.GOOGLE_CREDENTIALS_PATH;
  const hasConfig = hasCreds && !!process.env.SPREADSHEET_ID;

  let tabs: string[] = [];
  let tabError: string | null = null;
  if (hasConfig) {
    try {
      tabs = await listTabs();
    } catch (e) {
      tabError = e instanceof Error ? e.message : String(e);
    }
  }

  const [contactCount, lastSync, lastResult, recentContacts] = await Promise.all([
    db.contact.count(),
    db.setting.findUnique({ where: { key: "sheets_last_sync" } }),
    db.setting.findUnique({ where: { key: "sheets_last_result" } }),
    db.contact.findMany({
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
      <p className="mt-1 text-sm text-zinc-500">Sync from your Google Sheet (read-only).</p>

      {!hasConfig && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          Missing env: need <code>SPREADSHEET_ID</code> plus one of <code>GOOGLE_CREDENTIALS_JSON</code> (Vercel) or <code>GOOGLE_CREDENTIALS_PATH</code> (local).
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
          <form action={syncContacts} className="mt-3 flex items-center gap-2">
            <input
              name="tab"
              defaultValue="Artists"
              placeholder="Tab name"
              className="h-9 flex-1 rounded-md border border-zinc-200 bg-white px-3 text-sm placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
            />
            <Button type="submit" variant="primary" disabled={!hasConfig}>
              Sync from Sheet
            </Button>
          </form>
          {result && (
            <pre className="mt-4 overflow-auto rounded-md bg-zinc-50 p-3 text-xs dark:bg-zinc-900">
              {JSON.stringify(result, null, 2)}
            </pre>
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
                email: string;
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
                        {c.name ? `${c.name} · ` : ""}{c.email}{c.role ? ` · ${c.role}` : ""}
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
