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
