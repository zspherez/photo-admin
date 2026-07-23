"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireServerActionAuth } from "@/lib/auth";
import {
  ContactExportError,
  exportGoogleContactSnapshot,
} from "@/lib/googleSheetContactExport";

export async function exportContactSnapshotAction(
  formData: FormData,
): Promise<void> {
  await requireServerActionAuth("/settings/contacts");
  const confirmation = formData.get("confirmation");
  const idempotencyKey = formData.get("idempotencyKey");
  let redirectTo: string;

  try {
    if (confirmation !== "EXPORT") {
      throw new ContactExportError(
        "Confirm that this export creates a new immutable snapshot tab",
      );
    }
    if (typeof idempotencyKey !== "string") {
      throw new ContactExportError("Contact export idempotency key is missing");
    }
    const result = await exportGoogleContactSnapshot({
      idempotencyKey,
      requestedByRole: "admin",
    });
    const params = new URLSearchParams({
      export: "ok",
      snapshot: result.id,
      count: String(result.contactCount),
    });
    redirectTo = `/settings/contacts?${params.toString()}`;
  } catch (error) {
    const detail =
      error instanceof ContactExportError
        ? error.message
        : "Contact snapshot export failed";
    const params = new URLSearchParams({
      export: "error",
      detail: detail.slice(0, 200),
    });
    if (
      typeof idempotencyKey === "string" &&
      /^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)
    ) {
      params.set("retryKey", idempotencyKey);
    }
    redirectTo = `/settings/contacts?${params.toString()}`;
  }

  revalidatePath("/settings/contacts");
  redirect(redirectTo);
}
