export interface ContactDisplayChannels {
  email: string | null;
  phone: string | null;
  directOutreachNote: string | null;
}

function trimmed(value: string | null): string | null {
  return value?.trim() || null;
}

export function contactDisplayValue(
  contact: ContactDisplayChannels,
  fallback = "(no contact info)",
): string {
  return (
    trimmed(contact.email) ??
    trimmed(contact.phone) ??
    trimmed(contact.directOutreachNote) ??
    fallback
  );
}

export function directOutreachNoteValue(
  contact: ContactDisplayChannels,
): string | null {
  return trimmed(contact.directOutreachNote);
}

export function hasDirectOutreachNote(
  contact: ContactDisplayChannels,
): boolean {
  return directOutreachNoteValue(contact) !== null;
}

export function isDirectOutreachOnly(
  contact: ContactDisplayChannels,
): boolean {
  return (
    !trimmed(contact.email) &&
    !trimmed(contact.phone) &&
    hasDirectOutreachNote(contact)
  );
}
