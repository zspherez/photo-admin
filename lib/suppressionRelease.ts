import { db } from "@/lib/db";
import { normalizeEmail } from "@/lib/resend";
import { acquireOutreachRecipientPolicyLocks } from "@/lib/outreachPolicyLocks";

export function suppressionReleaseInput(formData: FormData):
  | { error: string }
  | { email: string; version: Date; note: string } {
  const emailValue = formData.get("email");
  const email = typeof emailValue === "string" ? normalizeEmail(emailValue) : null;
  const version = formData.get("version");
  const noteValue = formData.get("note");
  const note = typeof noteValue === "string" ? noteValue.trim() : "";
  if (
    !email ||
    typeof version !== "string" ||
    !Number.isFinite(Date.parse(version)) ||
    note.length === 0 ||
    note.length > 1000 ||
    formData.get("confirmed") !== "yes"
  ) {
    return { error: "Confirm the address and enter a review note (1-1000 characters)." } as const;
  }
  return { email, version: new Date(version), note } as const;
}

export async function releaseEmailSuppression(
  input: { email: string; version: Date; note: string },
): Promise<{ error: string } | { released: true }> {
  return db.$transaction(async (tx) => {
    await acquireOutreachRecipientPolicyLocks(tx, [input.email]);
    const suppression = await tx.emailSuppression.findUnique({
      where: { normalizedEmail: input.email },
    });
    if (!suppression) return { error: "This address is no longer suppressed. Refresh the page." };
    if (suppression.updatedAt.getTime() !== input.version.getTime()) {
      return { error: "The suppression changed since you opened this page. Refresh and review the new reason." };
    }
    await tx.emailSuppressionRelease.create({
      data: {
        normalizedEmail: suppression.normalizedEmail,
        reason: suppression.reason,
        source: suppression.source,
        sourceEventId: suppression.sourceEventId,
        suppressedAt: suppression.suppressedAt,
        note: input.note,
      },
    });
    await tx.emailSuppression.delete({
      where: { normalizedEmail: suppression.normalizedEmail },
    });
    return { released: true };
  });
}
