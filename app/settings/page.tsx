import type { Metadata } from "next";
import { db } from "@/lib/db";
import { CardLink } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { easternTodayStoredDate } from "@/lib/calendarDate";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Settings" };

export default async function SettingsIndex() {
  const [spotify, statsfm, contactCount, template, showCount, settings] = await Promise.all([
    db.integrationCredential.findUnique({ where: { provider: "spotify" } }),
    db.integrationCredential.findUnique({ where: { provider: "statsfm" } }),
    db.contact.count({ where: { state: "active" } }),
    db.emailTemplate.findFirst({ where: { isDefault: true } }),
    db.show.count({
      where: {
        date: { gte: easternTodayStoredDate() },
        isFestival: false,
        syncStatus: "active",
      },
    }),
    db.setting.findMany({ where: { key: { in: ["portfolio_url", "default_rate", "venue_blocklist"] } } }),
  ]);
  const settingMap = Object.fromEntries(settings.map((s) => [s.key, s.value]));

  const cards: { title: string; href: string; status: string; ok: boolean; description: string }[] = [
    {
      title: "General",
      href: "/settings/general",
      status: `${Object.keys(settingMap).length}/3 set`,
      ok: Object.keys(settingMap).length === 3,
      description: "Portfolio URL, default rate, venue blocklist.",
    },
    {
      title: "Spotify",
      href: "/settings/spotify",
      status: spotify ? "Connected" : "Not connected",
      ok: !!spotify,
      description: "Top artists, recent plays, follows, playlists.",
    },
    {
      title: "Stats.fm",
      href: "/settings/statsfm",
      status: statsfm ? "Connected" : "Not connected",
      ok: !!statsfm,
      description: "Lifetime listening history. Rotate token here.",
    },
    {
      title: "Contacts",
      href: "/settings/contacts",
      status: `${contactCount.toLocaleString()} contacts`,
      ok: contactCount > 0,
      description: "Sync from Google Sheet.",
    },
    {
      title: "Email template",
      href: "/settings/template",
      status: template ? "Saved" : "Not saved",
      ok: !!template,
      description: "Subject + HTML body with variables.",
    },
    {
      title: "EDMTrain shows",
      href: "/shows",
      status: `${showCount.toLocaleString()} upcoming`,
      ok: showCount > 0,
      description: "All NYC shows including non-matched.",
    },
  ];

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="mt-1 text-sm text-zinc-500">Integrations + runtime config.</p>
        </div>
        <form action="/api/auth/logout" method="post">
          <button
            type="submit"
            className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200"
          >
            Log out
          </button>
        </form>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c) => (
          <CardLink key={c.href} href={c.href} className="p-5">
            <div className="flex items-start justify-between gap-2">
              <span className="font-medium">{c.title}</span>
              <Badge tone={c.ok ? "success" : "default"} size="xs">
                {c.ok ? "Ready" : "Setup"}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-zinc-500">{c.status}</p>
            <p className="mt-2 text-xs text-zinc-500">{c.description}</p>
          </CardLink>
        ))}
      </div>
    </main>
  );
}
