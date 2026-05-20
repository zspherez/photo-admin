import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";

const BASE =
  "rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950";

export function Card({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn(BASE, className)} {...props} />;
}

export function CardLink({
  href,
  className,
  children,
  ...rest
}: { href: string; className?: string; children: React.ReactNode } & Omit<
  React.ComponentProps<typeof Link>,
  "href" | "children" | "className"
>) {
  return (
    <Link
      href={href}
      className={cn(
        BASE,
        "block transition hover:border-zinc-300 hover:shadow-md dark:hover:border-zinc-700",
        className
      )}
      {...rest}
    >
      {children}
    </Link>
  );
}

export function CardBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-5", className)} {...props} />;
}
