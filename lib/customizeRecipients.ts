import { normalizeEmail, normalizeEmails } from "@/lib/resend";
import {
  applyHtmlTemplate,
  applyTemplate,
  type TemplateVars,
} from "@/lib/template";

export interface CustomizeRecipientContact {
  id: string;
  artistId: string;
  email: string | null;
  state: "active" | "quarantined";
  createdAt: Date;
  updatedAt: Date;
}

export interface CustomizeRecipientIdentity {
  contactId: string;
  artistId: string;
  normalizedEmail: string;
  updatedAt: string;
}

export function customizeRecipientIdentity(
  contact: Pick<
    CustomizeRecipientContact,
    "id" | "artistId" | "email" | "updatedAt"
  >,
): CustomizeRecipientIdentity | null {
  const normalizedEmail = normalizeEmail(contact.email ?? "");
  return normalizedEmail
    ? {
        contactId: contact.id,
        artistId: contact.artistId,
        normalizedEmail,
        updatedAt: contact.updatedAt.toISOString(),
      }
    : null;
}

export function customizeRecipientIdentityError(
  contact: Pick<
    CustomizeRecipientContact,
    "id" | "artistId" | "email" | "updatedAt"
  > | null,
  expected: CustomizeRecipientIdentity | null,
): string | null {
  if (!contact || !expected) {
    return "Selected recipient identity is missing or invalid";
  }
  const current = customizeRecipientIdentity(contact);
  if (!current) return "Selected recipient has no valid email address";
  if (current.contactId !== expected.contactId) {
    return "Selected recipient changed since this page loaded";
  }
  if (current.artistId !== expected.artistId) {
    return "Selected recipient artist changed since this page loaded";
  }
  if (current.normalizedEmail !== expected.normalizedEmail) {
    return "Selected recipient email changed since this page loaded";
  }
  if (current.updatedAt !== expected.updatedAt) {
    return "Selected recipient was updated since this page loaded";
  }
  return null;
}

export function renderCustomizeRecipientContent(
  template: { subject: string; htmlBody: string },
  vars: TemplateVars,
): { subject: string; html: string } {
  return {
    subject: applyTemplate(template.subject, vars),
    html: applyHtmlTemplate(template.htmlBody, vars),
  };
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
