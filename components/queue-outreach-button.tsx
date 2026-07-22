"use client";

import { LinkButton } from "@/components/ui/button";
import { PendingSubmitButton } from "@/components/pending-submit-button";

type FormAction = (formData: FormData) => void | Promise<void>;

export function QueueOutreachButton({
  showId,
  contactId,
  returnTo,
  queueLabel,
  customizeHref,
  action,
}: {
  showId: string;
  contactId: string;
  returnTo: string;
  queueLabel: string;
  customizeHref: string | null;
  action: FormAction;
}) {
  if (customizeHref) {
    return (
      <LinkButton href={customizeHref} variant="secondary" size="sm">
        {queueLabel}
      </LinkButton>
    );
  }

  return (
    <form action={action}>
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="contactId" value={contactId} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <PendingSubmitButton
        variant="secondary"
        size="sm"
        pendingLabel="Queueing…"
      >
        {queueLabel}
      </PendingSubmitButton>
    </form>
  );
}
