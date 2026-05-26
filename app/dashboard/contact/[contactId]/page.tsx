import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { updateContactInSheet } from "@/lib/sheets";
import { Card, CardBody } from "@/components/ui/card";
import { Button, LinkButton } from "@/components/ui/button";
import { Field, TextArea } from "@/components/ui/field";
import { formatShowDate } from "@/lib/formatDate";

export const dynamic = "force-dynamic";

async function saveContact(formData: FormData) {
  "use server";
  const contactId = formData.get("contactId") as string;
  const email = ((formData.get("email") as string) ?? "").trim().toLowerCase();
  const name = ((formData.get("name") as string) ?? "").trim() || null;
  const role = ((formData.get("role") as string) ?? "").trim() || null;
  const customPrice = ((formData.get("customPrice") as string) ?? "").trim() || null;
  const notes = ((formData.get("notes") as string) ?? "").trim() || null;

  if (!contactId || !email) {
    redirect(`/dashboard/contact/${contactId}?error=missing_fields`);
  }

  const prior = await db.contact.findUnique({
    where: { id: contactId },
    include: { artist: true },
  });
  if (!prior) {
    redirect(`/dashboard/contact/${contactId}?error=not_found`);
  }

  await db.contact.update({
    where: { id: contactId },
    data: { email, name, role, customPrice, notes },
  });

  // Push the edit to the Sheet (best-effort). Falls back to append if the
  // row isn't there (e.g. contact was originally added manually).
  try {
    await updateContactInSheet({
      artistName: prior.artist.name,
      oldEmail: prior.email,
      newEmail: email,
      managerName: name,
      role,
      customPrice,
      notes,
    });
  } catch (e) {
    console.error("[sheet update] failed", e);
  }

  revalidatePath("/dashboard");
  redirect("/dashboard?added=1");
}

async function deleteContact(formData: FormData) {
  "use server";
  const contactId = formData.get("contactId") as string;
  await db.contact.delete({ where: { id: contactId } });
  revalidatePath("/dashboard");
  redirect("/dashboard?added=1");
}

export default async function ContactEditPage({
  params,
  searchParams,
}: {
  params: Promise<{ contactId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { contactId } = await params;
  const { error } = await searchParams;
  const contact = await db.contact.findUnique({
    where: { id: contactId },
    include: { artist: true, outreaches: { include: { show: true }, orderBy: { createdAt: "desc" } } },
  });
  if (!contact) return notFound();

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <Link href="/dashboard" className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">← Dashboard</Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Edit contact</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Artist: <b>{contact.artist.name}</b>
        {contact.source && <span className="ml-2 text-xs">(source: {contact.source})</span>}
      </p>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {error === "missing_fields" ? "Email is required." : error}
        </div>
      )}

      <Card className="mt-6">
        <CardBody>
          <form action={saveContact} className="space-y-4">
            <input type="hidden" name="contactId" value={contact.id} />
            <Field name="email" label="Email" type="email" defaultValue={contact.email} required />
            <Field name="name" label="Manager name" defaultValue={contact.name ?? ""} />
            <Field name="role" label="Role" defaultValue={contact.role ?? ""} placeholder="management / booking / artist" />
            <Field name="customPrice" label="Custom rate" defaultValue={contact.customPrice ?? ""} placeholder="$400" />
            <TextArea name="notes" label="Notes" rows={3} defaultValue={contact.notes ?? ""} />
            <div className="flex gap-2">
              <Button type="submit" variant="primary">Save</Button>
              <LinkButton href="/dashboard" variant="secondary">Cancel</LinkButton>
            </div>
          </form>
        </CardBody>
      </Card>

      <form action={deleteContact} className="mt-3">
        <input type="hidden" name="contactId" value={contact.id} />
        <button type="submit" className="text-xs text-red-700 hover:underline dark:text-red-400">
          Delete contact
        </button>
      </form>

      {contact.outreaches.length > 0 && (
        <section className="mt-10">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Outreach history</h2>
          <Card className="mt-3">
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {contact.outreaches.map((o) => (
                <li key={o.id} className="px-4 py-3 text-sm">
                  <p className="font-medium">{o.show.venueName} · {formatShowDate(o.show.date, {})}</p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {o.status}{o.sentAt ? ` · sent ${o.sentAt.toLocaleString()}` : ""}
                    {o.openCount > 0 ? ` · opened ${o.openCount}x` : ""}
                    {o.clickCount > 0 ? ` · clicked ${o.clickCount}x` : ""}
                    {o.error ? ` · error: ${o.error}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}
    </main>
  );
}
