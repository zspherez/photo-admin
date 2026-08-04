export const DEFAULT_RECIPIENT_DELIVERY_MODE = "individual_threads";

export type RecipientDeliveryMode =
  | "individual_threads"
  | "cc_thread";

export function isRecipientDeliveryMode(
  value: unknown,
): value is RecipientDeliveryMode {
  return value === "individual_threads" || value === "cc_thread";
}

export function recipientDeliveryLayout(
  recipients: readonly string[],
  primaryRecipientEmail: string | null,
  mode: RecipientDeliveryMode,
): { to: string[]; cc: string[] } {
  if (mode === "individual_threads") {
    return { to: [...recipients], cc: [] };
  }
  const primary =
    (primaryRecipientEmail &&
      recipients.find((email) => email === primaryRecipientEmail)) ||
    recipients[0];
  if (!primary) return { to: [], cc: [] };
  return {
    to: [primary],
    cc: recipients.filter((email) => email !== primary),
  };
}
