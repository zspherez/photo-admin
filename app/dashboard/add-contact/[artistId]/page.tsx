import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

async function createContact(formData: FormData) {
  "use server";
  const artistId = formData.get("artistId") as string;
  const email = ((formData.get("email") as string) ?? "").trim().toLowerCase();
  const name = ((formData.get("name") as string) ?? "").trim() || null;
  const role = ((formData.get("role") as string) ?? "").trim() || null;
  const customPrice = ((formData.get("customPrice") as string) ?? "").trim() || null;
  const notes = ((formData.get("notes") as string) ?? "").trim() || null;

  if (!artistId || !email) {
    redirect(`/dashboard/add-contact/${artistId}?error=missing_fields`);
  }

  await db.contact.upsert({
    where: { artistId_email: { artistId, email } },
    create: { artistId, email, name, role, customPrice, notes, source: "manual" },
    update: { name, role, customPrice, notes },
  });
  revalidatePath("/dashboard");
  revalidatePath("/settings/contacts");
  revalidatePath("/");
  redirect("/dashboard?added=1");
}

export default async function AddContactPage({
  params,
  searchParams,
}: {
  params: Promise<{ artistId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { artistId } = await params;
  const { error } = await searchParams;
  const artist = await db.artist.findUnique({
    where: { id: artistId },
    include: { contacts: true, shows: { include: { show: true } } },
  });
  if (!artist) return notFound();

  const upcomingShows = artist.shows
    .map((sa) => sa.show)
    .filter((s) => s.date >= new Date())
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <Link href="/dashboard" className="text-sm text-blue-600 hover:underline">← Dashboard</Link>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">Add contact</h1>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        Artist: <b>{artist.name}</b>
      </p>

      {upcomingShows.length > 0 && (
        <p className="mt-2 text-xs text-zinc-500">
          Upcoming shows: {upcomingShows.slice(0, 3).map((s) => `${s.venueName} ${s.date.toLocaleDateString()}`).join(" · ")}
        </p>
      )}

      {artist.contacts.length > 0 && (
        <div className="mt-4 rounded-md border border-zinc-200 px-4 py-3 text-sm dark:border-zinc-800">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Existing contacts</p>
          <ul className="mt-1 space-y-1">
            {artist.contacts.map((c) => (
              <li key={c.id} className="text-sm">
                {c.name ? `${c.name} · ` : ""}{c.email}{c.role ? ` · ${c.role}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-200">
          {error === "missing_fields" ? "Email is required." : error}
        </div>
      )}

      <form action={createContact} className="mt-6 space-y-4">
        <input type="hidden" name="artistId" value={artistId} />
        <Field name="email" label="Email" placeholder="manager@example.com" required />
        <Field name="name" label="Manager name (optional)" placeholder="Thierry" />
        <Field name="role" label="Role (optional)" placeholder="management / booking / artist" />
        <Field name="customPrice" label="Custom rate (optional)" placeholder="$400" />
        <div>
          <label htmlFor="notes" className="text-sm font-medium">Notes (optional)</label>
          <textarea
            id="notes"
            name="notes"
            rows={3}
            className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </div>
        <div className="flex gap-2">
          <button
            type="submit"
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
          >
            Save contact
          </button>
          <Link
            href="/dashboard"
            className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Cancel
          </Link>
        </div>
      </form>
    </main>
  );
}

function Field({
  name,
  label,
  placeholder,
  required,
}: {
  name: string;
  label: string;
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
        placeholder={placeholder}
        required={required}
        className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      />
    </div>
  );
}
