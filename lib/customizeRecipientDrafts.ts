export interface CustomizeRecipientDraft {
  subject: string;
  html: string;
}

export type CustomizeRecipientDrafts = Record<string, CustomizeRecipientDraft>;

export function initializeCustomizeRecipientDrafts(
  options: readonly {
    id: string;
    subject: string | null;
    html: string | null;
  }[],
): CustomizeRecipientDrafts {
  return Object.fromEntries(
    options.flatMap((option) =>
      option.subject !== null && option.html !== null
        ? [[option.id, { subject: option.subject, html: option.html }]]
        : [],
    ),
  );
}

export function updateCustomizeRecipientDraft(
  drafts: CustomizeRecipientDrafts,
  contactId: string,
  fallback: CustomizeRecipientDraft,
  update: Partial<CustomizeRecipientDraft>,
): CustomizeRecipientDrafts {
  return {
    ...drafts,
    [contactId]: {
      ...(drafts[contactId] ?? fallback),
      ...update,
    },
  };
}
