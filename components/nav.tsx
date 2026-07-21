"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

const ITEMS: { href: string; label: string; match: (p: string) => boolean }[] = [
  { href: "/dashboard", label: "Shows", match: (p) => p === "/dashboard" || p.startsWith("/dashboard/") },
  { href: "/recommendations", label: "Recommendations", match: (p) => p === "/recommendations" || p.startsWith("/recommendations/") },
  { href: "/festivals", label: "Festivals", match: (p) => p === "/festivals" || p.startsWith("/festivals/") },
  { href: "/new", label: "New", match: (p) => p === "/new" },
  { href: "/research", label: "Research", match: (p) => p === "/research" },
  { href: "/contacts", label: "Contacts", match: (p) => p === "/contacts" },
  { href: "/contact-audit", label: "Audit", match: (p) => p === "/contact-audit" },
  { href: "/outreach", label: "Sent", match: (p) => p === "/outreach" || p.startsWith("/outreach/") },
  { href: "/emails", label: "Emails", match: (p) => p === "/emails" || p.startsWith("/emails/") },
  { href: "/shows", label: "All shows / Sync", match: (p) => p === "/shows" },
  { href: "/settings", label: "Settings", match: (p) => p === "/settings" || p.startsWith("/settings/") },
];

export function Nav() {
  const pathname = usePathname() ?? "/";
  if (pathname === "/login" || pathname === "/test") return null;

  return (
    <header className="sticky top-0 z-30 border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 sm:h-12 sm:flex-nowrap sm:px-6 sm:py-0">
        <Link
          href="/"
          className="flex min-w-0 items-center gap-2 text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-100"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="" className="h-6 w-auto dark:brightness-200" />
          <span className="truncate sm:hidden">Photo Admin</span>
          <span className="hidden truncate sm:inline">Rehders Photos Admin</span>
        </Link>
        <nav
          aria-label="Primary navigation"
          className="order-3 -mx-4 flex w-[calc(100%+2rem)] items-center gap-1 overflow-x-auto px-4 pb-1 sm:order-none sm:mx-0 sm:w-auto sm:min-w-0 sm:flex-1 sm:justify-end sm:overflow-visible sm:px-0 sm:pb-0"
        >
          {ITEMS.map((item) => {
            const active = item.match(pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "shrink-0 whitespace-nowrap rounded-md px-2.5 py-1 text-sm transition",
                  active
                    ? "bg-zinc-100 font-medium text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100"
                    : "text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <form action="/api/auth/logout" method="post" className="ml-auto shrink-0 sm:ml-0">
          <button
            type="submit"
            className="text-xs text-zinc-500 hover:text-zinc-900 dark:text-zinc-500 dark:hover:text-zinc-200"
          >
            Log out
          </button>
        </form>
      </div>
    </header>
  );
}
