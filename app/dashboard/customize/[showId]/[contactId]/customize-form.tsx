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
import {
  recipientDeliveryLayout,
  type RecipientDeliveryMode,
} from "@/lib/recipientDelivery";

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
  recipientDeliveryMode: RecipientDeliveryMode;
  primaryRecipientEmail: string | null;
  toRecipients: string[];
  ccRecipients: string[];
  providerLayouts: Array<{ to: string[]; cc: string[] }>;
  testSend: boolean;
  subject: string | null;
  html: string | null;
  contentLocked: boolean;
  statusMessage: string | null;
}

export function CustomizeForm({
  contextContactId,
  returnTo,
  recipientOptions,
  weekend,
  queueLabel,
  initialIntent,
  followUpMode,
  action,
}: {
  contextContactId: string;
  returnTo: string;
  recipientOptions: CustomizeRecipientOption[];
  weekend: boolean;
  queueLabel: string;
  initialIntent: "send" | "queue";
  followUpMode: boolean;
  action: (
    previousState: CustomizeActionState,
    formData: FormData,
  ) => Promise<CustomizeActionState>;
}) {
  const [selectedContactId, setSelectedContactId] =
    useState(contextContactId);
  const [recipientDeliveryMode, setRecipientDeliveryMode] =
    useState<RecipientDeliveryMode>(
      recipientOptions.find((option) => option.id === contextContactId)
        ?.recipientDeliveryMode ?? "individual_threads",
    );
  const [drafts, setDrafts] = useState<CustomizeRecipientDrafts>(() =>
    initializeCustomizeRecipientDrafts(recipientOptions),
  );
  const initialState: CustomizeActionState = {
    error: null,
    queuedFor: null,
    selectedContactId: contextContactId,
  };
  const [state, formAction] = useActionState(action, initialState);
  const selected =
    recipientOptions.find((option) => option.id === selectedContactId) ?? null;
  const isRetry = selected?.mode === "retry";
  const contentLocked = selected?.contentLocked === true;
  const selectedDraft = selected ? drafts[selected.id] ?? null : null;
  const visibleError =
    state.error && state.selectedContactId === selectedContactId
      ? state.error
      : null;
  const canChooseDeliveryMode =
    selected?.mode === "new" &&
    !contentLocked &&
    (selected?.recipients.length ?? 0) > 1;
  const primaryRecipientEmail =
    recipientDeliveryMode === "cc_thread"
      ? selected?.recipients.includes(selected.email)
        ? selected.email
        : selected?.primaryRecipientEmail ?? selected?.recipients[0] ?? null
      : null;
  const previewLayouts = selected
    ? contentLocked || selected.testSend
      ? selected.providerLayouts.length > 0
        ? selected.providerLayouts
        : [{ to: selected.toRecipients, cc: selected.ccRecipients }]
      : recipientDeliveryMode === "individual_threads"
        ? selected.recipients.map((email) => ({ to: [email], cc: [] }))
        : [
            recipientDeliveryLayout(
              selected.recipients,
              primaryRecipientEmail,
              recipientDeliveryMode,
            ),
          ]
    : [];

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
      <input
        type="hidden"
        name="recipientDeliveryMode"
        value={recipientDeliveryMode}
      />
      <div>
        <label htmlFor="selected-contact" className="text-sm font-medium">
          {selected && selected.recipients.length > 1
            ? "Primary email recipient"
            : "Email recipient"}
        </label>
        <select
          id="selected-contact"
          value={selectedContactId}
          onChange={(event) => setSelectedContactId(event.target.value)}
          disabled={followUpMode || isRetry}
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
            {followUpMode
              ? selected.contentLocked
                ? `This follow-up uses the immutable recipient snapshot: ${selected.recipients.join(", ")}.`
                : `This follow-up will be sent to the current active management recipient${
                    selected.recipients.length === 1 ? "" : "s"
                  }: ${selected.recipients.join(", ")}.`
              : isRetry
              ? `This retry will use the original immutable recipient${
                  selected.recipients.length === 1 ? "" : "s"
                }: ${selected.recipients.join(", ")}.`
              : selected.recipients.length > 1
                ? `This email will be sent to the current active management recipients: ${selected.recipients.join(", ")}.`
                : `This email will be sent only to ${selected.email}.`}
          </p>
        )}
        {canChooseDeliveryMode && (
          <label className="mt-3 flex items-start gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <input
              type="checkbox"
              checked={recipientDeliveryMode === "cc_thread"}
              onChange={(event) =>
                setRecipientDeliveryMode(
                  event.target.checked ? "cc_thread" : "individual_threads",
                )
              }
              className="mt-0.5 h-4 w-4 accent-zinc-900 dark:accent-zinc-100"
            />
            <span>
              <span className="block text-sm font-medium">
                Keep recipients on one email thread
              </span>
              <span className="mt-1 block text-xs text-zinc-500">
                Put the primary recipient in To and the remaining management
                contacts in CC. Off by default, each To recipient receives a
                separate thread.
              </span>
            </span>
          </label>
        )}
        {selected?.eligible && selected.recipients.length > 1 && (
          <div className="mt-3 rounded-lg bg-zinc-50 px-3 py-2 text-xs dark:bg-zinc-900">
            {previewLayouts.map((layout, index) => (
              <div key={`${layout.to.join(",")}:${index}`} className={index ? "mt-2" : ""}>
                {previewLayouts.length > 1 && (
                  <p className="font-medium">Message {index + 1}</p>
                )}
                <p>
                  <b>To:</b> {layout.to.join(", ") || "—"}
                </p>
                <p className="mt-1">
                  <b>CC:</b> {layout.cc.join(", ") || "—"}
                </p>
              </div>
            ))}
            {selected.testSend && (
              <p className="mt-1 text-amber-700 dark:text-amber-300">
                Test override is active; this is the resolved provider layout.
              </p>
            )}
          </div>
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
      {initialIntent === "queue" && !state.queuedFor && (
        <div
          role="status"
          className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200"
        >
          Choose the intended recipient, review the composed email, then queue
          it for the next normal dispatch.
        </div>
      )}
      {state.queuedFor && state.selectedContactId === selectedContactId && (
        <div
          role="status"
          className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
        >
          Email queued for {state.queuedFor} ET. The immutable recipient and
          composed content snapshots will be rechecked against current sending
          policy at dispatch.
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
      {selected?.statusMessage && (
        <div
          role="status"
          className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
        >
          {selected.statusMessage}
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
          disabled={contentLocked}
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

      <div className="flex flex-wrap gap-2">
        <PendingSubmitButton
          variant={initialIntent === "send" ? "primary" : "secondary"}
          name="intent"
          value="send"
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
            : followUpMode
              ? weekend
                ? "Schedule follow-up"
                : "Send follow-up now"
            : weekend
              ? "Schedule Monday"
              : "Send now"}
        </PendingSubmitButton>
        <PendingSubmitButton
          variant={initialIntent === "queue" ? "primary" : "secondary"}
          name="intent"
          value="queue"
          disabled={!selected?.sendable || !selectedDraft}
          pendingLabel="Queueing…"
        >
          {queueLabel}
        </PendingSubmitButton>
        <LinkButton href={returnTo} variant="secondary">
          Cancel
        </LinkButton>
      </div>
    </form>
  );
}
