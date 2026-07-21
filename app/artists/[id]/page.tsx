import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound, redirect, RedirectType } from "next/navigation";
import { cache } from "react";
import { db } from "@/lib/db";
import { Card, CardBody } from "@/components/ui/card";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { formatShowDate } from "@/lib/formatDate";
import {
  cancelScheduledAction,
  sendFollowUpAction,
  sendNowAction,
} from "@/app/dashboard/actions";
import { SendButton } from "@/components/send-button";
import { FollowUpButton } from "@/components/follow-up-button";
import {
  pickEmailContact,
  pickPhoneContact,
} from "@/lib/contactSelection";
import { isWeekendET } from "@/lib/schedule";
import { easternTodayStoredDate } from "@/lib/calendarDate";
import {
  activeListenSignalWhere,
  formatRankLabel,
} from "@/lib/listenSignal";
import {
  getFollowUpEligibilityBatch,
  getOutreachSendabilityBatch,
} from "@/lib/sendOutreach";
import {
  artistWorkflowPath,
  workflowFestivalShowId,
  workflowReturnPath,
  withWorkflowReturnTo,
} from "@/lib/dashboardReturnUrl";
import { firstSearchParam, type SearchParamValue } from "@/lib/searchParams";
import { isCancellableOutreachStatus } from "@/lib/outreachStatus";
import { satisfiesFestivalLeadTime } from "@/lib/festivalEligibility";
import {
  contactDisplayValue,
  directOutreachNoteValue,
  hasDirectOutreachNote,
  isDirectOutreachOnly,
} from "@/lib/contactDisplay";
import {
  CONTACT_RESEARCH_WINDOW_DAYS,
  skipContactResearchArtistByArtistId,
  unskipContactResearchArtistByArtistId,
  updateContactResearchArtistUserNotes,
  type ArtistContactResearchMutationFailure,
} from "@/lib/contactResearch";
import { requireServerActionAuth } from "@/lib/auth";
import { refreshWorkflowViews } from "@/lib/workflowRefresh";
import { ContactResearchControls } from "@/components/contact-research-controls";
import { DirectOutreachProvenance } from "@/components/direct-outreach-provenance";
import {
  researchStatusHref,
  type ResearchStatusFilter,
} from "@/lib/researchStatusFilter";

export const dynamic = "force-dynamic";

function researchMutationFailureMessage(
  reason: ArtistContactResearchMutationFailure
): string {
  if (reason === "artist_not_found") return "Artist could not be found.";
  if (reason === "active_contact") {
    return "This artist already has an active email contact, so a new research job was not created.";
  }
  if (reason === "ineligible") {
    return "This artist has no eligible upcoming show context for durable manager research state.";
  }
  if (reason === "empty_instructions") {
    return "Enter research instructions before creating a new research record.";
  }
  if (reason === "already_skipped") {
    return "This artist is already intentionally skipped.";
  }
  if (reason === "not_skipped") {
    return "This artist is not currently intentionally skipped.";
  }
  return "The artist research job could not be found.";
}

function researchActionError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 180);
}

async function handleSaveArtistResearchNotes(
  artistId: string,
  returnTo: string,
  formData: FormData
) {
  const currentArtistPath = artistWorkflowPath(artistId, returnTo);

  let result:
    | Awaited<ReturnType<typeof updateContactResearchArtistUserNotes>>
    | null = null;
  let error: string | null = null;
  try {
    result = await updateContactResearchArtistUserNotes(
      artistId,
      formData.get("userNotes"),
      { requestedShowId: workflowFestivalShowId(returnTo) }
    );
  } catch (caught) {
    error = researchActionError(caught);
  }

  if (result?.ok) {
    refreshWorkflowViews(returnTo, [currentArtistPath, "/research", "/settings"]);
  }
  const failureMessage =
    error ??
    (result && !result.ok
      ? researchMutationFailureMessage(result.reason)
      : "Manager research instructions could not be saved.");
  redirect(
    artistWorkflowPath(artistId, returnTo, {
      ...(result?.ok ? { research_saved: "1" } : {}),
      ...(!result?.ok ? { research_error: failureMessage } : {}),
    }),
    RedirectType.replace
  );
}

