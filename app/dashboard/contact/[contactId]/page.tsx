import type { Metadata } from "next";
import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cache } from "react";
import { db } from "@/lib/db";
import { updateContactInSheet } from "@/lib/sheets";
import { Card, CardBody } from "@/components/ui/card";
import { LinkButton } from "@/components/ui/button";
import { Field, TextArea } from "@/components/ui/field";
import { formatShowDate } from "@/lib/formatDate";
import {
  appendWorkflowResult,
  workflowReturnPath,
} from "@/lib/dashboardReturnUrl";
import { withWorkflowReturnTo } from "@/lib/workflowLinks";
import { getPagination } from "@/lib/match";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { requireServerActionAuth } from "@/lib/auth";
import { firstSearchParam, type SearchParamValue } from "@/lib/searchParams";

export const dynamic = "force-dynamic";

const CONTACT_HISTORY_PAGE_SIZE = 25;
const LOCAL_ORIGIN = "https://dashboard.local";

const getEditableContact = cache(async (contactId: string) =>
  db.contact.findUnique({
    where: { id: contactId },
    select: {
      id: true,
      email: true,
      phone: true,
      name: true,
      role: true,
      customPrice: true,
      notes: true,
      source: true,
      artist: { select: { name: true } },
    },
  }),
);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ contactId: string }>;
}): Promise<Metadata> {
  const { contactId } = await params;
  const contact = await getEditableContact(contactId);
  return {
    title: contact
      ? `Edit ${contact.name || "contact"} for ${contact.artist.name}`
      : "Edit contact",
  };
}

function parseHistoryPage(value: FormDataEntryValue | string | undefined): number {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return 1;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 1;
}

function contactPageHref(
  contactId: string,
  returnTo: unknown,
  options: {
    error?: string;
    detail?: string;
    historyPage?: number;
  } = {}
): string {
  const url = new URL(
    withWorkflowReturnTo(
      `/dashboard/contact/${encodeURIComponent(contactId)}`,
      workflowReturnPath(returnTo)
    ),
    LOCAL_ORIGIN
  );
  if (options.error) url.searchParams.set("error", options.error);
  if (options.detail) url.searchParams.set("detail", options.detail);
  if (options.historyPage && options.historyPage > 1) {
    url.searchParams.set("historyPage", String(options.historyPage));
  }
  return `${url.pathname}${url.search}`;
}

