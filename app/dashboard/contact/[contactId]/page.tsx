import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";

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

  await db.contact.update({
    where: { id: contactId },
    data: { email, name, role, customPrice, notes },
  });
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
    <main className="mx-auto max-w-2xl px-6 py-12">
      <Link href="/dashboard" className="text-sm text-blue-600 hover:underline">← Dashboard</Link>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">Edit contact</h1>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        Artist: <b>{contact.artist.name}</b>
        {contact.source && <span className="ml-2 text-xs text-zinc-500">(source: {contact.source})</span>}
      </p>

      {error && (
        <div className="mt-4 rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-200">
          {error === "missing_fields" ? "Email is required." : error}
        </div>
      )}

      <form action={saveContact} className="mt-6 space-y-4">
        <input type="hidden" name="contactId" value={contact.id} />
        <Field name="email" label="Email" defaultValue={contact.email} required />
        <Field name="name" label="Manager name" defaultValue={contact.name ?? ""} />
        <Field name="role" label="Role" defaultValue={contact.role ?? ""} placeholder="management / booking / artist" />
        <Field name="customPrice" label="Custom rate" defaultValue={contact.customPrice ?? ""} placeholder="$400" />
        <div>
          <label htmlFor="notes" className="text-sm font-medium">Notes</label>
          <textarea
            id="notes"
            name="notes"
            rows={3}
            defaultValue={contact.notes ?? ""}
            className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </div>
        <div className="flex items-center justify-between gap-2">
          <div className="flex gap-2">
            <button type="submit" className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700">
              Save
            </button>
            <Link href="/dashboard" className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900">
              Cancel
            </Link>
          </div>
        </div>
      </form>

      <form action={deleteContact} className="mt-4">
        <input type="hidden" name="contactId" value={contact.id} />
        <button
          type="submit"
          className="text-xs text-red-700 hover:underline dark:text-red-400"
        >
          Delete contact
        </button>
      </form>

      {contact.outreaches.length > 0 && (
        <section className="mt-10">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">Outreach history</h2>
          <ul className="mt-3 divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {contact.outreaches.map((o) => (
              <li key={o.id} className="px-4 py-3 text-sm">
                <p className="font-medium">{o.show.venueName} · {o.show.date.toLocaleDateString()}</p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  {o.status}{o.sentAt ? ` · sent ${o.sentAt.toLocaleString()}` : ""}
                  {o.openCount > 0 ? ` · opened ${o.openCount}x` : ""}
                  {o.clickCount > 0 ? ` · clicked ${o.clickCount}x` : ""}
                  {o.error ? ` · error: ${o.error}` : ""}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

function Field({
  name,
  label,
  defaultValue,
  placeholder,
  required,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <div>
      <label htmlFor={name} className="text-sm font-medium">{label}</label>
      <input
        id={name}
        name={name}
        type={name === "email" ? "email" : "text"}
        defaultValue={defaultValue}
        placeholder={placeholder}
        required={required}
        className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      />
    </div>
  );
}