async function handleSkipArtistResearch(
  artistId: string,
  returnTo: string,
  formData: FormData
) {
  const currentArtistPath = artistWorkflowPath(artistId, returnTo);

  let result:
    | Awaited<ReturnType<typeof skipContactResearchArtistByArtistId>>
    | null = null;
  let error: string | null = null;
  try {
    result = await skipContactResearchArtistByArtistId(
      artistId,
      formData.get("reason"),
      { requestedShowId: workflowFestivalShowId(returnTo) }
    );
  } catch (caught) {
    error = researchActionError(caught);
  }

  if (result?.ok) {
    refreshWorkflowViews(returnTo, [currentArtistPath, "/research", "/settings"]);
  }
  const failureMessage =
    error ??
    (result && !result.ok
      ? researchMutationFailureMessage(result.reason)
      : "Artist could not be intentionally skipped.");
  redirect(
    artistWorkflowPath(artistId, returnTo, {
      ...(result?.ok ? { research_skipped: "1" } : {}),
      ...(!result?.ok ? { research_error: failureMessage } : {}),
    }),
    RedirectType.replace
  );
}

async function handleUnskipArtistResearch(
  artistId: string,
  returnTo: string
) {
  const currentArtistPath = artistWorkflowPath(artistId, returnTo);

  let result:
    | Awaited<ReturnType<typeof unskipContactResearchArtistByArtistId>>
    | null = null;
  let error: string | null = null;
  try {
    result = await unskipContactResearchArtistByArtistId(artistId, {
      requestedShowId: workflowFestivalShowId(returnTo),
    });
  } catch (caught) {
    error = researchActionError(caught);
  }

  if (result?.ok) {
    refreshWorkflowViews(returnTo, [currentArtistPath, "/research", "/settings"]);
  }
  const failureMessage =
    error ??
    (result && !result.ok
      ? researchMutationFailureMessage(result.reason)
      : "Artist could not be restored to normal research eligibility.");
  redirect(
    artistWorkflowPath(artistId, returnTo, {
      ...(result?.ok ? { research_unskipped: "1" } : {}),
      ...(!result?.ok ? { research_error: failureMessage } : {}),
    }),
    RedirectType.replace
  );
}

function researchStatusTone(status: string): BadgeTone {
  if (status === "review" || status === "skipped") return "warning";
  if (status === "claimed") return "info";
  if (status === "pending") return "accent";
  if (status === "inactive" || status === "exhausted") return "muted";
  return "default";
}

interface ExternalLink {
  label: string;
  href: string;
  type: "spotify" | "soundcloud" | "statsfm" | "edmtrain";
}