async function saveContact(formData: FormData) {
  "use server";
  await requireServerActionAuth(formData.get("returnTo") ?? "/dashboard");
  const contactId = formData.get("contactId") as string;
  const returnTo = workflowReturnPath(formData.get("returnTo"));
  const historyPage = parseHistoryPage(formData.get("historyPage") ?? undefined);
  const email = ((formData.get("email") as string) ?? "").trim().toLowerCase() || null;
  const phone = ((formData.get("phone") as string) ?? "").trim() || null;
  const name = ((formData.get("name") as string) ?? "").trim() || null;
  const role = ((formData.get("role") as string) ?? "").trim() || null;
  const customPrice = ((formData.get("customPrice") as string) ?? "").trim() || null;
  const notes = ((formData.get("notes") as string) ?? "").trim() || null;

  if (!contactId || (!email && !phone)) {
    redirect(
      contactPageHref(contactId, returnTo, {
        error: "missing_fields",
        historyPage,
      })
    );
  }

  const prior = await db.contact.findUnique({
    where: { id: contactId },
    include: { artist: true },
  });
  if (!prior) {
    redirect(
      contactPageHref(contactId, returnTo, {
        error: "not_found",
        historyPage,
      })
    );
  }

  if (prior.source === "sheet" && (!email || !prior.email)) {
    redirect(
      contactPageHref(contactId, returnTo, {
        error: "sheet_email_required",
        historyPage,
      })
    );
  }
  if (email) {
    const duplicate = await db.contact.findFirst({
      where: {
        artistId: prior.artistId,
        email,
        id: { not: contactId },
      },
      select: { id: true },
    });
    if (duplicate) {
      redirect(
        contactPageHref(contactId, returnTo, {
          error: "duplicate_email",
          historyPage,
        })
      );
    }
  }

  let sheetUpdate: Awaited<ReturnType<typeof updateContactInSheet>> | null =
    null;
  let sheetError: string | null = null;
  if (prior.source === "sheet" && email && prior.email) {
    try {
      sheetUpdate = await updateContactInSheet({
        artistName: prior.artist.name,
        oldEmail: prior.email,
        newEmail: email,
        sourceKey: prior.sourceKey,
        managerName: name,
        role,
        customPrice,
        notes,
      });
    } catch (error) {
      sheetError = error instanceof Error ? error.message : String(error);
    }
  }
  if (sheetError) {
    redirect(
      contactPageHref(contactId, returnTo, {
        error: "sheet_sync",
        detail: sheetError.slice(0, 180),
        historyPage,
      })
    );
  }

  let databaseError: string | null = null;
  let rollbackError: string | null = null;
  try {
    await db.contact.update({
      where: { id: contactId },
      data: {
        email,
        phone,
        name,
        role,
        customPrice,
        notes,
        ...(prior.source === "sheet"
          ? {
              sourceKey: sheetUpdate?.sourceKey ?? prior.sourceKey,
              sourceSyncedAt: new Date(),
              state: "active",
            }
          : {}),
      },
    });
  } catch (error) {
    databaseError = error instanceof Error ? error.message : String(error);
    if (sheetUpdate && email && prior.email) {
      try {
        await updateContactInSheet({
          artistName: prior.artist.name,
          oldEmail: email,
          newEmail: prior.email,
          sourceKey: sheetUpdate.sourceKey,
          managerName: prior.name,
          role: prior.role,
          customPrice: prior.customPrice,
          notes: prior.notes,
        });
      } catch (rollback) {
        rollbackError =
          rollback instanceof Error ? rollback.message : String(rollback);
      }
    }
  }
  if (databaseError) {
    console.error(
      JSON.stringify({
        event: "contact_sheet_database_divergence",
        contactId,
        databaseError,
        rollbackError,
      })
    );
    const error = rollbackError ? "sheet_db_diverged" : "database_update";
    const detail = rollbackError
      ? `Database update failed and Sheet rollback failed: ${rollbackError}`
      : databaseError;
    redirect(
      contactPageHref(contactId, returnTo, {
        error,
        detail: detail.slice(0, 180),
        historyPage,
      })
    );
  }

  revalidatePath("/dashboard");
  redirect(appendWorkflowResult(returnTo, { added: "0", updated: "1" }));
}

async function deleteContact(formData: FormData) {
  "use server";
  await requireServerActionAuth(formData.get("returnTo") ?? "/dashboard");
  const contactId = formData.get("contactId") as string;
  const returnTo = workflowReturnPath(formData.get("returnTo"));
  const historyPage = parseHistoryPage(formData.get("historyPage") ?? undefined);
  const contact = await db.contact.findUnique({
    where: { id: contactId },
    select: { source: true },
  });
  if (contact?.source === "sheet") {
    redirect(
      contactPageHref(contactId, returnTo, {
        error: "delete_from_sheet",
        historyPage,
      })
    );
  }
  await db.contact.delete({ where: { id: contactId } });
  revalidatePath("/dashboard");
  redirect(appendWorkflowResult(returnTo, { deleted: "1" }));
}

