"use client";

import { useEffect, useState } from "react";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { Button } from "@/components/ui/button";

function selectableCheckboxes(formId: string): HTMLInputElement[] {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>(
      `input[form="${formId}"][name="emailIds"]:not(:disabled)`,
    ),
  );
}

export function selectedEmailRange(
  ids: readonly string[],
  anchorId: string,
  targetId: string,
): string[] {
  const anchor = ids.indexOf(anchorId);
  const target = ids.indexOf(targetId);
  if (anchor < 0 || target < 0) return [targetId];
  const start = Math.min(anchor, target);
  const end = Math.max(anchor, target);
  return ids.slice(start, end + 1);
}

export function EmailBulkSelection({
  action,
  formId,
  emailIds,
  view,
  returnTo,
}: {
  action: (formData: FormData) => void | Promise<void>;
  formId: string;
  emailIds: string[];
  view: "active" | "dismissed";
  returnTo?: string;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [anchorId, setAnchorId] = useState<string | null>(null);

  const refreshSelected = () => {
    setSelected(
      selectableCheckboxes(formId)
        .filter((checkbox) => checkbox.checked)
        .map((checkbox) => checkbox.value),
    );
  };

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (
        !(target instanceof HTMLInputElement) ||
        target.type !== "checkbox" ||
        target.name !== "emailIds" ||
        target.getAttribute("form") !== formId
      ) {
        return;
      }
      if (event.shiftKey && anchorId) {
        const range = new Set(selectedEmailRange(emailIds, anchorId, target.value));
        for (const checkbox of selectableCheckboxes(formId)) {
          if (range.has(checkbox.value)) checkbox.checked = target.checked;
        }
      }
      setAnchorId(target.value);
      queueMicrotask(refreshSelected);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [anchorId, emailIds, formId]);

  const selectAll = () => {
    for (const checkbox of selectableCheckboxes(formId)) {
      checkbox.checked = true;
    }
    refreshSelected();
  };

  const confirmation =
    view === "dismissed"
      ? `Restore ${selected.length} selected email${selected.length === 1 ? "" : "s"}?`
      : `Delete ${selected.length} selected email${selected.length === 1 ? "" : "s"} from this list? This only hides them; delivery history remains intact and scheduled sends are not cancelled.`;

  return (
    <form
      id={formId}
      action={action}
      className="mt-5 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950"
      onSubmit={(event) => {
        if (selected.length === 0 || !window.confirm(confirmation)) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="view" value={view} />
      {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
      <span className="text-sm text-zinc-500">
        {selected.length} selected
      </span>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={emailIds.length === 0}
          onClick={selectAll}
        >
          Select all
        </Button>
        <PendingSubmitButton
          variant={view === "dismissed" ? "secondary" : "danger"}
          size="sm"
          disabled={selected.length === 0}
          pendingLabel={view === "dismissed" ? "Restoring…" : "Deleting…"}
        >
          {view === "dismissed" ? "Restore selected" : "Delete selected"}
        </PendingSubmitButton>
      </div>
    </form>
  );
}
