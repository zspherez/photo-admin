"use client";

import { useEffect, useState, type ReactNode } from "react";

const STATUS_PARAMS = [
  "approved",
  "detail",
  "eligible",
  "enqueued",
  "error",
  "notes_saved",
  "refreshed",
  "rejected",
  "retried",
  "sheet_error",
];

export function AutoDismissStatus({
  children,
}: {
  children: ReactNode;
}) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setVisible(false);
      const url = new URL(window.location.href);
      for (const parameter of STATUS_PARAMS) {
        url.searchParams.delete(parameter);
      }
      window.history.replaceState(
        window.history.state,
        "",
        `${url.pathname}${url.search}${url.hash}`
      );
    }, 3_000);
    return () => window.clearTimeout(timer);
  }, []);

  return visible ? children : null;
}
