"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { sendOutreach } from "@/lib/sendOutreach";

export async function sendNowAction(formData: FormData) {
  const showId = formData.get("showId") as string;
  const contactId = formData.get("contactId") as string;
  const result = await sendOutreach({ showId, contactId });
  revalidatePath("/dashboard");
  if (result.ok) {
    redirect(`/dashboard?sent=${encodeURIComponent(contactId)}`);
  } else {
    redirect(`/dashboard?error=${encodeURIComponent(result.error ?? "unknown")}`);
  }
}

export async function dismissShowAction(formData: FormData) {
  const showId = formData.get("showId") as string;
  await db.show.update({ where: { id: showId }, data: { dismissedAt: new Date() } });
  revalidatePath("/dashboard");
}

export async function restoreShowAction(formData: FormData) {
  const showId = formData.get("showId") as string;
  await db.show.update({ where: { id: showId }, data: { dismissedAt: null } });
  revalidatePath("/dashboard");
}

export async function toggleInterestedAction(formData: FormData) {
  const showId = formData.get("showId") as string;
  const show = await db.show.findUnique({ where: { id: showId }, select: { interestedAt: true } });
  if (!show) return;
  await db.show.update({
    where: { id: showId },
    data: { interestedAt: show.interestedAt ? null : new Date() },
  });
  revalidatePath("/dashboard");
}

// Record a send that happened outside the app (personal email, DM, etc.) so
// the dashboard reflects it as "Sent". providerMessageId stays null which is
// our flag for "manually marked"; unmarkSent uses that to safely delete.
// Accepts either contactId (when a contact is known) or artistId (for
// artist-level "I reached out, no contact in the system" rows).
export async function markSentAction(formData: FormData) {
  "use server";
  const showId = formData.get("showId") as string;
  const contactId = (formData.get("contactId") as string) || null;
  let artistId = (formData.get("artistId") as string) || null;

  if (contactId) {
    const contact = await db.contact.findUnique({ where: { id: contactId } });
    if (!contact) redirect(`/dashboard?error=contact_not_found`);
    artistId = contact.artistId;
  }
  if (!artistId) redirect(`/dashboard?error=missing_target`);

  const alreadySent = await db.outreach.findFirst({
    where: { showId, artistId, status: "sent" },
  });
  if (alreadySent) {
    redirect(`/dashboard?error=already_sent_for_artist`);
  }

  if (contactId) {
    await db.outreach.upsert({
      where: { showId_contactId: { showId, contactId } },
      update: {
        status: "sent",
        sentAt: new Date(),
        finalSubject: "(manual outreach)",
        finalHtml: "(manual outreach)",
        providerMessageId: null,
        error: null,
      },
      create: {
        showId,
        artistId,
        contactId,
        finalSubject: "(manual outreach)",
        finalHtml: "(manual outreach)",
        status: "sent",
        sentAt: new Date(),
      },
    });
  } else {
    await db.outreach.create({
      data: {
        showId,
        artistId,
        finalSubject: "(manual outreach)",
        finalHtml: "(manual outreach)",
        status: "sent",
        sentAt: new Date(),
      },
    });
  }
  revalidatePath("/dashboard");
  revalidatePath("/outreach");
  redirect("/dashboard?marked=1");
}

// Undo a manual mark. Only deletes if providerMessageId is null (meaning
// it wasn't a real Resend send). Won't touch genuine outreach.
export async function unmarkSentAction(formData: FormData) {
  "use server";
  const outreachId = (formData.get("outreachId") as string) || null;
  if (!outreachId) redirect("/dashboard?error=missing_outreach");
  const outreach = await db.outreach.findUnique({ where: { id: outreachId } });
  if (outreach && outreach.providerMessageId === null) {
    await db.outreach.delete({ where: { id: outreach.id } });
  }
  revalidatePath("/dashboard");
  revalidatePath("/outreach");
  redirect("/dashboard?unmarked=1");
}
