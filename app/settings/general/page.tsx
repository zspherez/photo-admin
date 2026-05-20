import Link from "next/link";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";

export const dynamic = "force-dynamic";

const KEYS = [
  {
    key: "portfolio_url",
    label: "Portfolio URL",
    placeholder: "https://rehders.photos",
    description: "Substituted into {{portfolio_url}} in email templates.",
  },
  {
    key: "default_rate",
    label: "Default rate",
    placeholder: "$200",
    description: "Used for {{rate}} when a contact has no customPrice.",
  },
  {
    key: "venue_blocklist",
    label: "Venue blocklist",
    placeholder: "montauk, surf lodge",
    description: "Comma-separated substrings (case-insensitive). EDMTrain shows whose venue matches are filtered out.",
  },
] as const;

async function saveSettings(formData: FormData) {
  "use server";
  for (const k of KEYS) {
    const value = ((formData.get(k.key) as string) ?? "").trim();
    if (value) {
      await db.setting.upsert({
        where: { key: k.key },
        create: { key: k.key, value },
        update: { value },
      });
    } else {
      await db.setting.deleteMany({ where: { key: k.key } });
    }
  }
  revalidatePath("/settings/general");
  revalidatePath("/settings");
}

export default async function GeneralSettingsPage() {
  const rows = await db.setting.findMany({ where: { key: { in: KEYS.map((k) => k.key) } } });
  const valueByKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <Link href="/settings" className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">← Settings</Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">General</h1>
      <p className="mt-1 text-sm text-zinc-500">Runtime config. Blank fields fall back to placeholder defaults.</p>

      <Card className="mt-6">
        <CardBody>
          <form action={saveSettings} className="space-y-5">
            {KEYS.map((k) => (
              <Field
                key={k.key}
                name={k.key}
                label={k.label}
                placeholder={k.placeholder}
                description={k.description}
                defaultValue={valueByKey[k.key] ?? ""}
              />
            ))}
            <Button type="submit" variant="primary">Save</Button>
          </form>
        </CardBody>
      </Card>
    </main>
  );
}
