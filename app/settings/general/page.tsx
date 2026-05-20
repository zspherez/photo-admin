import Link from "next/link";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const KEYS = [
  {
    key: "portfolio_url",
    label: "Portfolio URL",
    placeholder: "https://rehders.photos",
    fallback: "https://rehders.photos",
    description: "Substituted into {{portfolio_url}} in email templates.",
  },
  {
    key: "default_rate",
    label: "Default rate",
    placeholder: "$200",
    fallback: "$200",
    description: "Used for {{rate}} when a contact has no customPrice. Currently unused in the default template body.",
  },
  {
    key: "venue_blocklist",
    label: "Venue blocklist",
    placeholder: "montauk, surf lodge",
    fallback: "montauk, surf lodge",
    description: "Comma-separated substrings (case-insensitive). EDMTrain shows whose venue contains any of these are filtered out.",
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
    <main className="mx-auto max-w-2xl px-6 py-12">
      <Link href="/settings" className="text-sm text-blue-600 hover:underline">← Settings</Link>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">General</h1>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        Runtime config. Blank fields fall back to the placeholder default.
      </p>

      <form action={saveSettings} className="mt-8 space-y-6">
        {KEYS.map((k) => (
          <div key={k.key}>
            <label htmlFor={k.key} className="text-sm font-medium">{k.label}</label>
            <input
              id={k.key}
              name={k.key}
              defaultValue={valueByKey[k.key] ?? ""}
              placeholder={k.placeholder}
              className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            <p className="mt-1 text-xs text-zinc-500">{k.description}</p>
          </div>
        ))}
        <button
          type="submit"
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
        >
          Save
        </button>
      </form>
    </main>
  );
}
