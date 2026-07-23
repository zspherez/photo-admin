import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardBody } from "@/components/ui/card";
import { firstSearchParam, type SearchParamValue } from "@/lib/searchParams";
import { sanitizeNextPath } from "@/lib/auth";

export const metadata: Metadata = { title: "Read-only session" };

export default async function ReadOnlyPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: SearchParamValue }>;
}) {
  const next = sanitizeNextPath(firstSearchParam((await searchParams).next));
  return (
    <main className="mx-auto max-w-lg px-6 py-16">
      <Card>
        <CardBody>
          <h1 className="text-xl font-semibold">Read-only session</h1>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
            This password can view all admin data, but it cannot save changes,
            run syncs, queue work, or send email.
          </p>
          <Link
            href={next}
            className="mt-5 inline-flex min-h-10 items-center rounded-md border border-zinc-200 px-4 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
          >
            Return to the page
          </Link>
        </CardBody>
      </Card>
    </main>
  );
}
