import type { Metadata } from "next";
import Link from "next/link";
import { FestivalForm } from "./festival-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Add festival" };

export default function NewFestivalPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <Link href="/festivals" className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">← Festivals</Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Add festival</h1>
      <p className="mt-1 text-sm text-zinc-500">
        For festivals EDMTrain doesn&apos;t have yet, or where you have the lineup before they do.
      </p>

      <FestivalForm />
    </main>
  );
}
