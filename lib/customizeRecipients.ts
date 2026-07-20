import { normalizeEmail, normalizeEmails } from "@/lib/resend";

export interface CustomizeRecipientContact {
  id: string;
  artistId: string;
  email: string | null;
  state: "active" | "quarantined";
  createdAt: Date;
}

function orderedContacts<T extends CustomizeRecipientContact>(
  contacts: readonly T[],
  contextContactId: string,
): T[] {
  return [...contacts].sort((left, right) => {
    if (left.id === contextContactId) return -1;
    if (right.id === contextContactId) return 1;
    const created = left.createdAt.getTime() - right.createdAt.getTime();
    return created || left.id.localeCompare(right.id);
  });
}

export function eligibleCustomizeRecipientContacts<
  T extends CustomizeRecipientContact,
>(
  contacts: readonly T[],
  contextContactId: string,
  suppressedEmails: readonly string[] = [],
): T[] {
  const suppressed = new Set(normalizeEmails([...suppressedEmails]));
  const seen = new Set<string>();
  const eligible: T[] = [];

  for (const contact of orderedContacts(contacts, contextContactId)) {
    const email = normalizeEmail(contact.email ?? "");
    if (
      contact.state !== "active" ||
      !email ||
      suppressed.has(email) ||
      seen.has(email)
    ) {
      continue;
    }
    seen.add(email);
    eligible.push(contact);
  }

  return eligible;
}

export function customizeRecipientSelectionError({
  contextContact,
  selectedContact,
  artistContacts,
  suppressedEmails = [],
}: {
  contextContact: CustomizeRecipientContact | null;
  selectedContact: CustomizeRecipientContact | null;
  artistContacts: readonly CustomizeRecipientContact[];
  suppressedEmails?: readonly string[];
}): string | null {
  if (!contextContact || contextContact.state !== "active") {
    return "Outreach context contact is no longer active";
  }
  if (!selectedContact) return "Selected recipient is no longer available";
  if (selectedContact.artistId !== contextContact.artistId) {
    return "Selected recipient must belong to the same artist";
  }
  if (selectedContact.state !== "active") {
    return "Selected recipient is quarantined";
  }
  const selectedEmail = normalizeEmail(selectedContact.email ?? "");
  if (!selectedEmail) return "Selected recipient has no valid email address";
  if (normalizeEmails([...suppressedEmails]).includes(selectedEmail)) {
    return "Selected recipient address is suppressed";
  }
  const eligible = eligibleCustomizeRecipientContacts(
    artistContacts,
    contextContact.id,
    suppressedEmails,
  );
  if (!eligible.some((contact) => contact.id === selectedContact.id)) {
    return "Selected recipient duplicates another active contact address";
  }
  return null;
}
