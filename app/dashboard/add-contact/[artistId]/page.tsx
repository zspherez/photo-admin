import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { appendContactToSheet } from "@/lib/sheets";
import { Card, CardBody } from "@/components/ui/card";
import { Button, LinkButton } from "@/components/ui/button";
import { Field, TextArea } from "@/components/ui/field";
import { formatShowDate } from "@/lib/formatDate";

export const dynamic = "force-dynamic";

function parseEmails(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[\s,;]+/)
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.includes("@") && e.length >= 5)
    )
  );
}

async function createContacts(formData: FormData) {
  "use server";
  const artistId = formData.get("artistId") as string;
  const emailsRaw = ((formData.get("emails") as string) ?? "").trim();
  const phone = ((formData.get("phone") as string) ?? "").trim() || null;
  const name = ((formData.get("name") as string) ?? "").trim() || null;
  const role = ((formData.get("role") as string) ?? "").trim() || null;
  const customPrice = ((formData.get("customPrice") as string) ?? "").trim() || null;
  const notes = ((formData.get("notes") as string) ?? "").trim() || null;

  if (!artistId) {
    redirect(`/dashboard/add-contact/${artistId}?error=missing_fields`);
  }

  const emails = parseEmails(emailsRaw);
  if (emails.length === 0 && !phone) {
    redirect(`/dashboard/add-contact/${artistId}?error=missing_target`);
  }

  let createdCount = 0;
  let updatedCount = 0;
  const sheetErrors: string[] = [];

  if (emails.length === 0) {
    // Phone-only contact. No sheet sync since the sheet is keyed by email.
    await db.contact.create({
      data: { artistId, phone, name, role, customPrice, notes, source: "manual" },
    });
    createdCount++;
  } else {
    for (const email of emails) {
      const existing = await db.contact.findUnique({
        where: { artistId_email: { artistId, email } },
      });

      const contact = await db.contact.upsert({
        where: { artistId_email: { artistId, email } },
        create: { artistId, email, phone, name, role, customPrice, notes, source: "manual" },
        update: { phone, name, role, customPrice, notes },
        include: { artist: true },
      });

      if (existing) {
        updatedCount++;
      } else {
        createdCount++;
        try {
          await appendContactToSheet({
            artistName: contact.artist.name,
            email,
            managerName: name,
            role,
            customPrice,
            notes,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error("[sheet append] failed", e);
          sheetErrors.push(`${email}: ${msg.slice(0, 80)}`);
        }
      }
    }
  }

  revalidatePath("/dashboard");
  revalidatePath("/settings/contacts");
  revalidatePath("/");

  const params = new URLSearchParams();
  params.set("added", String(createdCount));
  if (updatedCount > 0) params.set("updated", String(updatedCount));
  if (sheetErrors.length) params.set("sheet_errors", sheetErrors.slice(0, 2).join(" | "));
  redirect(`/dashboard?${params.toString()}`);
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
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Add contacts</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Artist: <b>{artist.name}</b>
      </p>
      {upcomingShows.length > 0 && (
        <p className="mt-1 text-xs text-zinc-500">
          Upcoming: {upcomingShows.slice(0, 3).map((s) => `${s.venueName} ${formatShowDate(s.date, {})}`).join(" · ")}
        </p>
      )}

      {artist.contacts.length > 0 && (
        <Card className="mt-5">
          <CardBody className="p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
              Existing contacts ({artist.contacts.length})
            </p>
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
          {error === "missing_fields"
            ? "Artist is required."
            : error === "missing_target"
            ? "Add at least one email or a phone number."
            : error}
        </div>
      )}

      <Card className="mt-6">
        <CardBody>
          <form action={createContacts} className="space-y-4">
            <input type="hidden" name="artistId" value={artistId} />
            <TextArea
              name="emails"
              label="Emails (optional if phone given)"
              description="One per line. Commas, semicolons, and spaces also separate. Each becomes a contact with the shared metadata below. Duplicates are deduped. Leave empty to create a single phone-only contact."
              rows={4}
              placeholder={"manager@example.com\nbooking@example.com\nlabel@example.com"}
              mono
            />
            <Field name="phone" label="Phone (shared, for texting)" type="tel" placeholder="+1 555 123 4567" />
            <Field name="name" label="Manager name (shared)" placeholder="Thierry" />
            <Field name="role" label="Role (shared)" placeholder="management / booking / label" />
            <Field name="customPrice" label="Custom rate (shared)" placeholder="$400" />
            <TextArea name="notes" label="Notes (shared)" rows={3} />
            <p className="text-xs text-zinc-500">
              Shared fields apply to every email above. If different contacts need different
              names/roles/rates, save them, then edit each via the dashboard.
            </p>
            <div className="flex gap-2">
              <Button type="submit" variant="primary">Save contacts</Button>
              <LinkButton href="/dashboard" variant="secondary">Cancel</LinkButton>
            </div>
          </form>
        </CardBody>
      </Card>
    </main>
  );
}
