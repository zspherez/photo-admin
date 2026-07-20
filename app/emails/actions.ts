"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { parseArbitraryEmailInput } from "@/lib/arbitraryEmail";
import { requireServerActionAuth } from "@/lib/auth";
import { sendArbitraryEmail } from "@/lib/sendArbitraryEmail";

export async function sendArbitraryEmailAction(formData: FormData) {
  await requireServerActionAuth("/emails/new");
  const parsed = parseArbitraryEmailInput({
    recipients: String(formData.get("recipients") ?? ""),
    subject: String(formData.get("subject") ?? ""),
    html: String(formData.get("html") ?? ""),
    utm_source: String(formData.get("utm_source") ?? ""),
    utm_medium: String(formData.get("utm_medium") ?? ""),
    utm_campaign: String(formData.get("utm_campaign") ?? ""),
    utm_content: String(formData.get("utm_content") ?? ""),
    utm_term: String(formData.get("utm_term") ?? ""),
  });
  if (!parsed.ok) {
    redirect(`/emails/new?error=${encodeURIComponent(parsed.error)}`);
  }

  const result = await sendArbitraryEmail(parsed.input);
  revalidatePath("/emails");
  if (!result.ok) {
    redirect(`/emails?error=${encodeURIComponent(result.error)}`);
  }
  redirect(`/emails?sent=${encodeURIComponent(result.id)}`);
}
