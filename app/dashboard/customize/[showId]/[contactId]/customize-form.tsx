"use client";

import { useActionState, useState } from "react";
import { LinkButton } from "@/components/ui/button";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { TemplateEditor } from "@/components/template-editor";
import {
  initializeCustomizeRecipientDrafts,
  updateCustomizeRecipientDraft,
  type CustomizeRecipientDrafts,
} from "@/lib/customizeRecipientDrafts";
import type { CustomizeActionState } from "./actions";

export interface CustomizeRecipientOption {
  id: string;
  artistId: string;
  email: string;
  updatedAt: string;
  label: string;
  eligible: boolean;
  selectable: boolean;
  sendable: boolean;
  mode: "new" | "retry" | null;
  reason: string | null;
  recipients: string[];
  isFullTeam: boolean;
  subject: string | null;
  html: string | null;
}

export function CustomizeForm({
  contextContactId,
  returnTo,
  recipientOptions,
  weekend,
  action,
}: {
  contextContactId: string;
  returnTo: string;
  recipientOptions: CustomizeRecipientOption[];
  weekend: boolean;
  action: (
    previousState: CustomizeActionState,
    formData: FormData,
  ) => Promise<CustomizeActionState>;
}) {
  const [selectedContactId, setSelectedContactId] =
    useState(contextContactId);
  const [drafts, setDrafts] = useState<CustomizeRecipientDrafts>(() =>
    initializeCustomizeRecipientDrafts(recipientOptions),
  );
  const initialState: CustomizeActionState = {
    error: null,
    selectedContactId: contextContactId,
  };
  const [state, formAction] = useActionState(action, initialState);
  const selected =
    recipientOptions.find((option) => option.id === selectedContactId) ?? null;
  const isRetry = selected?.mode === "retry";
  const selectedDraft = selected ? drafts[selected.id] ?? null : null;
  const visibleError =
    state.error && state.selectedContactId === selectedContactId
      ? state.error
      : null;

  return (
    <form action={formAction} className="space-y-4">
      <input
        type="hidden"
        name="selectedContactId"
        value={selectedContactId}
      />
      <input
        type="hidden"
        name="expectedRecipientEmail"
        value={selected?.email ?? ""}
      />
      <input
        type="hidden"
        name="expectedRecipientArtistId"
        value={selected?.artistId ?? ""}
      />
      <input
        type="hidden"
        name="expectedRecipientUpdatedAt"
        value={selected?.updatedAt ?? ""}
      />
      <div>
        <label htmlFor="selected-contact" className="text-sm font-medium">
          Email recipient
        </label>
        <select
          id="selected-contact"
          value={selectedContactId}
          onChange={(event) => setSelectedContactId(event.target.value)}
          disabled={isRetry}
          className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          {recipientOptions.map((option) => (
            <option
              key={option.id}
              value={option.id}
              disabled={!option.selectable}
            >
              {option.label}
            </option>
          ))}
        </select>
        {selected?.eligible && (
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
            {isRetry
              ? `This retry will use the original immutable recipient${
                  selected.recipients.length === 1 ? "" : "s"
                }: ${selected.recipients.join(", ")}.`
              : `This email will be sent only to ${selected.email}.`}
            {selected.isFullTeam && !isRetry
              ? " This contact is marked full team, but Customize sends only to the selected address."
              : ""}
          </p>
        )}
      </div>

      {visibleError && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
        >
          {visibleError}
        </div>
      )}
      {selected && !selected.sendable && (
        <div
          role="alert"
          className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
        >
          {selected.reason ?? "Email outreach is unavailable."}
        </div>
      )}
      {isRetry && selected?.sendable && (
        <div
          role="status"
          className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
        >
          This retry will reuse the original immutable recipients, subject,
          body, and attachment snapshot. Editing is disabled.
        </div>
      )}

      {selectedDraft ? (
        <TemplateEditor
          initialSubject={selectedDraft.subject}
          initialHtml={selectedDraft.html}
          subjectValue={selectedDraft.subject}
          htmlValue={selectedDraft.html}
          onSubjectChange={(subject) =>
            setDrafts((current) =>
              updateCustomizeRecipientDraft(
                current,
                selectedContactId,
                selectedDraft,
                { subject },
              ),
            )
          }
          onHtmlChange={(html) =>
            setDrafts((current) =>
              updateCustomizeRecipientDraft(
                current,
                selectedContactId,
                selectedDraft,
                { html },
              ),
            )
          }
          variables={[]}
          disabled={isRetry}
        />
      ) : (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
        >
          {isRetry
            ? "The immutable retry content is unavailable. Sending is disabled."
            : "Email content is unavailable. Sending is disabled."}
        </div>
      )}

      <div className="flex gap-2">
        <PendingSubmitButton
          variant="primary"
          disabled={!selected?.sendable || !selectedDraft}
          pendingLabel={
            isRetry
              ? weekend
                ? "Scheduling retry…"
                : "Retrying…"
              : weekend
                ? "Scheduling…"
                : "Sending…"
          }
        >
          {isRetry
            ? weekend
              ? "Schedule retry"
              : "Retry now"
            : weekend
              ? "Schedule Monday"
              : "Send now"}
        </PendingSubmitButton>
        <LinkButton href={returnTo} variant="secondary">
          Cancel
        </LinkButton>
      </div>
    </form>
  );
}
