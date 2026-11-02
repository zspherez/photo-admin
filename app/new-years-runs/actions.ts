"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireServerActionAuth } from "@/lib/auth";
import { startNewYearSearch } from "@/lib/newYearSearch";
import { db } from "@/lib/db";

export async function startNewYearSearchAction() {
  await requireServerActionAuth("/new-years-runs");
  try {
    await startNewYearSearch();
  } catch (error) {
    redirect(`/new-years-runs?error=${encodeURIComponent((error instanceof Error ? error.message : "Search could not start").slice(0, 180))}`);
  }
  revalidatePath("/new-years-runs");
  redirect("/new-years-runs");
}

export async function dismissNewYearSuggestionAction(formData: FormData) {
  await requireServerActionAuth("/new-years-runs");
  const id = formData.get("id");
  if (typeof id !== "string") return;
  await db.newYearSearchSuggestion.updateMany({
    where: { id, status: "pending" },
    data: { status: "dismissed", reviewedAt: new Date() },
  });
  revalidatePath("/new-years-runs");
}

export async function reviewNewYearSuggestionAction(formData: FormData) {
  await requireServerActionAuth("/new-years-runs");
  const id = formData.get("id");
  if (typeof id !== "string") return;
  await db.newYearSearchSuggestion.updateMany({
    where: { id, status: "pending" },
    data: { status: "reviewed", reviewedAt: new Date() },
  });
  revalidatePath("/new-years-runs");
}
