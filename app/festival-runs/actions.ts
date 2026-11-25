"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireServerActionAuth } from "@/lib/auth";
import { startFestivalRunSearch } from "@/lib/festivalRunSearch";
import { db } from "@/lib/db";

export async function startFestivalRunSearchAction() {
  await requireServerActionAuth("/festival-runs");
  try {
    await startFestivalRunSearch();
  } catch (error) {
    redirect(`/festival-runs?error=${encodeURIComponent((error instanceof Error ? error.message : "Search could not start").slice(0, 180))}`);
  }
  revalidatePath("/festival-runs");
  redirect("/festival-runs");
}

export async function dismissFestivalRunSuggestionAction(formData: FormData) {
  await requireServerActionAuth("/festival-runs");
  const id = formData.get("id");
  if (typeof id !== "string" || !id) redirect("/festival-runs?error=Missing+suggestion");
  const result = await db.festivalRunSearchSuggestion.updateMany({
    where: { id, status: "pending" },
    data: { status: "dismissed", reviewedAt: new Date() },
  });
  if (!result.count) redirect("/festival-runs?error=Suggestion+is+no+longer+pending");
  revalidatePath("/festival-runs");
}

export async function reviewFestivalRunSuggestionAction(formData: FormData) {
  await requireServerActionAuth("/festival-runs");
  const id = formData.get("id");
  if (typeof id !== "string" || !id) redirect("/festival-runs?error=Missing+suggestion");
  const result = await db.festivalRunSearchSuggestion.updateMany({
    where: { id, status: "pending" },
    data: { status: "reviewed", reviewedAt: new Date() },
  });
  if (!result.count) redirect("/festival-runs?error=Suggestion+is+no+longer+pending");
  revalidatePath("/festival-runs");
}
