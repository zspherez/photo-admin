"use client";

import { PendingSubmitButton } from "@/components/pending-submit-button";
import { rejectWorkflowTargetAction } from "@/app/dashboard/actions";

type HiddenField = { name: string; value: string };

export function RejectWorkflowTargetButton({
  showId,
  targetArtistId,
  returnTo,
  hiddenFields = [],
}: {
  showId: string;
  targetArtistId: string;
  returnTo: string;
  hiddenFields?: readonly HiddenField[];
}) {
  return (
    <form action={rejectWorkflowTargetAction}>
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="targetArtistId" value={targetArtistId} />
      <input type="hidden" name="returnTo" value={returnTo} />
      {hiddenFields.map((field) => (
        <input key={field.name} type="hidden" {...field} />
      ))}
      <PendingSubmitButton
        variant="danger"
        size="sm"
        pendingLabel="Rejecting…"
      >
        Reject
      </PendingSubmitButton>
    </form>
  );
}
