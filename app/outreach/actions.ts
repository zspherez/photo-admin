"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireServerActionAuth, sanitizeNextPath } from "@/lib/auth";
import { db } from "@/lib/db";

function selectedOutreachIds(formData: FormData): string[] {
  return Array.from(
    new Set(
      formData
        .getAll("emailIds")
        .map((value) => String(value).trim())
        .filter(Boolean),
    ),
  ).slice(0, 100);
}

export async function updateOutreachEmailVisibilityAction(
  formData: FormData,
) {
  await requireServerActionAuth("/outreach");
  const view = formData.get("view") === "dismissed" ? "dismissed" : "active";
  const returnTo = sanitizeNextPath(formData.get("returnTo"));
  const ids = selectedOutreachIds(formData);
  if (ids.length === 0) {
    const url = new URL(returnTo, "https://photo-admin.invalid");
    url.searchParams.set("error", "Select at least one email");
    redirect(`${url.pathname}${url.search}`);
  }
  const result = await db.outreach.updateMany({
    where: {
      id: { in: ids },
      dismissedAt: view === "dismissed" ? { not: null } : null,
    },
    data: {
      dismissedAt: view === "dismissed" ? null : new Date(),
    },
  });
  revalidatePath("/outreach");
  const resultKey = view === "dismissed" ? "restored" : "dismissed";
  const destination = new URL(returnTo, "https://photo-admin.invalid");
  destination.searchParams.set(resultKey, String(result.count));
  redirect(`${destination.pathname}${destination.search}`);
}
