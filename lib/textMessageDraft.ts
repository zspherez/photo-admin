import type { EmailTemplate } from "@prisma/client";
import { artistDisplayName } from "@/lib/artistDisplayName";
import { normalizeArbitraryEmailContent } from "@/lib/arbitraryEmailContent";
import { db } from "@/lib/db";
import {
  applyHtmlTemplate,
  buildVarsForShow,
  readOriginalTemplateForShow,
  type ShowContext,
} from "@/lib/template";

export async function renderTextMessageDraft({
  context,
  template,
  readSetting,
}: {
  context: ShowContext;
  template: Pick<EmailTemplate, "htmlBody">;
  readSetting?: Parameters<typeof buildVarsForShow>[1];
}): Promise<string> {
  const vars = await buildVarsForShow(context, readSetting);
  const renderedHtml = applyHtmlTemplate(template.htmlBody, vars);
  const normalized = normalizeArbitraryEmailContent(renderedHtml);
  if (!normalized.ok) {
    throw new Error(`Could not create text draft: ${normalized.error}`);
  }
  return normalized.content.text;
}

export async function loadTextMessageDraft({
  showId,
  artistId,
  phoneContactId,
}: {
  showId: string;
  artistId: string;
  phoneContactId: string;
}): Promise<string | null> {
  const show = await db.show.findFirst({
    where: {
      id: showId,
      artists: { some: { artistId } },
    },
    select: {
      isFestival: true,
      venueName: true,
      date: true,
      eventName: true,
      city: true,
      state: true,
      countryCode: true,
      countryName: true,
      artists: {
        where: { artistId },
        select: {
          artist: {
            select: {
              name: true,
              customName: true,
              contacts: {
                where: { id: phoneContactId, state: "active" },
                select: {
                  phone: true,
                  name: true,
                },
              },
            },
          },
        },
      },
    },
  });
  const artist = show?.artists[0]?.artist;
  if (!show || !artist) return null;

  const phoneContact = artist.contacts[0];
  if (!phoneContact?.phone?.trim()) return null;

  const template = await readOriginalTemplateForShow(show);
  return renderTextMessageDraft({
    context: {
      artistName: artistDisplayName(artist),
      venueName: show.venueName,
      showDate: show.date,
      managerName: phoneContact.name,
      eventName: show.eventName,
      city: show.city,
      state: show.state,
      countryCode: show.countryCode,
      countryName: show.countryName,
    },
    template,
  });
}
