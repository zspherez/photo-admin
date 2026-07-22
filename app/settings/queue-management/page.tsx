import type { Metadata } from "next";
import Link from "next/link";
import { readQueueManagementCounts } from "@/lib/queueManagement";
import { QueueManagementForms } from "./queue-management-forms";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Queue management" };

export default async function QueueManagementPage() {
  const counts = await readQueueManagementCounts();

  return (
    <main className="mx-auto max-w-2xl px-4 py-8 sm:px-6 sm:py-10">
      <Link
        href="/settings"
        className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
      >
        ← Settings
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        Queue management
      </h1>
      <p className="mt-1 text-sm text-zinc-500">
        Resolve or pause operational queues without deleting their history.
        Counts are a snapshot; each operation rechecks rows atomically.
      </p>
      <QueueManagementForms {...counts} />
    </main>
  );
}