export default async function ContactEditPage({
  params,
  searchParams,
}: {
  params: Promise<{ contactId: string }>;
  searchParams: Promise<{
    error?: SearchParamValue;
    detail?: SearchParamValue;
    returnTo?: SearchParamValue;
    historyPage?: SearchParamValue;
  }>;
}) {
  const { contactId } = await params;
  const search = await searchParams;
  const error = firstSearchParam(search.error);
  const detail = firstSearchParam(search.detail);
  const safeReturnTo = workflowReturnPath(firstSearchParam(search.returnTo));
  const requestedHistoryPage = parseHistoryPage(
    firstSearchParam(search.historyPage),
  );
  const [contact, historyTotal] = await Promise.all([
    getEditableContact(contactId),
    db.outreach.count({ where: { contactId } }),
  ]);
  if (!contact) return notFound();
  const historyPagination = getPagination(
    historyTotal,
    requestedHistoryPage,
    CONTACT_HISTORY_PAGE_SIZE
  );
  if (historyPagination.page !== requestedHistoryPage) {
    redirect(
      contactPageHref(contactId, safeReturnTo, {
        error,
        detail,
        historyPage: historyPagination.page,
      })
    );
  }
  const history = await db.outreach.findMany({
    where: { contactId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: (historyPagination.page - 1) * CONTACT_HISTORY_PAGE_SIZE,
    take: CONTACT_HISTORY_PAGE_SIZE,
    select: {
      id: true,
      status: true,
      sentAt: true,
      openCount: true,
      clickCount: true,
      error: true,
      show: {
        select: {
          venueName: true,
          date: true,
        },
      },
    },
  });

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <Link href={safeReturnTo} className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">← Back</Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Edit contact</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Artist: <b>{contact.artist.name}</b>
        {contact.source && <span className="ml-2 text-xs">(source: {contact.source})</span>}
      </p>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {error === "missing_fields"
            ? "Provide an email or a phone number."
            : error === "sheet_email_required"
              ? "Sheet-owned contacts must keep an email address."
              : error === "duplicate_email"
                ? "That artist already has this email address."
                : error === "sheet_sync"
                  ? `Sheet update failed; the database was not changed. ${detail ?? ""}`
                  : error === "sheet_db_diverged"
                    ? `The Sheet changed but the database update and rollback failed. Reconcile from the Sheet before continuing. ${detail ?? ""}`
                    : error === "database_update"
                      ? `Database update failed; the Sheet change was rolled back. ${detail ?? ""}`
                      : error === "delete_from_sheet"
                        ? "Delete Sheet-owned contacts in Google Sheets, then run a complete contact sync."
                        : error}
        </div>
      )}

      <Card className="mt-6">
        <CardBody>
          <form action={saveContact} className="space-y-4">
            <input type="hidden" name="contactId" value={contact.id} />
            <input type="hidden" name="returnTo" value={safeReturnTo} />
            <input
              type="hidden"
              name="historyPage"
              value={historyPagination.page}
            />
            <Field name="email" label="Email" type="email" defaultValue={contact.email ?? ""} />
            <Field name="phone" label="Phone (for texting)" type="tel" defaultValue={contact.phone ?? ""} placeholder="+1 555 123 4567" />
            <p className="text-xs text-zinc-500">Provide at least one of email or phone.</p>
            <Field name="name" label="Manager name" defaultValue={contact.name ?? ""} />
            <Field name="role" label="Role" defaultValue={contact.role ?? ""} placeholder="management / booking / artist" />
            <Field name="customPrice" label="Custom rate" defaultValue={contact.customPrice ?? ""} placeholder="$400" />
            <TextArea name="notes" label="Notes" rows={3} defaultValue={contact.notes ?? ""} />
            <div className="flex gap-2">
              <PendingSubmitButton variant="primary" pendingLabel="Saving…">
                Save
              </PendingSubmitButton>
              <LinkButton href={safeReturnTo} variant="secondary">Cancel</LinkButton>
            </div>
          </form>
        </CardBody>
      </Card>

      <form action={deleteContact} className="mt-3">
        <input type="hidden" name="contactId" value={contact.id} />
        <input type="hidden" name="returnTo" value={safeReturnTo} />
        <input
          type="hidden"
          name="historyPage"
          value={historyPagination.page}
        />
        <PendingSubmitButton
          variant="ghost"
          size="sm"
          pendingLabel="Deleting…"
          className="h-auto px-0 py-0 text-xs font-normal text-red-700 hover:bg-transparent hover:underline dark:text-red-400 dark:hover:bg-transparent"
        >
          Delete contact
        </PendingSubmitButton>
      </form>

      {history.length > 0 && (
        <section className="mt-10">
          <div className="flex items-end justify-between gap-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Outreach history</h2>
            <span className="text-xs text-zinc-500">
              {historyPagination.start}–{historyPagination.end} of{" "}
              {historyPagination.total}
            </span>
          </div>
          <Card className="mt-3">
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {history.map((o) => (
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
          {historyPagination.pageCount > 1 && (
            <nav
              aria-label="Contact outreach history pages"
              className="mt-4 flex items-center justify-between gap-3"
            >
              {historyPagination.hasPrevious ? (
                <LinkButton
                  href={contactPageHref(contactId, safeReturnTo, {
                    error,
                    detail,
                    historyPage: historyPagination.page - 1,
                  })}
                  variant="secondary"
                  size="sm"
                >
                  ← Previous
                </LinkButton>
              ) : (
                <span />
              )}
              <span className="text-xs text-zinc-500">
                Page {historyPagination.page} of {historyPagination.pageCount}
              </span>
              {historyPagination.hasNext ? (
                <LinkButton
                  href={contactPageHref(contactId, safeReturnTo, {
                    error,
                    detail,
                    historyPage: historyPagination.page + 1,
                  })}
                  variant="secondary"
                  size="sm"
                >
                  Next →
                </LinkButton>
              ) : (
                <span />
              )}
            </nav>
          )}
        </section>
      )}
    </main>
  );
}
