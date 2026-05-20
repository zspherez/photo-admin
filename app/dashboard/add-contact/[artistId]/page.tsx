import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { Card, CardBody } from "@/components/ui/card";
import { Button, LinkButton } from "@/components/ui/button";
import { Field, TextArea } from "@/components/ui/field";

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
    <main className="mx-auto max-w-2xl px-6 py-10">
      <Link href="/dashboard" className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">← Dashboard</Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Add contact</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Artist: <b>{artist.name}</b>
      </p>
      {upcomingShows.length > 0 && (
        <p className="mt-1 text-xs text-zinc-500">
          Upcoming: {upcomingShows.slice(0, 3).map((s) => `${s.venueName} ${s.date.toLocaleDateString()}`).join(" · ")}
        </p>
      )}

      {artist.contacts.length > 0 && (
        <Card className="mt-5">
          <CardBody className="p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Existing contacts</p>
            <ul className="mt-2 space-y-1 text-sm">
              {artist.contacts.map((c) => (
                <li key={c.id}>
                  {c.name ? `${c.name} · ` : ""}{c.email}{c.role ? ` · ${c.role}` : ""}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {error === "missing_fields" ? "Email is required." : error}
        </div>
      )}

      <Card className="mt-6">
        <CardBody>
          <form action={createContact} className="space-y-4">
            <input type="hidden" name="artistId" value={artistId} />
            <Field name="email" label="Email" type="email" placeholder="manager@example.com" required />
            <Field name="name" label="Manager name" placeholder="Thierry" />
            <Field name="role" label="Role" placeholder="management / booking / artist" />
            <Field name="customPrice" label="Custom rate" placeholder="$400" />
            <TextArea name="notes" label="Notes" rows={3} />
            <div className="flex gap-2">
              <Button type="submit" variant="primary">Save contact</Button>
              <LinkButton href="/dashboard" variant="secondary">Cancel</LinkButton>
            </div>
          </form>
        </CardBody>
      </Card>
    </main>
  );
}
