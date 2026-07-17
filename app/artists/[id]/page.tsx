import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { db } from "@/lib/db";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { workflowReturnPath } from "@/lib/dashboardReturnUrl";
import { withWorkflowReturnTo } from "@/lib/workflowLinks";
import { firstSearchParam, type SearchParamValue } from "@/lib/searchParams";
import { isCancellableOutreachStatus } from "@/lib/outreachStatus";
import {
  contactDisplayValue,
  directOutreachNoteValue,
  hasDirectOutreachNote,
  isDirectOutreachOnly,
} from "@/lib/contactDisplay";

export const dynamic = "force-dynamic";

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
  }>;
}) {
  const { id } = await params;
  const search = await searchParams;
  const followUpSent = firstSearchParam(search.followup_sent);
  const followUpScheduled = firstSearchParam(search.followup_scheduled);
  const actionError = firstSearchParam(search.error);
  const cancelled = firstSearchParam(search.cancelled);
  const safeReturnTo = workflowReturnPath(firstSearchParam(search.returnTo));
  const currentReturnTo = withWorkflowReturnTo(`/artists/${id}`, safeReturnTo);
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
    .filter((s) => s.date >= today && s.syncStatus === "active")
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

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
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
