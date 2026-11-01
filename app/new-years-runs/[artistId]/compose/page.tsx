import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { Card, CardBody } from "@/components/ui/card";
import { formatShowDate } from "@/lib/formatDate";
import { loadNewYearRuns } from "@/lib/newYearRuns";
import { readNewYearPitchTemplate, renderNewYearPitch } from "@/lib/newYearPitch";
import {
  formatNextDispatchActionLabel,
  getNextNormalOutreachDispatch,
} from "@/lib/schedule";
import { ComposeEmailForm } from "@/app/emails/new/compose-email-form";
import { getSessionAccess, SESSION_COOKIE } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Compose New Year's pitch" };

export default async function NewYearComposePage({
  params,
}: {
  params: Promise<{ artistId: string }>;
}) {
  const { artistId } = await params;
  const access = await getSessionAccess(
    (await cookies()).get(SESSION_COOKIE)?.value
  );
  if (access === "read_only") notFound();
  const run = (await loadNewYearRuns()).find((item) => item.artistId === artistId);
  if (!run) notFound();
  const template = await readNewYearPitchTemplate();
  const { subject, html } = await renderNewYearPitch(
    template,
    run.artistName,
    run.shows
  );
  const contact = run.shows
    .flatMap((show) => show.artists)
    .find((membership) => membership.artistId === artistId)
    ?.artist.contacts.find((row) => row.email?.trim());

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <Link href="/new-years-runs" className="text-sm text-zinc-500 underline">
        Back to New Year&apos;s runs
      </Link>
      <h1 className="mt-3 text-2xl font-semibold">Pitch {run.artistName}</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Review the recipient and edit the pitch before sending or scheduling.
        This email uses the <Link href="/new-years-runs/template" className="underline">New Year&apos;s pitch template</Link>.
      </p>
      <ul className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">
        {run.shows.map((show) => (
          <li key={show.id}>
            {formatShowDate(show.date)} · {show.city}
            {show.state ? `, ${show.state}` : ""} · {show.eventName || show.venueName}
          </li>
        ))}
      </ul>
      <Card className="mt-6">
        <CardBody>
          <ComposeEmailForm
            compositionId={randomUUID()}
            scheduleLabel={formatNextDispatchActionLabel(getNextNormalOutreachDispatch())}
            initialRecipients={contact?.email ?? ""}
            initialSubject={subject}
            initialHtml={html}
          />
        </CardBody>
      </Card>
    </main>
  );
}
