"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  ARBITRARY_EMAIL_UTM_KEYS,
  parseArbitraryEmailInput,
  type ArbitraryEmailUtmValues,
} from "@/lib/arbitraryEmail";
import { normalizeArbitraryEmailContent } from "@/lib/arbitraryEmailContent";
import { requireServerActionAuth } from "@/lib/auth";
import {
  cancelScheduledArbitraryEmail,
  queueArbitraryEmail,
  sendArbitraryEmail,
} from "@/lib/sendArbitraryEmail";
import { getNextNormalOutreachDispatch } from "@/lib/schedule";
import { db } from "@/lib/db";

export interface ArbitraryEmailActionState {
  error: string | null;
}

export async function normalizeArbitraryEmailPreviewAction(
  html: string,
  values: Partial<ArbitraryEmailUtmValues>,
) {
  await requireServerActionAuth("/emails/new");
  const utm = Object.fromEntries(
    ARBITRARY_EMAIL_UTM_KEYS.map((key) => [key, (values[key] ?? "").trim()]),
  ) as ArbitraryEmailUtmValues;
  if (Object.values(utm).some((value) => value.length > 200)) {
    return { ok: false as const, error: "UTM values must be 200 characters or fewer" };
  }
  return normalizeArbitraryEmailContent(
    html,
    ARBITRARY_EMAIL_UTM_KEYS.map((key) => [key, utm[key]]),
  );
}

export async function sendArbitraryEmailAction(
  _previousState: ArbitraryEmailActionState,
  formData: FormData,
): Promise<ArbitraryEmailActionState> {
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
    return { error: parsed.error };
  }

  const intent = String(formData.get("intent") ?? "send");
  if (intent !== "send" && intent !== "queue") {
    return { error: "Unknown email action" };
  }
  const compositionId = String(formData.get("compositionId") ?? "").trim();
  if (
    intent === "queue" &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      compositionId,
    )
  ) {
    return { error: "This composition identity is invalid; reload and retry" };
  }

  const result =
    intent === "queue"
      ? await queueArbitraryEmail(
          parsed.input,
          getNextNormalOutreachDispatch(),
          compositionId,
        )
      : await sendArbitraryEmail(parsed.input);
  revalidatePath("/emails");
  if (!result.ok) {
    return { error: result.error };
  }
  if (intent === "queue") {
    redirect(`/emails?queued=${encodeURIComponent(result.id)}`);
  }
  redirect(`/emails?sent=${encodeURIComponent(result.id)}`);
}

export async function cancelArbitraryEmailAction(formData: FormData) {
  await requireServerActionAuth("/emails");
  const id = String(formData.get("id") ?? "").trim();
  if (!id) redirect("/emails?error=Missing%20email");
  const cancelled = await cancelScheduledArbitraryEmail(id);
  revalidatePath("/emails");
  if (!cancelled) {
    redirect(
      `/emails?error=${encodeURIComponent(
        "Queued email is no longer cancellable",
      )}`,
    );
  }
  redirect(`/emails?cancelled=${encodeURIComponent(id)}`);
}

function selectedEmailIds(formData: FormData): string[] {
  return Array.from(
    new Set(
      formData
        .getAll("emailIds")
        .map((value) => String(value).trim())
        .filter((value) =>
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            value,
          ),
        ),
    ),
  ).slice(0, 100);
}

export async function updateArbitraryEmailVisibilityAction(
  formData: FormData,
) {
  await requireServerActionAuth("/emails");
  const view = formData.get("view") === "dismissed" ? "dismissed" : "active";
  const ids = selectedEmailIds(formData);
  if (ids.length === 0) {
    redirect(`/emails?view=${view}&error=Select%20at%20least%20one%20email`);
  }
  const result = await db.arbitraryEmail.updateMany({
    where: {
      id: { in: ids },
      dismissedAt: view === "dismissed" ? { not: null } : null,
    },
    data: {
      dismissedAt: view === "dismissed" ? null : new Date(),
    },
  });
  revalidatePath("/emails");
  const destinationView = view === "dismissed" ? "dismissed" : "active";
  const resultKey = view === "dismissed" ? "restored" : "dismissed";
  redirect(
    `/emails?view=${destinationView}&${resultKey}=${result.count}`,
  );
}
