import Link from "next/link";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { listTabs, syncContactsFromSheet } from "@/lib/sheets";

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
    <main className="mx-auto max-w-3xl px-6 py-12">
      <Link href="/" className="text-sm text-blue-600 hover:underline">← Home</Link>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">Contacts</h1>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        Sync from your Google Sheet (read-only). Edit per-artist overrides here.
      </p>

      {!hasConfig && (
        <div className="mt-6 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          Missing env: need <code>SPREADSHEET_ID</code> plus one of{" "}
          <code>GOOGLE_CREDENTIALS_JSON</code> (Vercel) or <code>GOOGLE_CREDENTIALS_PATH</code> (local).
        </div>
      )}
      {tabError && (
        <div className="mt-6 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-200">
          Sheets API error: {tabError}
        </div>
      )}

      <section className="mt-8 rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">Sync</h2>
        <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
          {contactCount} contacts stored
          {lastSync && (
            <> · last sync {new Date(lastSync.value).toLocaleString()}</>
          )}
        </p>
        {tabs.length > 0 && (
          <p className="mt-1 text-xs text-zinc-500">
            Tabs found: {tabs.join(", ")}
          </p>
        )}
        <form action={syncContacts} className="mt-4 flex items-center gap-2">
          <input
            name="tab"
            defaultValue="Artists"
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            placeholder="Tab name"
          />
          <button
            type="submit"
            disabled={!hasConfig}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-zinc-300"
          >
            Sync from Sheet
          </button>
        </form>
        {result && (
          <pre className="mt-4 overflow-auto rounded bg-zinc-100 p-3 text-xs dark:bg-zinc-900">
            {JSON.stringify(result, null, 2)}
          </pre>
        )}
      </section>

      {recentContacts.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
            Recent contacts
          </h2>
          <ul className="mt-3 divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {recentContacts.map((c: {
              id: string;
              email: string;
              name: string | null;
              role: string | null;
              customPrice: string | null;
              artist: { name: string };
            }) => (
              <li key={c.id} className="px-4 py-3 text-sm">
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{c.artist.name}</p>
                    <p className="truncate text-xs text-zinc-500">
                      {c.name ? `${c.name} · ` : ""}
                      {c.email}
                      {c.role ? ` · ${c.role}` : ""}
                    </p>
                  </div>
                  {c.customPrice && (
                    <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                      {c.customPrice}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
