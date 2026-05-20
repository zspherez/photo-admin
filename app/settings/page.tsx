import Link from "next/link";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function SettingsIndex() {
  const [spotify, statsfm, contactCount, template, showCount, settings] = await Promise.all([
    db.integrationCredential.findUnique({ where: { provider: "spotify" } }),
    db.integrationCredential.findUnique({ where: { provider: "statsfm" } }),
    db.contact.count(),
    db.emailTemplate.findFirst({ where: { isDefault: true } }),
    db.show.count({ where: { date: { gte: new Date() } } }),
    db.setting.findMany({ where: { key: { in: ["portfolio_url", "default_rate", "venue_blocklist"] } } }),
  ]);
  const settingMap = Object.fromEntries(settings.map((s) => [s.key, s.value]));

  const cards: { title: string; href: string; status: string; ok: boolean }[] = [
    { title: "General", href: "/settings/general", status: `${Object.keys(settingMap).length}/3 set`, ok: Object.keys(settingMap).length === 3 },
    { title: "Spotify", href: "/settings/spotify", status: spotify ? "Connected" : "Not connected", ok: !!spotify },
    { title: "Stats.fm", href: "/settings/statsfm", status: statsfm ? "Connected" : "Not connected", ok: !!statsfm },
    { title: "Contacts (Sheets)", href: "/settings/contacts", status: `${contactCount} contacts`, ok: contactCount > 0 },
    { title: "Email template", href: "/settings/template", status: template ? "Saved" : "Not saved", ok: !!template },
    { title: "Shows (EDMTrain)", href: "/shows", status: `${showCount} upcoming`, ok: showCount > 0 },
  ];

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <Link href="/" className="text-sm text-blue-600 hover:underline">← Home</Link>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">Settings</h1>
      <div className="mt-6 flex justify-end">
        <form action="/api/auth/logout" method="post">
          <button
            type="submit"
            className="text-xs text-zinc-500 hover:underline"
          >
            Log out
          </button>
        </form>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {cards.map((c) => (
          <Link
            key={c.href}
            href={c.href}
            className="rounded-lg border border-zinc-200 p-4 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
          >
            <div className="flex items-center justify-between">
              <span className="font-medium">{c.title}</span>
              <span className={`inline-block h-2 w-2 rounded-full ${c.ok ? "bg-emerald-500" : "bg-zinc-300 dark:bg-zinc-700"}`} />
            </div>
            <p className="mt-1 text-xs text-zinc-500">{c.status}</p>
          </Link>
        ))}
      </div>
    </main>
  );
}
