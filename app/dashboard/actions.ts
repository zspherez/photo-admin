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
export async function markSentAction(formData: FormData) {
  "use server";
  const showId = formData.get("showId") as string;
  const contactId = formData.get("contactId") as string;
  const contact = await db.contact.findUnique({ where: { id: contactId } });
  if (!contact) {
    redirect(`/dashboard?error=contact_not_found`);
  }
  const siblings = await db.contact.findMany({ where: { artistId: contact.artistId } });
  const alreadySent = await db.outreach.findFirst({
    where: {
      showId,
      contactId: { in: siblings.map((c) => c.id) },
      status: "sent",
    },
  });
  if (alreadySent) {
    redirect(`/dashboard?error=already_sent_for_artist`);
  }

  const existing = await db.outreach.findUnique({
    where: { showId_contactId: { showId, contactId } },
  });
  if (existing) {
    await db.outreach.update({
      where: { id: existing.id },
      data: {
        status: "sent",
        sentAt: new Date(),
        finalSubject: "(manual outreach)",
        finalHtml: "(manual outreach)",
        providerMessageId: null,
        error: null,
      },
    });
  } else {
    await db.outreach.create({
      data: {
        showId,
        contactId,
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
  const showId = formData.get("showId") as string;
  const contactId = formData.get("contactId") as string;
  const outreach = await db.outreach.findUnique({
    where: { showId_contactId: { showId, contactId } },
  });
  if (outreach && outreach.providerMessageId === null) {
    await db.outreach.delete({ where: { id: outreach.id } });
  }
  revalidatePath("/dashboard");
  revalidatePath("/outreach");
  redirect("/dashboard?unmarked=1");
}