function getExternalLinks(artist: {
  name: string;
  spotifyId: string | null;
  statsfmId: string | null;
  edmtrainId: number | null;
}): ExternalLink[] {
  const links: ExternalLink[] = [];
  if (artist.spotifyId) {
    // spotify: URI opens directly in the desktop app on macOS/Windows;
    // browser falls back to open.spotify.com if app not installed.
    links.push({
      label: "Spotify",
      href: `spotify:artist:${artist.spotifyId}`,
      type: "spotify",
    });
  }
  if (artist.statsfmId) {
    links.push({
      label: "Stats.fm",
      href: `https://stats.fm/artist/${artist.statsfmId}`,
      type: "statsfm",
    });
  }
  // SoundCloud doesn't expose an open API; search-by-name is the practical fallback
  links.push({
    label: "SoundCloud (search)",
    href: `https://soundcloud.com/search/people?q=${encodeURIComponent(artist.name)}`,
    type: "soundcloud",
  });
  if (artist.edmtrainId) {
    links.push({
      label: "EDMTrain",
      href: `https://edmtrain.com/${artist.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      type: "edmtrain",
    });
  }
  return links;
}

const getArtistPageData = cache(async (id: string) => {
  const now = new Date();
  const [artist, outreaches] = await Promise.all([
    db.artist.findUnique({
      where: { id },
      include: {
        listenSignals: {
          where: activeListenSignalWhere(now),
          orderBy: { rank: "asc" },
        },
        contacts: {
          where: { state: "active" },
          orderBy: { updatedAt: "desc" },
        },
        contactResearchJob: {
          select: {
            id: true,
            status: true,
            priority: true,
            nextShowAt: true,
            attemptCount: true,
            claimedAt: true,
            claimExpiresAt: true,
            userNotes: true,
            agentNotes: true,
            requestedShowId: true,
            requestedShow: {
              select: {
                id: true,
                date: true,
                eventName: true,
                venueName: true,
              },
            },
          },
        },
        researchSkips: {
          where: { clearedAt: null },
          orderBy: { setAt: "desc" },
          take: 1,
        },
        playlists: { include: { playlist: true } },
        shows: {
          include: { show: true },
          orderBy: { show: { date: "asc" } },
        },
      },
    }),
    db.outreach.findMany({
      where: {
        artistId: id,
        kind: "original",
      },
      select: { id: true, showId: true, status: true },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    }),
  ]);
  return { artist, outreaches, now };
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const { artist } = await getArtistPageData(id);
  return { title: artist?.name ?? "Artist" };
}

export default async function ArtistPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    returnTo?: SearchParamValue;
    followup_sent?: SearchParamValue;
    followup_scheduled?: SearchParamValue;
    cancelled?: SearchParamValue;
    error?: SearchParamValue;
    research_saved?: SearchParamValue;
    research_skipped?: SearchParamValue;
    research_unskipped?: SearchParamValue;
    research_error?: SearchParamValue;
  }>;
}) {
  const { id } = await params;
  const search = await searchParams;
  const followUpSent = firstSearchParam(search.followup_sent);
  const followUpScheduled = firstSearchParam(search.followup_scheduled);
  const actionError = firstSearchParam(search.error);
  const cancelled = firstSearchParam(search.cancelled);
  const researchSaved = firstSearchParam(search.research_saved);
  const researchSkipped = firstSearchParam(search.research_skipped);
  const researchUnskipped = firstSearchParam(search.research_unskipped);
  const researchError = firstSearchParam(search.research_error);
  const safeReturnTo = workflowReturnPath(firstSearchParam(search.returnTo));
  const currentReturnTo = withWorkflowReturnTo(
    `/artists/${id}`,
    safeReturnTo
  );
  const { artist, outreaches, now } = await getArtistPageData(id);
  const today = easternTodayStoredDate(now);
  if (!artist) return notFound();

  const genres: string[] = (() => {
    try {
      return artist.genres ? (JSON.parse(artist.genres) as string[]).filter((g) => typeof g === "string") : [];
    } catch {
      return [];
    }
  })();

  const links = getExternalLinks(artist);
  const upcomingShows = artist.shows
    .map((sa) => sa.show)
    .filter(
      (s) =>
        s.date >= today &&
        s.syncStatus === "active" &&
        satisfiesFestivalLeadTime(s, now)
    )
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  const outreachesByShow = new Map<
    string,
    (typeof outreaches)[number][]
  >();
  for (const outreach of outreaches) {
    const rows = outreachesByShow.get(outreach.showId) ?? [];
    rows.push(outreach);
    outreachesByShow.set(outreach.showId, rows);
  }
  const emailContact = pickEmailContact(artist.contacts);
  const phoneContact = pickPhoneContact(artist.contacts, emailContact);
  const weekend = isWeekendET();
  const [sendabilityRows, followUpEligibilityRows] = await Promise.all([
    emailContact
      ? getOutreachSendabilityBatch(
          upcomingShows.map((show) => ({
            showId: show.id,
            contactId: emailContact.id,
          })),
          now,
        )
      : Promise.resolve([]),
    getFollowUpEligibilityBatch(
      outreaches.map((outreach) => outreach.id),
      now,
    ),
  ]);
  const sendabilityByShow = new Map(
    sendabilityRows.map((result) => [result.showId, result])
  );
  const followUpByParent = new Map(
    followUpEligibilityRows.map((result) => [
      result.parentOutreachId,
      result,
    ]),
  );
  const researchJob = artist.contactResearchJob;
  const activeResearchSkip = artist.researchSkips[0] ?? null;
  const festivalContextShowId = workflowFestivalShowId(safeReturnTo);
  const hasActiveEmailContact = artist.contacts.some((contact) =>
    Boolean(contact.email?.trim())
  );
  const researchWindowEnd = new Date(
    today.getTime() + CONTACT_RESEARCH_WINDOW_DAYS * 86_400_000
  );
  const hasEligibleRegularShow = upcomingShows.some(
    (show) => !show.isFestival && show.date <= researchWindowEnd
  );
  const hasEligibleFestivalContext = upcomingShows.some(
    (show) => show.id === festivalContextShowId && show.isFestival
  );
  const canManageResearch =
    researchJob !== null ||
    (!hasActiveEmailContact &&
      (hasEligibleRegularShow || hasEligibleFestivalContext));
  const researchUnavailableMessage = hasActiveEmailContact
    ? "This artist already has an active email contact. A new manager-research job will not be created, but any existing research record remains available above."
    : "This artist has no eligible upcoming regular show or current festival context, so a durable manager-research record will not be created yet.";
  const visibleResearchFilter: ResearchStatusFilter | null = activeResearchSkip
    ? "skipped"
    : researchJob &&
        [
          "pending",
          "claimed",
          "review",
          "complete",
          "exhausted",
        ].includes(researchJob.status)
      ? (researchJob.status as ResearchStatusFilter)
      : null;
  async function saveArtistResearchNotesAction(formData: FormData) {
    "use server";
    await requireServerActionAuth(
      artistWorkflowPath(id, formData.get("returnTo"))
    );
    const actionReturnTo = workflowReturnPath(formData.get("returnTo"));
    await handleSaveArtistResearchNotes(id, actionReturnTo, formData);
  }

  async function skipArtistResearchAction(formData: FormData) {
    "use server";
    await requireServerActionAuth(
      artistWorkflowPath(id, formData.get("returnTo"))
    );
    const actionReturnTo = workflowReturnPath(formData.get("returnTo"));
    await handleSkipArtistResearch(id, actionReturnTo, formData);
  }

  async function unskipArtistResearchAction(formData: FormData) {
    "use server";
    await requireServerActionAuth(
      artistWorkflowPath(id, formData.get("returnTo"))
    );
    const actionReturnTo = workflowReturnPath(formData.get("returnTo"));
    await handleUnskipArtistResearch(id, actionReturnTo);
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
      <Link href={safeReturnTo} className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">← Back</Link>

      {(followUpSent || followUpScheduled || cancelled || actionError) && (
        <div className="mt-4 space-y-2">
          {followUpSent && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
              Follow-up sent.
            </div>
          )}
          {followUpScheduled && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
              Follow-up scheduled for Monday morning.
            </div>
          )}
          {cancelled && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
              Scheduled follow-up or retry cancelled.
            </div>
          )}
          {actionError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
              Action failed: {actionError}
            </div>
          )}
        </div>
      )}

      {(researchSaved ||
        researchSkipped ||
        researchUnskipped ||
        researchError) && (
        <div className="mt-4">
          {researchError ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
              Manager research update failed: {researchError}
            </div>
          ) : (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
              {researchSkipped
                ? "Artist intentionally skipped from manager research."
                : researchUnskipped
                  ? "Intentional skip cleared and normal eligibility restored."
                  : "Research instructions saved."}
            </div>
          )}
        </div>
      )}

      <div className="mt-2 flex items-start gap-4">
        {artist.imageUrl && (
          <Image
            src={artist.imageUrl}
            alt=""
            width={64}
            height={64}
            className="h-16 w-16 rounded-lg object-cover"
          />
        )}
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{artist.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {genres.slice(0, 6).map((g) => (
              <Badge key={g} tone="muted" size="xs">{g}</Badge>
            ))}
            {artist.popularity != null && (
              <Badge tone="default" size="xs">popularity {artist.popularity}</Badge>
            )}
          </div>
        </div>
      </div>

      <section className="mt-6">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">External</h2>
        <div className="mt-2 flex flex-wrap gap-2">
          {links.map((l) => (
            <a
              key={l.label}
              href={l.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center rounded-full border border-zinc-200 px-3 py-1 text-xs font-medium text-zinc-700 transition hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:border-zinc-700 dark:hover:bg-zinc-900"
            >
              {l.label} ↗
            </a>
          ))}
        </div>
      </section>

      <section className="mt-6">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
              Manager research
            </h2>
            <p className="mt-1 text-xs text-zinc-500">
              Artist-specific instructions and intentional skip state shared
              with the contact-research workflow.
            </p>
          </div>
          {researchJob && visibleResearchFilter && (
            <Link
              href={`${researchStatusHref(visibleResearchFilter)}#job-${researchJob.id}`}
              className="text-xs font-medium text-blue-700 hover:underline dark:text-blue-300"
            >
              Open research card ↗
            </Link>
          )}
        </div>
        <Card className="mt-2">
          <CardBody>
            {researchJob ? (
              <div className="mb-4 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">Current research job</p>
                  <Badge tone={researchStatusTone(researchJob.status)}>
                    {researchJob.status}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-zinc-500">
                  Attempt {researchJob.attemptCount}
                  {researchJob.nextShowAt
                    ? ` · next show ${formatShowDate(researchJob.nextShowAt, {})}`
                    : " · no next show date"}
                  {researchJob.priority
                    ? ` · priority ${researchJob.priority}`
                    : ""}
                </p>
                {researchJob.status === "claimed" && (
                  <p className="mt-1 text-xs text-zinc-500">
                    Claimed{" "}
                    {researchJob.claimedAt
                      ? researchJob.claimedAt.toLocaleString("en-US", {
                          timeZone: "America/New_York",
                        })
                      : "without a recorded timestamp"}
                    {researchJob.claimExpiresAt
                      ? ` · expires ${researchJob.claimExpiresAt.toLocaleString(
                          "en-US",
                          { timeZone: "America/New_York" }
                        )}`
                      : ""}
                  </p>
                )}
                {researchJob.requestedShow && (
                  <p className="mt-1 text-xs text-zinc-500">
                    Festival request:{" "}
                    <Link
                      href={withWorkflowReturnTo(
                        `/festivals/${researchJob.requestedShow.id}`,
                        currentReturnTo
                      )}
                      className="hover:underline"
                    >
                      {researchJob.requestedShow.eventName ||
                        researchJob.requestedShow.venueName}
                    </Link>
                    {" · "}
                    {formatShowDate(researchJob.requestedShow.date, {})}
                  </p>
                )}
                {researchJob.agentNotes && (
                  <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
                    Agent context: {researchJob.agentNotes}
                  </p>
                )}
              </div>
            ) : canManageResearch ? (
              <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-950 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-100">
                No research job exists yet. Saving instructions creates an
                inactive durable record without queueing research. The normal
                research refresh or festival enqueue can queue it later;
                intentional skip takes effect immediately.
              </div>
            ) : null}

            <ContactResearchControls
              idPrefix={`artist-${artist.id}-research`}
              userNotes={researchJob?.userNotes ?? null}
              activeSkip={activeResearchSkip}
              saveAction={saveArtistResearchNotesAction}
              skipAction={skipArtistResearchAction}
              unskipAction={unskipArtistResearchAction}
              hiddenFields={[{ name: "returnTo", value: safeReturnTo }]}
              canManage={canManageResearch}
              hasJob={researchJob !== null}
              unavailableMessage={researchUnavailableMessage}
              notesDescription={
                researchJob?.status === "claimed"
                  ? "Saving changes invalidates the current claim and safely returns this job to pending so the agent cannot submit against stale instructions."
                  : "Trusted artist-specific context for the research agent. Saving instructions alone does not queue a new job."
              }
            />
          </CardBody>
        </Card>
      </section>

      {artist.listenSignals.length > 0 && (
        <section className="mt-6">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Listen signals</h2>
          <Card className="mt-2">
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {artist.listenSignals.map((s) => (
                <li key={s.id} className="flex items-center justify-between px-4 py-2 text-sm">
                  <span>{formatRankLabel(s.source, s.rank)}</span>
                  <span className="text-xs text-zinc-500">
                    {s.playCount != null && `${s.playCount.toLocaleString()} plays`}
                    {s.lastSeenAt && ` · ${new Date(s.lastSeenAt).toLocaleDateString()}`}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      {artist.playlists.length > 0 && (
        <section className="mt-6">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            In your playlists ({artist.playlists.length})
          </h2>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {artist.playlists.map((ap) => (
              <a
                key={ap.playlist.spotifyId}
                href={`spotify:playlist:${ap.playlist.spotifyId}`}
                className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200 transition hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900 dark:hover:bg-emerald-950"
              >
                ♪ {ap.playlist.name}
              </a>
            ))}
          </div>
        </section>
      )}

      {artist.contacts.length > 0 && (
        <section className="mt-6">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Contacts</h2>
          <Card className="mt-2">
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {artist.contacts.map((c) => (
                <li key={c.id} className="px-4 py-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate">
                        {c.name && <b>{c.name}</b>}
                        {c.name ? " · " : ""}
                        <Link
                          href={withWorkflowReturnTo(
                            `/dashboard/contact/${c.id}`,
                            safeReturnTo
                          )}
                          className="text-zinc-700 hover:underline dark:text-zinc-300"
                        >
                          {contactDisplayValue(c)}
                        </Link>
                        {hasDirectOutreachNote(c) &&
                          !isDirectOutreachOnly(c) && (
                            <span className="text-zinc-500">
                              {" "}
                              · {directOutreachNoteValue(c)}
                            </span>
                          )}
                        {c.role && <span className="text-zinc-500"> · {c.role}</span>}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      {c.customPrice && <Badge tone="default" size="xs">{c.customPrice}</Badge>}
                      {hasDirectOutreachNote(c) && (
                        <Badge tone="warning" size="xs">
                          Direct outreach
                        </Badge>
                      )}
                      {c.isFullTeam && <Badge tone="accent" size="xs">Full team</Badge>}
                    </div>
                  </div>
                  <DirectOutreachProvenance
                    contact={c}
                    className="mt-2"
                  />
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      {upcomingShows.length > 0 && (
        <section className="mt-6">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Upcoming shows</h2>
          <Card className="mt-2">
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {upcomingShows.map((s) => {
                const showOutreaches = outreachesByShow.get(s.id) ?? [];
                const outreach =
                  showOutreaches.find((row) => row.status === "scheduled") ??
                  showOutreaches.find(
                    (row) => row.status === "retry_scheduled",
                  ) ??
                  showOutreaches.find((row) => row.status === "sent") ??
                  showOutreaches[0];
                const followUpEligibility =
                  showOutreaches
                    .map((row) => followUpByParent.get(row.id))
                    .find(
                      (row) =>
                        row &&
                        (row.state === "eligible" ||
                          row.state === "pending" ||
                          row.state === "sent"),
                    ) ??
                  showOutreaches
                    .filter((row) => row.status === "sent")
                    .map((row) => followUpByParent.get(row.id))
                    .find((row) => row !== undefined);
                const sendability = sendabilityByShow.get(s.id);
                const alreadySent =
                  sendability?.blockingStatus === "sent" ||
                  outreach?.status === "sent";
                const scheduledInfo =
                  isCancellableOutreachStatus(
                    sendability?.blockingStatus
                  ) &&
                  sendability.blockingOutreachId
                    ? {
                        outreachId: sendability.blockingOutreachId,
                        scheduledLabel: sendability.blockingNextAttemptAt
                          ? `${
                              sendability.blockingStatus === "retry_scheduled"
                                ? "Retry"
                                : "Scheduled"
                            } · ${sendability.blockingNextAttemptAt.toLocaleString(
                              "en-US",
                              {
                                timeZone: "America/New_York",
                                weekday: "short",
                                hour: "numeric",
                                minute: "2-digit",
                                hour12: true,
                              }
                            )}`
                          : sendability.blockingStatus === "retry_scheduled"
                            ? "Retry scheduled"
                            : "Scheduled",
                      }
                    : null;
                const emailDisabledLabel =
                  !sendability || sendability.sendable || scheduledInfo
                    ? undefined
                    : sendability.blockingStatus === "queued"
                      ? "In progress"
                      : sendability.blockingStatus === "manual_review"
                        ? "Review"
                        : sendability.blockingStatus === "retry_scheduled"
                          ? "Retry scheduled"
                        : "Unavailable";
                return (
                  <li key={s.id} className="flex items-center justify-between gap-2 px-4 py-3 text-sm">
                    <Link
                      href={s.isFestival ? `/festivals/${s.id}` : "/dashboard"}
                      className="min-w-0 flex-1 hover:opacity-80"
                    >
                      <p className="truncate">
                        <span className="font-medium">{s.eventName || s.venueName}</span>
                        <span className="ml-2 text-xs text-zinc-500">
                          {formatShowDate(s.date, { weekday: "short", month: "short", day: "numeric" })}
                          {" · "}{s.venueName}{s.state ? `, ${s.state}` : ""}
                        </span>
                      </p>
                    </Link>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {s.isFestival && <Badge tone="accent" size="xs">Festival</Badge>}
                      {(emailContact || phoneContact) && (
                        <SendButton
                          showId={s.id}
                          contactId={emailContact?.id ?? null}
                          contactName={emailContact?.name ?? null}
                          phone={phoneContact?.phone ?? null}
                          phoneContactName={phoneContact?.name ?? null}
                          alreadySent={alreadySent}
                          emailDisabledLabel={emailDisabledLabel}
                          emailDisabledReason={sendability?.reason ?? undefined}
                          isRetry={sendability?.mode === "retry"}
                          isWeekend={weekend}
                          scheduledInfo={scheduledInfo}
                          returnTo={currentReturnTo}
                          action={sendNowAction}
                          cancelAction={cancelScheduledAction}
                        />
                      )}
                      {emailContact && followUpEligibility && (
                        <FollowUpButton
                          eligibility={followUpEligibility}
                          returnTo={currentReturnTo}
                          isWeekend={weekend}
                          action={sendFollowUpAction}
                          cancelAction={cancelScheduledAction}
                        />
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        </section>
      )}

      {artist.contacts.length === 0 && (
        <p className="mt-6 text-xs text-zinc-500">
          No contact yet.{" "}
          <Link
            href={withWorkflowReturnTo(
              `/dashboard/add-contact/${artist.id}`,
              safeReturnTo
            )}
            className="underline"
          >
            Add one
          </Link>
          .
        </p>
      )}
    </main>
  );
}
