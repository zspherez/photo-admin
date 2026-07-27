import type { Metadata } from "next";
import { Prisma } from "@prisma/client";
import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { DirectOutreachProvenance } from "@/components/direct-outreach-provenance";
import { cn } from "@/lib/cn";
import {
  contactDisplayValue,
  directOutreachNoteValue,
  hasDirectOutreachNote,
  isDirectOutreachOnly,
} from "@/lib/contactDisplay";
import { getPagination } from "@/lib/match";
import {
  firstSearchParam,
  positiveIntegerSearchParam,
  validatedTrimmedSearchParam,
  type SearchParamValue,
} from "@/lib/searchParams";
import { withWorkflowReturnTo } from "@/lib/workflowLinks";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Artists" };

const ARTIST_PAGE_SIZE = 100;
const ARTIST_VIEWS = ["all", "with", "without"] as const;
type ArtistView = (typeof ARTIST_VIEWS)[number];

function parseArtistView(value: unknown): ArtistView {
  const view = firstSearchParam(value);
  return ARTIST_VIEWS.includes(view as ArtistView)
    ? (view as ArtistView)
    : "all";
}

function artistsHref(view: ArtistView, search: string, page: number): string {
  const params = new URLSearchParams();
  if (view !== "all") params.set("view", view);
  if (search) params.set("search", search);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/artists?${query}` : "/artists";
}

export default async function ArtistsPage({
  searchParams,
}: {
  searchParams: Promise<{
    view?: SearchParamValue;
    search?: SearchParamValue;
    page?: SearchParamValue;
  }>;
}) {
  const params = await searchParams;
  const view = parseArtistView(params.view);
  const search =
    validatedTrimmedSearchParam(params.search, { maxLength: 200 }) ?? "";
  const requestedPage = positiveIntegerSearchParam(params.page);
  const activeContactExists = Prisma.sql`
    EXISTS (
      SELECT 1
      FROM "Contact" contact
      WHERE contact."artistId" = artist."id"
        AND contact."state" = 'active'
    )
  `;
  const searchWhere = search
    ? Prisma.sql`
        AND (
          STRPOS(LOWER(artist."name"), LOWER(${search})) > 0
          OR EXISTS (
            SELECT 1
            FROM "Contact" contact
            WHERE contact."artistId" = artist."id"
              AND contact."state" = 'active'
              AND (
                STRPOS(LOWER(COALESCE(contact."email", '')), LOWER(${search})) > 0
                OR STRPOS(LOWER(COALESCE(contact."phone", '')), LOWER(${search})) > 0
                OR STRPOS(LOWER(COALESCE(contact."name", '')), LOWER(${search})) > 0
                OR STRPOS(LOWER(COALESCE(contact."notes", '')), LOWER(${search})) > 0
                OR STRPOS(LOWER(COALESCE(contact."directOutreachNote", '')), LOWER(${search})) > 0
                OR STRPOS(LOWER(COALESCE(contact."directOutreachEvidence", '')), LOWER(${search})) > 0
              )
          )
        )
      `
    : Prisma.empty;
  const viewWhere =
    view === "with"
      ? Prisma.sql`AND ${activeContactExists}`
      : view === "without"
        ? Prisma.sql`AND NOT ${activeContactExists}`
        : Prisma.empty;

  const [counts] = await db.$queryRaw<
    Array<{ all: number; with: number; without: number }>
  >(Prisma.sql`
    SELECT
      COUNT(*)::int AS "all",
      COUNT(*) FILTER (WHERE ${activeContactExists})::int AS "with",
      COUNT(*) FILTER (WHERE NOT ${activeContactExists})::int AS "without"
    FROM "Artist" artist
    WHERE true
    ${searchWhere}
  `);
  const total = counts[view];
  const pagination = getPagination(total, requestedPage, ARTIST_PAGE_SIZE);
  if (pagination.page !== requestedPage) {
    redirect(artistsHref(view, search, pagination.page));
  }

  const artistIds = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT artist."id"
    FROM "Artist" artist
    WHERE true
    ${searchWhere}
    ${viewWhere}
    ORDER BY artist."normalizedName" ASC, artist."id" ASC
    LIMIT ${ARTIST_PAGE_SIZE}
    OFFSET ${(pagination.page - 1) * ARTIST_PAGE_SIZE}
  `);
  const artistRows = await db.artist.findMany({
    where: { id: { in: artistIds.map((row) => row.id) } },
    include: {
      contacts: {
        where: { state: "active" },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      },
    },
  });
  const artistById = new Map(artistRows.map((artist) => [artist.id, artist]));
  const artists = artistIds.flatMap((row) => {
    const artist = artistById.get(row.id);
    return artist ? [artist] : [];
  });
  const returnTo = artistsHref(view, search, pagination.page);
  const tabs: Array<{ view: ArtistView; label: string; count: number }> = [
    { view: "all", label: "All", count: counts.all },
    { view: "with", label: "With contacts", count: counts.with },
    { view: "without", label: "Without contacts", count: counts.without },
  ];

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Artists</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {total.toLocaleString()} artist{total === 1 ? "" : "s"} in this
            view
          </p>
        </div>
        <div className="flex gap-2">
          <LinkButton href="/contact-audit" variant="secondary">
            Audit contacts
          </LinkButton>
          <LinkButton href="/settings/contacts" variant="secondary">
            Contact snapshots
          </LinkButton>
        </div>
      </div>

      <nav
        aria-label="Artist contact status"
        className="-mx-4 mt-4 flex items-center gap-1 overflow-x-auto border-b border-zinc-200 px-4 dark:border-zinc-800 sm:mx-0 sm:px-0"
      >
        {tabs.map((tab) => {
          const active = view === tab.view;
          return (
            <Link
              key={tab.view}
              href={artistsHref(tab.view, search, 1)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium transition",
                active
                  ? "border-zinc-900 text-zinc-900 dark:border-zinc-100 dark:text-zinc-100"
                  : "border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100",
              )}
            >
              {tab.label}
              <span className="ml-1.5 text-xs text-zinc-400">
                {tab.count.toLocaleString()}
              </span>
            </Link>
          );
        })}
      </nav>

      <form action="/artists" className="mt-5 flex gap-2">
        {view !== "all" && <input type="hidden" name="view" value={view} />}
        <input
          type="search"
          name="search"
          defaultValue={search}
          placeholder="Search artists, emails, phones, managers, or notes…"
          className="h-9 min-w-0 flex-1 rounded-md border border-zinc-200 bg-white px-3 text-sm placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
        />
        <button
          type="submit"
          className="inline-flex h-9 items-center justify-center rounded-md border border-zinc-200 bg-white px-4 text-sm font-medium text-zinc-900 transition hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-900"
        >
          Search
        </button>
        {search && (
          <LinkButton href={artistsHref(view, "", 1)} variant="secondary">
            Clear
          </LinkButton>
        )}
      </form>

      {artists.length === 0 ? (
        <Card className="mt-6 p-12 text-center text-sm text-zinc-500">
          No artists match this search and contact status.
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
              {artists.map((artist) => (
                <li key={artist.id} className="px-4 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <Link
                        href={withWorkflowReturnTo(
                          `/artists/${artist.id}`,
                          returnTo,
                        )}
                        className="text-sm font-semibold hover:underline"
                      >
                        {artist.name}
                      </Link>
                      <div className="mt-1">
                        {artist.contacts.length > 0 ? (
                          <Badge tone="success">
                            {artist.contacts.length} contact
                            {artist.contacts.length === 1 ? "" : "s"}
                          </Badge>
                        ) : (
                          <Badge tone="warning">Needs contact</Badge>
                        )}
                      </div>
                    </div>
                    <LinkButton
                      href={withWorkflowReturnTo(
                        `/dashboard/add-contact/${artist.id}`,
                        returnTo,
                      )}
                      variant="secondary"
                      size="sm"
                    >
                      Add contact
                    </LinkButton>
                  </div>

                  {artist.contacts.length > 0 && (
                    <ul className="mt-3 space-y-3">
                      {artist.contacts.map((contact) => (
                        <li
                          key={contact.id}
                          className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-zinc-100 bg-zinc-50/60 px-3 py-2 dark:border-zinc-900 dark:bg-zinc-900/40"
                        >
                          <div className="min-w-0">
                            <p className="break-all text-xs text-zinc-600 dark:text-zinc-400">
                              {contact.name ? `${contact.name} · ` : ""}
                              {contactDisplayValue(
                                contact,
                                "No email or phone",
                              )}
                              {hasDirectOutreachNote(contact) &&
                              !isDirectOutreachOnly(contact)
                                ? ` · ${directOutreachNoteValue(contact)}`
                                : ""}
                            </p>
                            {contact.notes && (
                              <p className="mt-1 line-clamp-2 text-xs text-zinc-400">
                                {contact.notes}
                              </p>
                            )}
                            <DirectOutreachProvenance
                              contact={contact}
                              className="mt-2"
                            />
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            {contact.source && (
                              <Badge tone="muted">{contact.source}</Badge>
                            )}
                            <LinkButton
                              href={withWorkflowReturnTo(
                                `/dashboard/contact/${contact.id}`,
                                returnTo,
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
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}

      {pagination.pageCount > 1 && (
        <nav
          aria-label="Artist pages"
          className="mt-5 flex items-center justify-between gap-3"
        >
          {pagination.hasPrevious ? (
            <LinkButton
              href={artistsHref(view, search, pagination.page - 1)}
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
              href={artistsHref(view, search, pagination.page + 1)}
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
