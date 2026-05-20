"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

const ITEMS: { href: string; label: string; match: (p: string) => boolean }[] = [
  { href: "/dashboard", label: "Shows", match: (p) => p === "/dashboard" || p.startsWith("/dashboard/") },
  { href: "/festivals", label: "Festivals", match: (p) => p === "/festivals" || p.startsWith("/festivals/") },
  { href: "/new", label: "New", match: (p) => p === "/new" },
  { href: "/shows", label: "All shows", match: (p) => p === "/shows" },
  { href: "/settings", label: "Settings", match: (p) => p === "/settings" || p.startsWith("/settings/") },
];

export function Nav() {
  const pathname = usePathname() ?? "/";
  if (pathname === "/login") return null;

  return (
    <header className="sticky top-0 z-30 border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
      <div className="mx-auto flex h-12 max-w-6xl items-center justify-between gap-6 px-6">
        <Link
          href="/"
          className="flex items-center gap-2 text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-100"
        >
          <span className="inline-block h-2 w-2 rounded-sm bg-zinc-900 dark:bg-zinc-100" />
          photo-admin
        </Link>
        <nav className="flex items-center gap-1">
          {ITEMS.map((item) => {
            const active = item.match(pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "rounded-md px-2.5 py-1 text-sm transition",
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
        <form action="/api/auth/logout" method="post" className="hidden sm:block">
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
