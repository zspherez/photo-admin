"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { Button } from "@/components/ui/button";

export interface FestivalBulkConfirmationCandidate {
  contactId: string;
  artistName: string;
  groupKey: string;
  emailLabel: string;
  selectedByDefault: boolean;
}

interface ConfirmationGroup {
  groupKey: string;
  emailLabel: string;
  artistNames: string[];
}

export function buildFestivalConfirmationGroups(
  candidates: readonly FestivalBulkConfirmationCandidate[],
  selectedContactIds: readonly string[],
): ConfirmationGroup[] {
  const selected = new Set(selectedContactIds);
  const groups = new Map<string, ConfirmationGroup>();
  for (const candidate of candidates) {
    if (!selected.has(candidate.contactId)) continue;
    const existing = groups.get(candidate.groupKey);
    if (existing) {
      existing.artistNames.push(candidate.artistName);
    } else {
      groups.set(candidate.groupKey, {
        groupKey: candidate.groupKey,
        emailLabel: candidate.emailLabel,
        artistNames: [candidate.artistName],
      });
    }
  }
  return [...groups.values()];
}

function selectedCheckboxes(formId: string): HTMLInputElement[] {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>(
      `input[form="${formId}"][name="contactIds"]:not(:disabled)`,
    ),
  );
}

export function FestivalBulkOutreachForm({
  action,
  formId,
  hiddenFields,
  candidates,
}: {
  action: (formData: FormData) => void | Promise<void>;
  formId: string;
  hiddenFields: Record<string, string>;
  candidates: FestivalBulkConfirmationCandidate[];
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    candidates
      .filter((candidate) => candidate.selectedByDefault)
      .map((candidate) => candidate.contactId),
  );
  const [confirming, setConfirming] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);

  const refreshSelection = () => {
    setSelectedIds(
      selectedCheckboxes(formId)
        .filter((checkbox) => checkbox.checked)
        .map((checkbox) => checkbox.value),
    );
  };

  useEffect(() => {
    const onChange = (event: Event) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement &&
        target.name === "contactIds" &&
        target.getAttribute("form") === formId
      ) {
        refreshSelection();
      }
    };
    document.addEventListener("change", onChange);
    return () => document.removeEventListener("change", onChange);
  }, [formId]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !confirming || dialog.open) return;
    dialog.showModal();
  }, [confirming]);

  const confirmationGroups = useMemo(() => {
    return buildFestivalConfirmationGroups(candidates, selectedIds);
  }, [candidates, selectedIds]);

  const selectAll = () => {
    for (const checkbox of selectedCheckboxes(formId)) {
      checkbox.checked = true;
    }
    setSelectionError(null);
    refreshSelection();
  };

  const openConfirmation = () => {
    refreshSelection();
    if (
      selectedCheckboxes(formId).every((checkbox) => !checkbox.checked)
    ) {
      setSelectionError("Select at least one sendable artist.");
      return;
    }
    setSelectionError(null);
    setConfirming(true);
  };

  return (
    <form
      ref={formRef}
      id={formId}
      action={action}
      className="mt-6"
      aria-label="Bulk festival outreach"
    >
      {Object.entries(hiddenFields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <div className="z-20 -mx-1 mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-white/95 px-4 py-2 shadow-sm backdrop-blur sm:sticky sm:top-12 dark:border-zinc-800 dark:bg-zinc-950/95">
        <span className="text-sm text-zinc-600 dark:text-zinc-400">
          {candidates.length} sendable · <b>{selectedIds.length}</b> selected
        </span>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={candidates.length === 0}
            onClick={selectAll}
          >
            Select all
          </Button>
          <Button
            type="button"
            variant="primary"
            size="md"
            disabled={candidates.length === 0}
            onClick={openConfirmation}
          >
            Send to selected
          </Button>
        </div>
      </div>
      {selectionError && (
        <p
          role="alert"
          className="mb-3 text-sm text-red-700 dark:text-red-300"
        >
          {selectionError}
        </p>
      )}

      {confirming && (
        <dialog
          ref={dialogRef}
          aria-labelledby={`${formId}-confirmation-title`}
          onCancel={() => setConfirming(false)}
          onClose={() => setConfirming(false)}
          className="max-h-[85vh] w-[calc(100%-2rem)] max-w-3xl overflow-auto rounded-xl bg-white p-5 text-zinc-900 shadow-xl backdrop:bg-black/50 dark:bg-zinc-950 dark:text-zinc-100"
        >
            <h2
              id={`${formId}-confirmation-title`}
              className="text-lg font-semibold"
            >
              Confirm festival outreach
            </h2>
            <p className="mt-1 text-sm text-zinc-500">
              Shared rows send one email covering every listed artist.
            </p>
            <div className="mt-4 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
              <table className="w-full text-left text-sm">
                <thead className="bg-zinc-50 text-xs uppercase text-zinc-500 dark:bg-zinc-900">
                  <tr>
                    <th className="px-3 py-2">Email</th>
                    <th className="px-3 py-2">Associated artists</th>
                    <th className="px-3 py-2">Email format</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                  {confirmationGroups.map((group) => (
                    <tr key={group.groupKey}>
                      <td className="break-all px-3 py-2">
                        {group.emailLabel}
                      </td>
                      <td className="px-3 py-2">
                        {group.artistNames.join(", ")}
                      </td>
                      <td className="px-3 py-2 font-medium">
                        {group.artistNames.length > 1
                          ? "Shared"
                          : "Individual"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                autoFocus
                onClick={() => dialogRef.current?.close()}
              >
                Go back
              </Button>
              <PendingSubmitButton pendingLabel="Processing…">
                Confirm send / schedule
              </PendingSubmitButton>
            </div>
        </dialog>
      )}
    </form>
  );
}
