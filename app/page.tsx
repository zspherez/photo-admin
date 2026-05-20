import Link from "next/link";
import { db } from "@/lib/db";
import { LinkButton } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [showCount, festivalCount, artistCount, contactCount, integrations, defaultTemplate] = await Promise.all([
    db.show.count({ where: { isFestival: false } }),
    db.show.count({ where: { isFestival: true } }),
    db.artist.count(),
    db.contact.count(),
    db.integrationCredential.findMany({ select: { provider: true } }),
    db.emailTemplate.findFirst({ where: { isDefault: true }, select: { id: true } }),
  ]);

  const providers = new Set(integrations.map((i: { provider: string }) => i.provider));
  const setupSteps: { label: string; done: boolean; href: string }[] = [
    { label: "Spotify connected", done: providers.has("spotify"), href: "/settings/spotify" },
    { label: "Stats.fm token saved", done: providers.has("statsfm"), href: "/settings/statsfm" },
    { label: "Contacts imported", done: contactCount > 0, href: "/settings/contacts" },
    { label: "Email template saved", done: !!defaultTemplate, href: "/settings/template" },
    { label: "EDMTrain shows fetched", done: showCount > 0, href: "/shows" },
  ];
  const doneCount = setupSteps.filter((s) => s.done).length;

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">photo-admin</h1>
          <p className="mt-2 text-sm text-zinc-500">Outreach automation for NYC EDM shows.</p>
        </div>
        <div className="flex gap-2">
          <LinkButton href="/dashboard" variant="primary">Open dashboard</LinkButton>
          <LinkButton href="/festivals" variant="secondary">Festivals</LinkButton>
        </div>
      </div>

      <section className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="NYC shows" value={showCount} />
        <Stat label="Festivals" value={festivalCount} />
        <Stat label="Artists" value={artistCount} />
        <Stat label="Contacts" value={contactCount} />
      </section>

      <section className="mt-10">
        <div className="flex items-baseline justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Setup</h2>
          <span className="text-xs text-zinc-500">{doneCount} / {setupSteps.length}</span>
        </div>
        <Card className="mt-3">
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {setupSteps.map((step) => (
              <li key={step.label} className="flex items-center justify-between px-5 py-3">
                <span className="flex items-center gap-3 text-sm">
                  <span
                    className={`inline-block h-1.5 w-1.5 rounded-full ${
                      step.done ? "bg-emerald-500" : "bg-zinc-300 dark:bg-zinc-700"
                    }`}
                  />
                  <span className={step.done ? "text-zinc-500 line-through" : "text-zinc-900 dark:text-zinc-100"}>
                    {step.label}
                  </span>
                </span>
                {step.done ? (
                  <Badge tone="success" size="xs">Ready</Badge>
                ) : (
                  <Link href={step.href} className="text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-100">
                    Set up →
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </Card>
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardBody className="p-4">
        <div className="text-2xl font-semibold tracking-tight">{value.toLocaleString()}</div>
        <div className="text-xs text-zinc-500">{label}</div>
      </CardBody>
    </Card>
  );
}
