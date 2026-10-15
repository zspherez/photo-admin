import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import {
  readOnlyTemplateForPurpose,
  readOriginalTemplateForShow,
  supportedTemplateVars,
} from "@/lib/template";
import { readFestivalShowTemplate } from "@/lib/festivalShowTemplate";
import { SESSION_COOKIE, getSessionAccess } from "@/lib/auth";
import { artistDisplayName } from "@/lib/artistDisplayName";
import { normalizeEmail } from "@/lib/resend";
import { Card, CardBody } from "@/components/ui/card";
import { FestivalCustomizeForm } from "./customize-form";
import { resetFestivalTemplateAction, saveFestivalTemplateAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Customize festival outreach" };

export default async function FestivalCustomizePage({
  params,
}: {
  params: Promise<{ showId: string }>;
}) {
  const { showId } = await params;
  const show = await db.show.findUnique({
    where: { id: showId },
    include: {
      b2bSets: {
        select: {
          name: true,
          members: { select: { artistId: true } },
        },
      },
      artists: {
        include: {
          artist: {
            include: {
              contacts: {
                where: { state: "active", email: { not: null } },
                orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
              },
            },
          },
        },
      },
    },
  });
  if (!show?.isFestival) notFound();
  const readOnly =
    (await getSessionAccess((await cookies()).get(SESSION_COOKIE)?.value)) === "read_only";
  const globalTemplate = readOnly
    ? readOnlyTemplateForPurpose("festival")
    : await readOriginalTemplateForShow(show);
  const template = readOnly
    ? globalTemplate
    : await readFestivalShowTemplate(show, globalTemplate);
  const b2bNames = new Set(show.b2bSets.map((set) => set.name));
  const memberIds = new Set(
    show.b2bSets.flatMap((set) => set.members.map((member) => member.artistId))
  );
  const sample = show.artists
    .filter(({ artist }) => !b2bNames.has(artist.name) || memberIds.has(artist.id))
    .flatMap(({ artist }) =>
      artist.contacts
        .filter((contact) => normalizeEmail(contact.email ?? ""))
        .map((contact) => ({ contact, artist }))
    )[0];
  const returnHref = `/festivals/${encodeURIComponent(showId)}`;

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <Link href={returnHref} className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">← Festival</Link>
      <h1 className="mt-2 text-2xl font-semibold">Customize festival outreach</h1>
      <p className="mt-1 text-sm text-zinc-500">
        {show.eventName || show.venueName}. This saved subject and body apply to regular sends for every artist on this festival. Per-recipient Customize edits take precedence; follow-ups and existing retries keep their own content.
      </p>
      {readOnly ? (
        <p className="mt-6 text-sm text-zinc-500">Template editing is unavailable in read-only mode.</p>
      ) : <Card className="mt-6">
        <CardBody>
          <FestivalCustomizeForm
            showId={showId}
            sampleContactId={sample?.contact.id ?? null}
            sampleLabel={sample ? `Sample: ${artistDisplayName(sample.artist)} / ${sample.contact.name || sample.contact.email}` : null}
            initialSubject={template.subject}
            initialHtml={template.htmlBody}
            variables={[...supportedTemplateVars("festival")]}
            action={saveFestivalTemplateAction.bind(null, showId)}
          />
        </CardBody>
      </Card>}
      {!readOnly && <form action={resetFestivalTemplateAction.bind(null, showId)} className="mt-4">
        <button type="submit" className="text-xs text-zinc-500 hover:underline">
          Remove festival override and use global festival template
        </button>
      </form>}
    </main>
  );
}
