"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import { appConfig } from "@/lib/appConfig";

const ITEMS: { href: string; label: string; match: (p: string) => boolean }[] = [
  { href: "/dashboard", label: "Shows", match: (p) => p === "/dashboard" || p.startsWith("/dashboard/") },
  { href: "/recommendations", label: "Recommendations", match: (p) => p === "/recommendations" || p.startsWith("/recommendations/") },
  { href: "/festivals", label: "Festivals", match: (p) => p === "/festivals" || p.startsWith("/festivals/") },
  { href: "/research", label: "Research", match: (p) => p === "/research" },
  { href: "/contacts", label: "Contacts", match: (p) => p === "/contacts" },
  { href: "/contact-audit", label: "Audit", match: (p) => p === "/contact-audit" },
  {
    href: "/emails",
    label: "Emails",
    match: (p) =>
      p === "/emails" ||
      p.startsWith("/emails/") ||
      p === "/outreach" ||
      p.startsWith("/outreach/"),
  },
  { href: "/shows", label: "All shows / Sync", match: (p) => p === "/shows" },
  { href: "/settings", label: "Settings", match: (p) => p === "/settings" || p.startsWith("/settings/") },
];

const MOBILE_ITEMS = [
  { href: "/dashboard", label: "Shows", icon: "shows" },
  { href: "/research", label: "Research", icon: "research" },
  { href: "/contact-audit", label: "Audit", icon: "audit" },
  { href: "/emails", label: "Emails", icon: "emails" },
] as const;

function NavIcon({
  name,
}: {
  name: (typeof MOBILE_ITEMS)[number]["icon"] | "more";
}) {
  const paths = {
    shows: <path d="M4 6h16M6 3v6m12-6v6M5 10h14v10H5z" />,
    research: <path d="m15 15 5 5m-2-10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" />,
    audit: <path d="M9 4h6l1 3h3v13H5V7h3l1-3Zm0 9 2 2 4-5" />,
    emails: <path d="M3 6h18v12H3V6Zm1 1 8 6 8-6" />,
    more: (
      <>
        <circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none" />
        <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
        <circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none" />
      </>
    ),
  };

  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}

export function Nav() {
  const pathname = usePathname() ?? "/";
  const mobileMenuRef = useRef<HTMLDetailsElement>(null);

  const closeMobileMenu = () => {
    if (mobileMenuRef.current) mobileMenuRef.current.open = false;
  };

  useEffect(() => {
    closeMobileMenu();
  }, [pathname]);

  if (pathname === "/login" || pathname === "/test") return null;
  const activeItem = ITEMS.find((item) => item.match(pathname));

  return (
    <>
      <header className="app-header-safe sticky top-0 z-30 border-b border-zinc-200 bg-white/90 backdrop-blur lg:hidden dark:border-zinc-800 dark:bg-zinc-950/90">
        <div className="flex h-12 items-center justify-between gap-3 px-4">
          <Link
            href="/"
            className="flex min-w-0 items-center gap-2 text-sm font-semibold tracking-tight"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.svg" alt="" className="h-6 w-auto dark:brightness-200" />
            <span className="truncate">{appConfig.appShortName}</span>
          </Link>
          <span className="truncate text-xs font-medium text-zinc-500">
            {activeItem?.label ?? "Overview"}
          </span>
        </div>
      </header>

      <header className="sticky top-0 z-30 hidden border-b border-zinc-200 bg-white/80 backdrop-blur lg:block dark:border-zinc-800 dark:bg-zinc-950/80">
        <div className="mx-auto flex h-12 max-w-6xl items-center gap-3 px-6">
          <Link
            href="/"
            className="flex min-w-0 items-center gap-2 text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-100"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.svg" alt="" className="h-6 w-auto dark:brightness-200" />
            <span className="truncate">{appConfig.appName}</span>
          </Link>
          <nav
            aria-label="Primary navigation"
            className="flex min-w-0 flex-1 items-center justify-end gap-1"
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
          <form action="/api/auth/logout" method="post" className="shrink-0">
            <button
              type="submit"
              className="text-xs text-zinc-500 hover:text-zinc-900 dark:text-zinc-500 dark:hover:text-zinc-200"
            >
              Log out
            </button>
          </form>
        </div>
      </header>

      <nav
        aria-label="Mobile navigation"
        className="mobile-tab-bar fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-zinc-200 bg-white/95 px-1 backdrop-blur lg:hidden dark:border-zinc-800 dark:bg-zinc-950/95"
      >
        {MOBILE_ITEMS.map((item) => {
          const active = ITEMS.find(
            (candidate) => candidate.href === item.href,
          )?.match(pathname);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-[10px] font-medium",
                active
                  ? "text-zinc-950 dark:text-zinc-50"
                  : "text-zinc-500 dark:text-zinc-400",
              )}
            >
              <NavIcon name={item.icon} />
              <span>{item.label}</span>
            </Link>
          );
        })}
        <details ref={mobileMenuRef} className="group relative">
          <summary className="flex min-h-14 cursor-pointer list-none flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-[10px] font-medium text-zinc-500 [&::-webkit-details-marker]:hidden dark:text-zinc-400">
            <NavIcon name="more" />
            <span>More</span>
          </summary>
          <div className="mobile-nav-sheet absolute bottom-[calc(100%+0.5rem)] right-1 w-[min(20rem,calc(100vw-1rem))] rounded-2xl border border-zinc-200 bg-white p-2 shadow-2xl dark:border-zinc-800 dark:bg-zinc-950">
            <p className="px-3 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              All sections
            </p>
            <div className="grid grid-cols-2 gap-1">
              {ITEMS.map((item) => {
                const active = item.match(pathname);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={closeMobileMenu}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex min-h-11 items-center rounded-lg px-3 text-sm",
                      active
                        ? "bg-zinc-100 font-medium dark:bg-zinc-900"
                        : "hover:bg-zinc-50 dark:hover:bg-zinc-900",
                    )}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </div>
            <form action="/api/auth/logout" method="post" className="mt-2 border-t border-zinc-200 pt-2 dark:border-zinc-800">
              <button
                type="submit"
                className="flex min-h-11 w-full items-center rounded-lg px-3 text-left text-sm text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/40"
              >
                Log out
              </button>
            </form>
          </div>
        </details>
      </nav>
    </>
  );
}
