"use client";

import { Children, useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

const DEFAULT_VISIBLE_CLICKS = 5;

export function RecentLinkClicks({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const clicks = Children.toArray(children);
  const visibleClicks = expanded
    ? clicks
    : clicks.slice(0, DEFAULT_VISIBLE_CLICKS);

  return (
    <>
      <ul
        id={listId}
        className="divide-y divide-zinc-100 dark:divide-zinc-900"
      >
        {visibleClicks}
      </ul>
      {clicks.length > DEFAULT_VISIBLE_CLICKS && (
        <div className="border-t border-zinc-100 px-4 py-2 dark:border-zinc-900">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded
              ? "Show 5 most recent"
              : `Show all ${clicks.length} clicks`}
          </Button>
        </div>
      )}
    </>
  );
}
