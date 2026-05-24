import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";

export const dynamic = "force-dynamic";

const KEYS = [
  {
    key: "sender_name",
    label: "Your name",
    placeholder: "Jane Doe",
    description: "Substituted into {{sender_name}} in email templates (signature, etc.).",
  },
  {
    key: "sender_email",
    label: "Your email",
    placeholder: "you@example.com",
    description: "Substituted into {{sender_email}} in email templates.",
  },
  {
    key: "sender_phone",
    label: "Your phone",
    placeholder: "+1.555.555.5555",
    description: "Substituted into {{sender_phone}} in email templates.",
  },
  {
    key: "sender_city",
    label: "Your city",
    placeholder: "NYC",
    description: "Substituted into {{sender_city}} (used in the default template's pitch line).",
  },
  {
    key: "portfolio_url",
    label: "Portfolio URL",
    placeholder: "https://example.com",
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
    placeholder: "venue one, venue two",
    description: "Comma-separated substrings (case-insensitive). EDMTrain shows whose venue matches are filtered out.",
  },
  {
    key: "test_override_email",
    label: "Test mode — redirect all sends to",
    placeholder: "you+test@example.com",
    description:
      "When set, every send goes here instead of the real contacts (subject prefixed with [TEST → original]). Leave blank to send to real contacts. Overrides SEND_TEST_OVERRIDE env.",
  },
  {
    key: "bcc_emails",
    label: "BCC me on every send",
    placeholder: "you@example.com",
    description:
      "Comma-separated. Added as BCC on every real send (skipped when test mode is on, to avoid CC-ing yourself on tests).",
  },
] as const;

async function saveSettings(formData: FormData) {
  "use server";
  for (const k of KEYS) {
    const value = ((formData.get(k.key) as string) ?? "").trim();
    // For test_override_email + bcc_emails, an explicit empty value still
    // wins over env fallback (we upsert empty rather than delete). For other
    // keys with placeholder fallbacks, deleting the row reverts to default.
    const preserveEmptyRow = k.key === "test_override_email" || k.key === "bcc_emails";
    if (value || preserveEmptyRow) {
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
  revalidatePath("/dashboard");
  revalidatePath("/festivals");
  redirect("/settings/general?saved=1");
}

export default async function GeneralSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string }>;
}) {
  const sp = await searchParams;
  const rows = await db.setting.findMany({ where: { key: { in: KEYS.map((k) => k.key) } } });
  const valueByKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <Link href="/settings" className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">← Settings</Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">General</h1>
      <p className="mt-1 text-sm text-zinc-500">Runtime config. Blank fields fall back to placeholder defaults.</p>

      {sp.saved && (
        <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
          Saved.
        </div>
      )}

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
