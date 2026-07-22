import Link from "next/link";
import { LinkButton } from "@/components/ui/button";
import { cn } from "@/lib/cn";

const SECTIONS = [
  { key: "outreach", href: "/outreach", label: "Outreach" },
  { key: "custom", href: "/emails", label: "Custom emails" },
] as const;

export function EmailCenterHeader({
  active,
}: {
  active: (typeof SECTIONS)[number]["key"];
}) {
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Emails</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Show outreach and custom messages with delivery and engagement
            history.
          </p>
        </div>
        <LinkButton href="/emails/new">Compose</LinkButton>
      </div>

      <nav
        aria-label="Email sections"
        className="mt-5 flex gap-1 rounded-lg border border-zinc-200 bg-zinc-50 p-1 dark:border-zinc-800 dark:bg-zinc-900"
      >
        {SECTIONS.map((section) => (
          <Link
            key={section.key}
            href={section.href}
            aria-current={active === section.key ? "page" : undefined}
            className={cn(
              "flex min-h-10 flex-1 items-center justify-center rounded-md px-3 text-sm font-medium transition",
              active === section.key
                ? "bg-white text-zinc-950 shadow-sm dark:bg-zinc-950 dark:text-zinc-50"
                : "text-zinc-500 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-50",
            )}
          >
            {section.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
