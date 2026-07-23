"use client";

import { useEffect, useState } from "react";

export function ReadOnlyMode() {
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    const blockMutationForm = (event: SubmitEvent) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      const method = form.method.toLowerCase();
      const actionPath = new URL(form.action, window.location.href).pathname;
      if (method === "get" || actionPath === "/api/auth/logout") return;
      event.preventDefault();
      event.stopPropagation();
      setBlocked(true);
    };
    document.addEventListener("submit", blockMutationForm, true);
    return () => document.removeEventListener("submit", blockMutationForm, true);
  }, []);

  return (
    <div
      className="sticky top-0 z-[60] border-b border-amber-300 bg-amber-50 px-4 py-2 text-center text-xs font-medium text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
      role="status"
    >
      Read-only session: viewing and filters are available; saves, syncs,
      queues, and sends are blocked.
      {blocked && (
        <span className="ml-1 font-semibold">
          This action was not submitted.
        </span>
      )}
    </div>
  );
}
