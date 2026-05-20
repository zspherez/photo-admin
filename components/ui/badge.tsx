import * as React from "react";
import { cn } from "@/lib/cn";

export type BadgeTone =
  | "default"
  | "muted"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "accent";

const TONE_CLASSES: Record<BadgeTone, string> = {
  default:
    "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  muted:
    "border border-zinc-200 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400",
  success:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  warning:
    "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  danger:
    "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  info: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  accent:
    "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300",
};

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  size?: "xs" | "sm";
}

export function Badge({
  tone = "default",
  size = "sm",
  className,
  ...props
}: BadgeProps) {
  return (
    <span
      {...props}
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 font-medium",
        size === "xs" ? "text-[10px] uppercase tracking-wide" : "text-xs",
        TONE_CLASSES[tone],
        className
      )}
    />
  );
}
