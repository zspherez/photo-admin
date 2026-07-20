import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { requireServerActionAuth } from "@/lib/auth";
import { firstSearchParam, type SearchParamValue } from "@/lib/searchParams";
import {
  GENERAL_SETTING_FIELDS,
  GENERAL_SETTING_KEYS,
  generalSettingsValuesFromFormData,
  saveGeneralSettingsAtomically,
} from "@/lib/generalSettings";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "General settings" };

async function saveSettings(formData: FormData) {
  "use server";
  await requireServerActionAuth("/settings/general");
  await saveGeneralSettingsAtomically(
    generalSettingsValuesFromFormData(formData),
  );
  revalidatePath("/settings/general");
  revalidatePath("/settings");
  revalidatePath("/dashboard");
  revalidatePath("/festivals");
  redirect("/settings/general?saved=1");
}

export default async function GeneralSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: SearchParamValue }>;
}) {
  const saved = firstSearchParam((await searchParams).saved);
  const rows = await db.setting.findMany({
    where: { key: { in: [...GENERAL_SETTING_KEYS] } },
  });
  const valueByKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <Link href="/settings" className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">← Settings</Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">General</h1>
      <p className="mt-1 text-sm text-zinc-500">Runtime config for templates and delivery.</p>

      {saved && (
        <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
          Saved.
        </div>
      )}

      <Card className="mt-6">
        <CardBody>
          <form action={saveSettings} className="space-y-5">
            {GENERAL_SETTING_FIELDS.map((k) => (
              <Field
                key={k.key}
                name={k.key}
                label={k.label}
                placeholder={k.placeholder}
                description={k.description}
                defaultValue={
                  valueByKey[k.key] ??
                  ("defaultValue" in k ? k.defaultValue : "")
                }
              />
            ))}
            <p className="text-xs text-zinc-500">
              Email links also receive an automatic{" "}
              <code>utm_content</code> derived from the outreach artist.
              Existing UTM parameters are preserved.
            </p>
            <Button type="submit" variant="primary">Save</Button>
          </form>
        </CardBody>
      </Card>
    </main>
  );
}
