export interface ContactChannels {
  email: string | null;
  phone: string | null;
  directOutreachNote?: string | null;
  isFullTeam: boolean;
  state: "active" | "quarantined";
}

function hasValue(value: string | null): boolean {
  return Boolean(value?.trim());
}

export function pickEmailContact<T extends ContactChannels>(
  contacts: readonly T[]
): T | null {
  const activeContacts = contacts.filter(
    (contact) => contact.state === "active"
  );
  return (
    activeContacts.find(
      (contact) => contact.isFullTeam && hasValue(contact.email)
    ) ??
    activeContacts.find((contact) => hasValue(contact.email)) ??
    null
  );
}

export function pickPhoneContact<T extends ContactChannels>(
  contacts: readonly T[],
  preferred: T | null = null
): T | null {
  if (
    preferred?.state === "active" &&
    hasValue(preferred.phone)
  ) {
    return preferred;
  }
  return (
    contacts.find(
      (contact) => contact.state === "active" && hasValue(contact.phone)
    ) ?? null
  );
}

export function pickDirectOutreachContact<T extends ContactChannels>(
  contacts: readonly T[]
): T | null {
  return (
    contacts.find(
      (contact) =>
        contact.state === "active" &&
        !hasValue(contact.email) &&
        !hasValue(contact.phone) &&
        hasValue(contact.directOutreachNote ?? null)
    ) ?? null
  );
}
