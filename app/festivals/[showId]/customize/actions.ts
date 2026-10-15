"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireServerActionAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  saveFestivalShowTemplate,
  festivalShowTemplateKey,
  validateFestivalShowTemplate,
} from "@/lib/festivalShowTemplate";
import { buildVarsForShow, applyTemplate } from "@/lib/template";
import { renderTrackedEmailHtml } from "@/lib/emailUtm";
import { readEmailUtmSettingsSnapshot } from "@/lib/generalSettings";
import { festivalArtistTemplateName } from "@/lib/festivalArtistTemplateName";
import { artistDisplayName } from "@/lib/artistDisplayName";
import { normalizeEmail } from "@/lib/resend";

export interface FestivalTemplateSaveState {
  error: string | null;
  saved: boolean;
}

function editorHref(showId: string): string {
  return `/festivals/${encodeURIComponent(showId)}/customize`;
}

async function requireFestival(showId: string) {
  const show = await db.show.findUnique({ where: { id: showId } });
  if (!show?.isFestival) throw new Error("Festival not found");
  return show;
}

export async function saveFestivalTemplateAction(
  showId: string,
  _state: FestivalTemplateSaveState,
  formData: FormData,
): Promise<FestivalTemplateSaveState> {
  await requireServerActionAuth(editorHref(showId));
  await requireFestival(showId);
  const subject = formData.get("subject");
  const htmlBody = formData.get("html");
  if (typeof subject !== "string" || typeof htmlBody !== "string") {
    return { error: "Festival subject and body are required", saved: false };
  }
  try {
    await saveFestivalShowTemplate(showId, { subject, htmlBody });
  } catch (error) {
    if (!(error instanceof Error) || !/^(Festival subject|Malformed festival|Unsupported festival)/.test(error.message)) {
      throw error;
    }
    return { error: error.message, saved: false };
  }
  revalidatePath(editorHref(showId));
  revalidatePath(`/festivals/${encodeURIComponent(showId)}`);
  return { error: null, saved: true };
}

export async function resetFestivalTemplateAction(showId: string): Promise<void> {
  await requireServerActionAuth(editorHref(showId));
  await requireFestival(showId);
  await db.setting.deleteMany({ where: { key: festivalShowTemplateKey(showId) } });
  revalidatePath(editorHref(showId));
  revalidatePath(`/festivals/${encodeURIComponent(showId)}`);
  redirect(editorHref(showId));
}

export type FestivalTemplatePreviewResult =
  | { ok: true; subject: string; html: string }
  | { ok: false; error: string };

export async function previewFestivalTemplateAction(
  showId: string,
  contactId: string | null,
  subject: string,
  htmlBody: string,
): Promise<FestivalTemplatePreviewResult> {
  await requireServerActionAuth(editorHref(showId));
  const show = await requireFestival(showId);
  let content;
  try {
    content = validateFestivalShowTemplate({ subject, htmlBody });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Invalid festival template" };
  }
  if (!contactId) {
    return { ok: false, error: "Add an artist with an active email contact to preview personalized content" };
  }
  const contact = await db.contact.findFirst({
    where: {
      id: contactId,
      state: "active",
      artist: { shows: { some: { showId, rejectedAt: null } } },
    },
    include: { artist: true },
  });
  if (!contact || !normalizeEmail(contact.email ?? "")) {
    return { ok: false, error: "The sample recipient is no longer available" };
  }
  const vars = await buildVarsForShow({
    artistName: await festivalArtistTemplateName({
      showId,
      artistId: contact.artistId,
      artistName: artistDisplayName(contact.artist),
      isFestival: show.isFestival,
    }),
    managerName: contact.name,
    venueName: show.venueName,
    showDate: show.date,
    eventName: show.eventName,
    city: show.city,
    state: show.state,
    countryCode: show.countryCode,
    countryName: show.countryName,
  });
  return {
    ok: true,
    subject: applyTemplate(content.subject, vars),
    html: renderTrackedEmailHtml(
      content.htmlBody,
      vars,
      "original",
      artistDisplayName(contact.artist),
      await readEmailUtmSettingsSnapshot(),
      show.festivalUtmCampaign,
    ),
  };
}
