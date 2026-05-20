import Link from "next/link";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [showCount, artistCount, contactCount, integrations, defaultTemplate] = await Promise.all([
    db.show.count(),
    db.artist.count(),
    db.contact.count(),
    db.integrationCredential.findMany({ select: { provider: true, updatedAt: true } }),
    db.emailTemplate.findFirst({ where: { isDefault: true }, select: { id: true } }),
  ]);

  const providers = new Set(integrations.map((i: { provider: string }) => i.provider));
  const setupSteps: { label: string; done: boolean; href?: string }[] = [
    { label: "Spotify connected", done: providers.has("spotify"), href: "/settings/spotify" },
    { label: "Stats.fm token saved", done: providers.has("statsfm"), href: "/settings/statsfm" },
    { label: "Contacts imported", done: contactCount > 0, href: "/settings/contacts" },
    { label: "Email template saved", done: !!defaultTemplate, href: "/settings/template" },
    { label: "EDMTrain shows fetched", done: showCount > 0, href: "/shows" },
  ];

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">photo-admin</h1>
      <p className="mt-2 text-zinc-600 dark:text-zinc-400">
        Outreach automation for NYC EDM shows.
      </p>

      <section className="mt-10">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">Setup</h2>
        <ul className="mt-3 divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {setupSteps.map((step) => (
            <li key={step.label} className="flex items-center justify-between px-4 py-3">
              <span className="flex items-center gap-3">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${
                    step.done ? "bg-emerald-500" : "bg-zinc-300 dark:bg-zinc-700"
                  }`}
                />
                <span className={step.done ? "text-zinc-500 line-through" : ""}>{step.label}</span>
              </span>
              {step.href && !step.done && (
                <Link href={step.href} className="text-sm font-medium text-blue-600 hover:underline">
                  Set up →
                </Link>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-10 grid grid-cols-3 gap-4">
        <Stat label="Shows" value={showCount} />
        <Stat label="Artists" value={artistCount} />
        <Stat label="Contacts" value={contactCount} />
      </section>

      <section className="mt-8 flex flex-wrap gap-2">
        <Link
          href="/dashboard"
          className="inline-block rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
        >
          Matched shows →
        </Link>
        <Link
          href="/festivals"
          className="inline-block rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
        >
          Festivals →
        </Link>
        <Link
          href="/settings"
          className="inline-block rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          Settings
        </Link>
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800">
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-sm text-zinc-500">{label}</div>
    </div>
  );
}
