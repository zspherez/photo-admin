import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { requireServerActionAuth } from "@/lib/auth";
import {
  getArtistMergePreview,
  mergeArtists,
  type ArtistMergePreview,
} from "@/lib/artistMerge";
import { artistDisplayName } from "@/lib/artistDisplayName";
import {
  artistWorkflowPath,
  workflowReturnPath,
  withWorkflowReturnTo,
} from "@/lib/dashboardReturnUrl";
import { firstSearchParam, type SearchParamValue } from "@/lib/searchParams";
import { refreshWorkflowViews } from "@/lib/workflowRefresh";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Merge artists" };

function mergeHref(
  leftId: string,
  rightId: string,
  returnTo: string,
  error?: string,
): string {
  const params = new URLSearchParams({ leftId, rightId });
  if (returnTo !== "/dashboard") params.set("returnTo", returnTo);
  if (error) params.set("error", error);
  return `/artists/merge?${params}`;
}

function identitySummary(artist: ArtistMergePreview["source"]): string[] {
  return [
    artist.edmtrainId != null ? `EDMTrain ${artist.edmtrainId}` : null,
    artist.spotifyId ? `Spotify ${artist.spotifyId}` : null,
    artist.statsfmId ? `Stats.fm ${artist.statsfmId}` : null,
  ].filter((value): value is string => value !== null);
}

function ArtistSummary({
  artist,
  label,
}: {
  artist: ArtistMergePreview["source"];
  label: string;
}) {
  const identities = identitySummary(artist);
  return (
    <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
        {label}
      </p>
      <p className="mt-2 font-semibold">{artistDisplayName(artist)}</p>
      <p className="mt-1 text-xs text-zinc-500">
        {identities.length > 0 ? identities.join(" · ") : "No external IDs"}
        {" · "}
        {artist.contacts.length} contact
        {artist.contacts.length === 1 ? "" : "s"}
        {" · record "}
        {artist.id.slice(-8)}
      </p>
    </div>
  );
}

function MergeOption({
  preview,
  returnTo,
}: {
  preview: ArtistMergePreview;
  returnTo: string;
}) {
  const blocked = preview.blockers.length > 0;
  const counts = preview.moveCounts;
  return (
    <Card>
      <CardBody>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">
              Keep {artistDisplayName(preview.target)}
            </h2>
            <p className="mt-1 text-sm text-zinc-500">
              Merge and remove {artistDisplayName(preview.source)}.
            </p>
          </div>
          <Badge tone={blocked ? "warning" : "success"}>
            {blocked ? "Blocked" : "Ready"}
          </Badge>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <ArtistSummary artist={preview.target} label="Canonical record" />
          <ArtistSummary artist={preview.source} label="Record to remove" />
        </div>

        <p className="mt-4 text-xs text-zinc-500">
          Moves {counts.contacts} contacts, {counts.shows} shows,{" "}
          {counts.listenSignals} listen signals, {counts.playlists} playlists,{" "}
          {counts.outreaches} outreach records, {counts.researchRecords} research
          records, {counts.auditRecords} audit records, and{" "}
          {counts.trajectoryRecords} trajectory mappings.
        </p>

        {blocked ? (
          <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-amber-800 dark:text-amber-200">
            {preview.blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        ) : (
          <form action={mergeArtistAction} className="mt-4 space-y-3">
            <input
              type="hidden"
              name="sourceArtistId"
              value={preview.source.id}
            />
            <input
              type="hidden"
              name="targetArtistId"
              value={preview.target.id}
            />
            <input type="hidden" name="returnTo" value={returnTo} />
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                name="confirmation"
                value="MERGE"
                required
                className="mt-0.5"
              />
              <span>
                I understand the duplicate record will be removed after its
                data and provider identities are transferred.
              </span>
            </label>
            <PendingSubmitButton
              variant="danger"
              size="sm"
              pendingLabel="Merging artists…"
            >
              Merge into {artistDisplayName(preview.target)}
            </PendingSubmitButton>
          </form>
        )}
      </CardBody>
    </Card>
  );
}

async function mergeArtistAction(formData: FormData) {
  "use server";
  await requireServerActionAuth(formData.get("returnTo") ?? "/artists");
  const sourceArtistId = String(
    formData.get("sourceArtistId") ?? "",
  ).trim();
  const targetArtistId = String(
    formData.get("targetArtistId") ?? "",
  ).trim();
  const returnTo = workflowReturnPath(formData.get("returnTo"));
  if (formData.get("confirmation") !== "MERGE") {
    redirect(
      mergeHref(
        sourceArtistId,
        targetArtistId,
        returnTo,
        "Confirm the irreversible artist merge.",
      ),
    );
  }
  let result: Awaited<ReturnType<typeof mergeArtists>>;
  try {
    result = await mergeArtists(sourceArtistId, targetArtistId);
  } catch (error) {
    redirect(
      mergeHref(
        sourceArtistId,
        targetArtistId,
        returnTo,
        (error instanceof Error ? error.message : String(error)).slice(0, 300),
      ),
    );
  }
  refreshWorkflowViews(returnTo, [
    "/artists",
    "/shows",
    "/festivals",
    "/recommendations",
    "/research",
    "/contact-audit",
    "/outreach",
  ]);
  redirect(
    artistWorkflowPath(result.targetArtistId, returnTo, {
      merged: result.sourceArtistId,
    }),
  );
}

export default async function ArtistMergePage({
  searchParams,
}: {
  searchParams: Promise<{
    leftId?: SearchParamValue;
    rightId?: SearchParamValue;
    returnTo?: SearchParamValue;
    error?: SearchParamValue;
  }>;
}) {
  const params = await searchParams;
  const leftId = firstSearchParam(params.leftId)?.trim() ?? "";
  const rightId = firstSearchParam(params.rightId)?.trim() ?? "";
  const returnTo = workflowReturnPath(firstSearchParam(params.returnTo));
  const error = firstSearchParam(params.error);
  const [leftIntoRight, rightIntoLeft] = await Promise.all([
    getArtistMergePreview(leftId, rightId),
    getArtistMergePreview(rightId, leftId),
  ]);
  if (!leftIntoRight || !rightIntoLeft) notFound();

  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-10">
      <Link
        href={withWorkflowReturnTo(`/artists/${leftId}`, returnTo)}
        className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
      >
        ← Back to artist
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        Merge duplicate artists
      </h1>
      <p className="mt-1 text-sm text-zinc-500">
        Choose which record remains canonical. The operation is atomic and
        retains an audit event plus alternate provider identities.
      </p>
      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          Merge failed: {error}
        </div>
      )}
      <div className="mt-6 space-y-4">
        <MergeOption preview={rightIntoLeft} returnTo={returnTo} />
        <MergeOption preview={leftIntoRight} returnTo={returnTo} />
      </div>
    </main>
  );
}
