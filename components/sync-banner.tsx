import { cn } from "@/lib/cn";

export function SyncBanner({
  tone,
  title,
  detail,
}: {
  tone: "success" | "error";
  title: string;
  detail?: string | null;
}) {
  return (
    <div
      className={cn(
        "mt-4 rounded-lg border px-4 py-2 text-sm",
        tone === "success"
          ? "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
          : "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200",
      )}
    >
      <span className="font-medium">{title}</span>
      {detail && <span className="ml-2 text-xs opacity-80">{detail}</span>}
    </div>
  );
}
