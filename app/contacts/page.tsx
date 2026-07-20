import type { Metadata } from "next";
import { Prisma } from "@prisma/client";
import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import {
  contactDisplayValue,
  directOutreachNoteValue,
  hasDirectOutreachNote,
} from "@/lib/contactDisplay";
import { getPagination } from "@/lib/match";
import {
  positiveIntegerSearchParam,
  validatedTrimmedSearchParam,
  type SearchParamValue,
} from "@/lib/searchParams";
import { withWorkflowReturnTo } from "@/lib/workflowLinks";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Contacts" };

const CONTACT_PAGE_SIZE = 100;

function contactsHref(search: string, page: number): string {
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/contacts?${query}` : "/contacts";
}

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{
    search?: SearchParamValue;
    page?: SearchParamValue;
  }>;
}) {
  const params = await searchParams;
  const search =
    validatedTrimmedSearchParam(params.search, { maxLength: 200 }) ?? "";
  const requestedPage = positiveIntegerSearchParam(params.page);
  const searchWhere = search
    ? Prisma.sql`
        AND (
          STRPOS(LOWER(COALESCE(contact."email", '')), LOWER(${search})) > 0
          OR STRPOS(LOWER(COALESCE(contact."name", '')), LOWER(${search})) > 0
          OR STRPOS(LOWER(COALESCE(contact."notes", '')), LOWER(${search})) > 0
          OR STRPOS(LOWER(artist."name"), LOWER(${search})) > 0
        )
      `
    : Prisma.empty;
  const [{ count: total }] = await db.$queryRaw<Array<{ count: number }>>(
    Prisma.sql`
      SELECT COUNT(*)::int AS "count"
      FROM "Contact" contact
      JOIN "Artist" artist ON artist."id" = contact."artistId"
      WHERE contact."state" = 'active'
      ${searchWhere}
    `
  );
  const pagination = getPagination(
    total,
    requestedPage,
    CONTACT_PAGE_SIZE
  );
  if (pagination.page !== requestedPage) {
    redirect(contactsHref(search, pagination.page));
  }
  const contactIds = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT contact."id"
    FROM "Contact" contact
    JOIN "Artist" artist ON artist."id" = contact."artistId"
    WHERE contact."state" = 'active'
    ${searchWhere}
    ORDER BY
      LOWER(artist."name") ASC,
      LOWER(COALESCE(contact."email", '')) ASC,
      contact."id" ASC
    LIMIT ${CONTACT_PAGE_SIZE}
    OFFSET ${(pagination.page - 1) * CONTACT_PAGE_SIZE}
  `);
  const contactRows = await db.contact.findMany({
    where: { id: { in: contactIds.map((row) => row.id) } },
    include: { artist: true },
  });
  const contactsById = new Map(
    contactRows.map((contact) => [contact.id, contact])
  );
  const contacts = contactIds.flatMap((row) => {
    const contact = contactsById.get(row.id);
    return contact ? [contact] : [];
  });
  const returnTo = contactsHref(search, pagination.page);

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Contacts</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {total.toLocaleString()} active contact
            {total === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex gap-2">
          <LinkButton href="/contact-audit" variant="secondary">
            Audit contacts
          </LinkButton>
          <LinkButton href="/settings/contacts" variant="secondary">
            Sheet sync
          </LinkButton>
        </div>
      </div>

      <form action="/contacts" className="mt-5 flex gap-2">
        <input
          type="search"
          name="search"
          defaultValue={search}
          placeholder="Search artist, email, manager, or notes…"
          className="h-9 min-w-0 flex-1 rounded-md border border-zinc-200 bg-white px-3 text-sm placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
        />
        <button
          type="submit"
          className="inline-flex h-9 items-center justify-center rounded-md border border-zinc-200 bg-white px-4 text-sm font-medium text-zinc-900 transition hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-900"
        >
          Search
        </button>
        {search && (
          <LinkButton href="/contacts" variant="secondary">
            Clear
          </LinkButton>
        )}
      </form>

      {contacts.length === 0 ? (
        <Card className="mt-6 p-12 text-center text-sm text-zinc-500">
          No active contacts match this search.
        </Card>
      ) : (
        <>
          <div className="mt-5 flex items-center justify-between text-xs text-zinc-500">
            <span>
              {pagination.start}–{pagination.end} of {pagination.total}
            </span>
            <span>
              Page {pagination.page} of {pagination.pageCount}
            </span>
          </div>
          <Card className="mt-3">
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {contacts.map((contact) => (
                <li
                  key={contact.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/artists/${contact.artistId}`}
                      className="text-sm font-medium hover:underline"
                    >
                      {contact.artist.name}
                    </Link>
                    <p className="mt-0.5 break-all text-xs text-zinc-500">
                      {contact.name ? `${contact.name} · ` : ""}
                      {contactDisplayValue(contact, "No email or phone")}
                      {hasDirectOutreachNote(contact)
                        ? ` · ${directOutreachNoteValue(contact)}`
                        : ""}
                    </p>
                    {contact.notes && (
                      <p className="mt-1 line-clamp-2 text-xs text-zinc-400">
                        {contact.notes}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {contact.source && (
                      <Badge tone="muted">{contact.source}</Badge>
                    )}
                    <LinkButton
                      href={withWorkflowReturnTo(
                        `/dashboard/contact/${contact.id}`,
                        returnTo
                      )}
                      variant="secondary"
                      size="sm"
                    >
                      Edit
                    </LinkButton>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}

      {pagination.pageCount > 1 && (
        <nav
          aria-label="Contact pages"
          className="mt-5 flex items-center justify-between gap-3"
        >
          {pagination.hasPrevious ? (
            <LinkButton
              href={contactsHref(search, pagination.page - 1)}
              variant="secondary"
            >
              Previous
            </LinkButton>
          ) : (
            <span />
          )}
          <span className="text-xs text-zinc-500">
            Page {pagination.page} of {pagination.pageCount}
          </span>
          {pagination.hasNext ? (
            <LinkButton
              href={contactsHref(search, pagination.page + 1)}
              variant="secondary"
            >
              Next
            </LinkButton>
          ) : (
            <span />
          )}
        </nav>
      )}
    </main>
  );
}
