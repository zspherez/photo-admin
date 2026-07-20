import type { Metadata } from "next";
import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { cache } from "react";
import { db } from "@/lib/db";
import { appendContactToSheet, updateContactInSheet } from "@/lib/sheets";
import { Card, CardBody } from "@/components/ui/card";
import { LinkButton } from "@/components/ui/button";
import { Field, TextArea } from "@/components/ui/field";
import { formatShowDate } from "@/lib/formatDate";
import { easternTodayStoredDate } from "@/lib/calendarDate";
import {
  appendWorkflowResult,
  workflowReturnPath,
} from "@/lib/dashboardReturnUrl";
import { withWorkflowReturnTo } from "@/lib/workflowLinks";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { requireServerActionAuth } from "@/lib/auth";
import { firstSearchParam, type SearchParamValue } from "@/lib/searchParams";
import { refreshWorkflowViews } from "@/lib/workflowRefresh";
import {
  contactDisplayValue,
  directOutreachNoteValue,
  hasDirectOutreachNote,
  isDirectOutreachOnly,
} from "@/lib/contactDisplay";
import { satisfiesFestivalLeadTime } from "@/lib/festivalEligibility";

export const dynamic = "force-dynamic";

const getArtistForContact = cache(async (artistId: string) =>
  db.artist.findUnique({
    where: { id: artistId },
    include: {
      contacts: { where: { state: "active" } },
      shows: { include: { show: true } },
    },
  }),
);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ artistId: string }>;
}): Promise<Metadata> {
  const { artistId } = await params;
  const artist = await getArtistForContact(artistId);
  return {
    title: artist ? `Add contacts for ${artist.name}` : "Add contacts",
  };
}

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
  await requireServerActionAuth(formData.get("returnTo") ?? "/dashboard");
  const artistId = formData.get("artistId") as string;
  const returnTo = workflowReturnPath(formData.get("returnTo"));
  const emailsRaw = ((formData.get("emails") as string) ?? "").trim();
  const phone = ((formData.get("phone") as string) ?? "").trim() || null;
  const directOutreachNote =
    ((formData.get("directOutreachNote") as string) ?? "").trim() || null;
  const name = ((formData.get("name") as string) ?? "").trim() || null;
  const role = "management";
  const customPrice = ((formData.get("customPrice") as string) ?? "").trim() || null;
  const notes = ((formData.get("notes") as string) ?? "").trim() || null;

  if (!artistId) {
    redirect(
      `${withWorkflowReturnTo(
        `/dashboard/add-contact/${encodeURIComponent(artistId)}`,
        returnTo
      )}&error=missing_fields`
    );
  }

  const emails = parseEmails(emailsRaw);
  if (
    (emails.length === 0 && !phone && !directOutreachNote) ||
    (emails.length > 0 && directOutreachNote)
  ) {
    redirect(
      `${withWorkflowReturnTo(
        `/dashboard/add-contact/${encodeURIComponent(artistId)}`,
        returnTo
      )}&error=${
        emails.length > 0 && directOutreachNote
          ? "conflicting_targets"
          : "missing_target"
      }`
    );
  }

  let createdCount = 0;
  let updatedCount = 0;
  const sheetErrors: string[] = [];

  if (emails.length === 0) {
    // Direct/phone contacts stay manual unless they originated in the Sheet.
    await db.contact.create({
      data: {
        artistId,
        phone,
        directOutreachNote,
        name,
        role,
        customPrice,
        notes,
        source: "manual",
      },
    });
    createdCount++;
  } else {
    for (const email of emails) {
      const existing = await db.contact.findUnique({
        where: { artistId_email: { artistId, email } },
        include: { artist: true },
      });

      if (existing?.source === "sheet") {
        let sheetUpdate: Awaited<
          ReturnType<typeof updateContactInSheet>
        > | null = null;
        try {
          sheetUpdate = await updateContactInSheet({
            artistName: existing.artist.name,
            oldEmail: existing.email ?? email,
            newEmail: email,
            oldDirectOutreachNote: existing.directOutreachNote,
            newDirectOutreachNote: null,
            sourceKey: existing.sourceKey,
            managerName: name,
            role,
            customPrice,
            notes,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          sheetErrors.push(`${email}: ${message.slice(0, 80)}`);
          continue;
        }

        try {
          await db.contact.update({
            where: { id: existing.id },
            data: {
              phone,
              name,
              role,
              customPrice,
              notes,
              sourceKey: sheetUpdate.sourceKey,
              sourceSyncedAt: new Date(),
              state: "active",
            },
          });
          updatedCount++;
        } catch (error) {
          let rollbackError: string | null = null;
          try {
            await updateContactInSheet({
              artistName: existing.artist.name,
              oldEmail: email,
              newEmail: existing.email ?? email,
              oldDirectOutreachNote: null,
              newDirectOutreachNote: existing.directOutreachNote,
              sourceKey: sheetUpdate.sourceKey,
              managerName: existing.name,
              role: existing.role,
              customPrice: existing.customPrice,
              notes: existing.notes,
            });
          } catch (rollback) {
            rollbackError =
              rollback instanceof Error ? rollback.message : String(rollback);
          }
          const databaseError =
            error instanceof Error ? error.message : String(error);
          console.error(
            JSON.stringify({
              event: "contact_sheet_database_divergence",
              contactId: existing.id,
              databaseError,
              rollbackError,
            })
          );
          sheetErrors.push(
            `${email}: ${
              rollbackError
                ? `database update and Sheet rollback failed: ${rollbackError}`
                : `database update failed; Sheet rolled back: ${databaseError}`
            }`.slice(0, 160)
          );
        }
        continue;
      }

      const contact = await db.contact.upsert({
        where: { artistId_email: { artistId, email } },
        create: { artistId, email, phone, name, role, customPrice, notes, source: "manual" },
        update: { phone, name, role, customPrice, notes, state: "active" },
        include: { artist: true },
      });

      if (existing) {
        updatedCount++;
      } else {
        createdCount++;
        try {
          const appended = await appendContactToSheet({
            artistName: contact.artist.name,
            email,
            managerName: name,
            role,
            customPrice,
            notes,
          });
          await db.contact.update({
            where: { id: contact.id },
            data: {
              source: "sheet",
              sourceKey: appended.sourceKey,
              sourceSyncedAt: new Date(),
              state: "active",
            },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error("[sheet append] failed", e);
          sheetErrors.push(`${email}: ${msg.slice(0, 80)}`);
        }
      }
    }
  }

  refreshWorkflowViews(returnTo, ["/settings/contacts", "/"]);

  const results: Record<string, string> = {
    added: String(createdCount),
  };
  if (updatedCount > 0) results.updated = String(updatedCount);
  if (sheetErrors.length) {
    results.sheet_errors = sheetErrors.slice(0, 2).join(" | ");
  }
  redirect(appendWorkflowResult(returnTo, results));
}

export default async function AddContactPage({
  params,
  searchParams,
}: {
  params: Promise<{ artistId: string }>;
  searchParams: Promise<{
    error?: SearchParamValue;
    returnTo?: SearchParamValue;
  }>;
}) {
  const { artistId } = await params;
  const search = await searchParams;
  const error = firstSearchParam(search.error);
  const safeReturnTo = workflowReturnPath(firstSearchParam(search.returnTo));
  const artist = await getArtistForContact(artistId);
  if (!artist) return notFound();

  const now = new Date();
  const today = easternTodayStoredDate(now);
  const upcomingShows = artist.shows
    .map((sa) => sa.show)
    .filter(
      (s) =>
        s.date >= today &&
        s.syncStatus === "active" &&
        satisfiesFestivalLeadTime(s, now)
    )
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <Link href={safeReturnTo} className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">← Back</Link>
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
                  {c.name ? `${c.name} · ` : ""}
                  {contactDisplayValue(c)}
                  {hasDirectOutreachNote(c) &&
                  !isDirectOutreachOnly(c)
                    ? ` · ${directOutreachNoteValue(c)}`
                    : ""}
                  {hasDirectOutreachNote(c) ? " · direct outreach" : ""}
                  {c.role ? ` · ${c.role}` : ""}
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
            ? "Add at least one email, a phone number, or direct outreach details."
            : error === "conflicting_targets"
            ? "Use either emails or direct outreach details, not both."
            : error}
        </div>
      )}

      <Card className="mt-6">
        <CardBody>
          <form action={createContacts} className="space-y-4">
            <input type="hidden" name="artistId" value={artistId} />
            <input type="hidden" name="returnTo" value={safeReturnTo} />
            <TextArea
              name="emails"
              label="Emails (optional if phone or direct outreach details given)"
              description="Manager or management-company emails only. One per line; commas, semicolons, and spaces also separate. Duplicates are deduped. Leave empty to create one direct/phone contact."
              rows={4}
              placeholder={"manager@example.com\nmanagement@company.com"}
              mono
            />
            <Field name="phone" label="Phone (shared, for texting)" type="tel" placeholder="+1 555 123 4567" />
            <TextArea
              name="directOutreachNote"
              label="Direct outreach details"
              description="For a personal relationship, DM path, or other non-email instructions. Use only when the email list is empty."
              rows={3}
              placeholder="Reach out directly through…"
            />
            <Field name="name" label="Manager name (shared)" placeholder="Thierry" />
            <Field name="customPrice" label="Custom rate (shared)" placeholder="$400" />
            <TextArea name="notes" label="Notes (shared)" rows={3} />
            <p className="text-xs text-zinc-500">
              Shared fields apply to every email above. With no emails, phone
              and/or direct outreach details create one manual contact.
            </p>
            <div className="flex gap-2">
              <PendingSubmitButton
                variant="primary"
                pendingLabel="Saving…"
              >
                Save contacts
              </PendingSubmitButton>
              <LinkButton href={safeReturnTo} variant="secondary">Cancel</LinkButton>
            </div>
          </form>
        </CardBody>
      </Card>
    </main>
  );
}
