import Form from "next/form";
import Link from "next/link";
import type {
  ContactFilter,
  DashboardData,
  DashboardMode,
  DashboardQuery,
  MatchFilters,
  RangeFilter,
  SourceFilter,
  StatusFilter,
} from "@/lib/match";
import {
  buildDashboardHref,
  DEFAULT_FILTERS,
} from "@/lib/dashboardQuery";
import { Card } from "@/components/ui/card";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { ArtistLink } from "@/components/artist-modal";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { SendButton } from "@/components/send-button";
import { FollowUpButton } from "@/components/follow-up-button";
import { cn } from "@/lib/cn";
import {
  pickDirectOutreachContact,
  pickEmailContact,
  pickPhoneContact,
} from "@/lib/contactSelection";
import {
  contactDisplayValue,
  hasDirectOutreachNote,
  isDirectOutreachOnly,
} from "@/lib/contactDisplay";
import { formatShowDate } from "@/lib/formatDate";
import { formatRankLabel } from "@/lib/listenSignal";
import type {
  FollowUpEligibility,
  OutreachSendability,
} from "@/lib/sendOutreach";
import { isCancellableOutreachStatus } from "@/lib/outreachStatus";
import { withWorkflowReturnTo } from "@/lib/workflowLinks";
import {
  sendNowAction,
  dismissShowAction,
  restoreShowAction,
  setInterestedAction,
  markSentAction,
  unmarkSentAction,
  cancelScheduledAction,
  sendFollowUpAction,
} from "./actions";

interface Props {
  data: DashboardData;
  query: DashboardQuery;
  isWeekend: boolean;
  sendabilityRows: OutreachSendability[];
  followUpEligibilityRows: FollowUpEligibility[];
}

interface OutreachState {
  status: string;
  sentAt: Date | null;
  deliveredAt: Date | null;
  openCount: number;
  clickCount: number;
}

type FilterOption =
  | { key: "range"; value: RangeFilter; label: string }
  | { key: "source"; value: SourceFilter; label: string }
  | { key: "contact"; value: ContactFilter; label: string }
  | { key: "status"; value: StatusFilter; label: string };

function statusLabels(outreach: OutreachState): string[] {
  if (outreach.status === "failed") return ["Failed"];
  if (outreach.status === "manual_review") return ["Manual review"];
  if (outreach.status === "queued") return ["Queued"];
  if (outreach.status === "scheduled") return ["Scheduled"];
  if (outreach.status === "retry_scheduled") return ["Retry scheduled"];
  if (outreach.status === "cancelled") return ["Cancelled"];
  const labels: string[] = [];
  if (outreach.status === "test") labels.push("Test sent");
  else if (outreach.sentAt) labels.push("Sent");
  if (outreach.deliveredAt) labels.push("Delivered");
  if (outreach.openCount > 0) {
    labels.push(
      outreach.openCount > 1 ? `Opened (${outreach.openCount})` : "Opened"
    );
  }
  if (outreach.clickCount > 0) {
    labels.push(
      outreach.clickCount > 1 ? `Clicked (${outreach.clickCount})` : "Clicked"
    );
  }
  return labels.length > 0 ? labels : [outreach.status];
}

function statusTone(outreach: OutreachState): BadgeTone {
  if (outreach.status === "failed") return "danger";
  if (outreach.status === "manual_review") return "warning";
  if (outreach.status === "cancelled") return "default";
  if (
    outreach.status === "scheduled" ||
    outreach.status === "retry_scheduled"
  ) {
    return "warning";
  }
  if (outreach.clickCount > 0 || outreach.openCount > 0) return "info";
  if (outreach.deliveredAt) return "success";
  if (outreach.status === "test") return "warning";
  return "default";
}

function queryWith(
  query: DashboardQuery,
  changes: {
    mode?: DashboardMode;
    filters?: Partial<MatchFilters>;
    page?: number;
  }
): DashboardQuery {
  return {
    mode: changes.mode ?? query.mode,
    filters: { ...query.filters, ...changes.filters },
    page: changes.page ?? query.page,
  };
}

export function DashboardClient({
  data,
  query,
  isWeekend,
  sendabilityRows,
  followUpEligibilityRows,
}: Props) {
  const { shows, modeCounts, pagination } = data;
  const filters = query.filters;
  const returnTo = buildDashboardHref(query);
  const sendabilityByTarget = new Map(
    sendabilityRows.map((row) => [
      `${row.showId}\u0000${row.contactId}`,
      row,
    ])
  );
  const followUpByParent = new Map(
    followUpEligibilityRows.map((row) => [row.parentOutreachId, row]),
  );
  const tabs: { key: DashboardMode; label: string; tone?: "amber" }[] = [
    { key: "matched", label: "Matched" },
    { key: "unknown", label: "Unknown but big" },
    { key: "interested", label: "★ Interested", tone: "amber" },
    { key: "dismissed", label: "Dismissed" },
  ];
  const filterGroups: { label: string; options: FilterOption[] }[] = [
    {
      label: "Range",
      options: [
        { key: "range", value: "7d", label: "7d" },
        { key: "range", value: "30d", label: "30d" },
        { key: "range", value: "30-60d", label: "30–60d" },
        { key: "range", value: "90d", label: "90d" },
      ],
    },
    {
      label: "Source",
      options: [
        { key: "source", value: "any", label: "Any" },
        { key: "source", value: "statsfm", label: "Stats.fm" },
        { key: "source", value: "spotify", label: "Spotify" },
      ],
    },
    {
      label: "Contact",
      options: [
        { key: "contact", value: "any", label: "Any" },
        { key: "contact", value: "has", label: "Has contact" },
        { key: "contact", value: "needs", label: "Needs contact" },
      ],
    },
    {
      label: "Status",
      options: [
        { key: "status", value: "any", label: "Any" },
        { key: "status", value: "unsent", label: "Unsent" },
        { key: "status", value: "sent", label: "Sent / scheduled" },
        { key: "status", value: "opened", label: "Opened" },
        { key: "status", value: "clicked", label: "Clicked" },
      ],
    },
  ];
  const filtersDirty =
    filters.search ||
    filters.range !== DEFAULT_FILTERS.range ||
    filters.source !== DEFAULT_FILTERS.source ||
    filters.contact !== DEFAULT_FILTERS.contact ||
    filters.status !== DEFAULT_FILTERS.status;

  return (
    <>
      <div className="mt-1 text-sm text-zinc-500">
        {data.totalUpcoming} total upcoming ·{" "}
        {data.totalSignals.toLocaleString()} listen signals
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-1 border-b border-zinc-200 dark:border-zinc-800">
        {tabs.map((tab) => {
          const active = query.mode === tab.key;
          return (
            <Link
              key={tab.key}
              href={buildDashboardHref(
                queryWith(query, { mode: tab.key, page: 1 })
              )}
              aria-current={active ? "page" : undefined}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition",
                active
                  ? tab.tone === "amber"
                    ? "border-amber-500 text-amber-700 dark:text-amber-400"
                    : "border-zinc-900 text-zinc-900 dark:border-zinc-100 dark:text-zinc-100"
                  : "border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
              )}
            >
              {tab.label}
              <span className="ml-1.5 text-xs text-zinc-400">
                {modeCounts[tab.key]}
              </span>
            </Link>
          );
        })}
      </div>

      <Card className="mt-6 p-4">
        <Form action="/dashboard" scroll={false} className="flex gap-2">
          {query.mode !== "matched" && (
            <input type="hidden" name="mode" value={query.mode} />
          )}
          {filters.range !== DEFAULT_FILTERS.range && (
            <input type="hidden" name="range" value={filters.range} />
          )}
          {filters.source !== DEFAULT_FILTERS.source && (
            <input type="hidden" name="src" value={filters.source} />
          )}
          {filters.contact !== DEFAULT_FILTERS.contact && (
            <input type="hidden" name="contact" value={filters.contact} />
          )}
          {filters.status !== DEFAULT_FILTERS.status && (
            <input type="hidden" name="status" value={filters.status} />
          )}
          <input
            key={filters.search}
            type="search"
            name="search"
            defaultValue={filters.search}
            placeholder="Search artist name…"
            className="h-9 min-w-0 flex-1 rounded-md border border-zinc-200 bg-white px-3 text-sm placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
          />
          <PendingSubmitButton pendingLabel="Searching…">Search</PendingSubmitButton>
          {filtersDirty && (
            <LinkButton
              href={buildDashboardHref({
                mode: query.mode,
                filters: DEFAULT_FILTERS,
                page: 1,
              })}
              variant="ghost"
            >
              Clear
            </LinkButton>
          )}
        </Form>
        <div className="mt-3 space-y-2">
          {filterGroups.map((group) => (
            <div key={group.label} className="flex flex-wrap items-center gap-1.5">
              <span className="w-16 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                {group.label}
              </span>
              {group.options.map((option) => {
                const active = filters[option.key] === option.value;
                const disabled =
                  query.mode === "unknown" &&
                  option.key === "source" &&
                  option.value !== "any";
                if (disabled) {
                  return (
                    <span
                      key={option.value}
                      aria-disabled="true"
                      title="Unknown artists have no active source signal"
                      className="cursor-not-allowed rounded-full border border-zinc-200 px-2.5 py-0.5 text-xs font-medium text-zinc-300 dark:border-zinc-800 dark:text-zinc-700"
                    >
                      {option.label}
                    </span>
                  );
                }
                return (
                  <Link
                    key={option.value}
                    href={buildDashboardHref(
                      queryWith(query, {
                        filters: { [option.key]: option.value },
                        page: 1,
                      })
                    )}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "rounded-full px-2.5 py-0.5 text-xs font-medium transition",
                      active
                        ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                        : "border border-zinc-200 text-zinc-600 hover:border-zinc-300 hover:text-zinc-900 dark:border-zinc-800 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-zinc-100"
                    )}
                  >
                    {option.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </div>
      </Card>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
        <span>
          {pagination.total === 0
            ? "0 shows"
            : `${pagination.start}–${pagination.end} of ${pagination.total} shows`}
        </span>
        <span>
          Page {pagination.page} of {pagination.pageCount}
        </span>
      </div>

      {shows.length === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed border-zinc-300 p-12 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No shows match this view. Try widening the range or clearing the search.
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {shows.map((show) => (
            <Card key={show.id} className="p-5">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm text-zinc-500">
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">
                    {formatShowDate(show.date)}
                  </span>
                  {" · "}
                  {show.venueName}
                  {show.state ? `, ${show.state}` : ""}
                  {show.ticketUrl && (
                    <>
                      {" · "}
                      <a
                        href={show.ticketUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-zinc-700 hover:underline dark:text-zinc-300"
                      >
                        EDMTrain ↗
                      </a>
                    </>
                  )}
                  {show.interestedAt && (
                    <>
                      {" · "}
                      <span className="text-amber-600 dark:text-amber-400">
                        ★ Interested
                      </span>
                    </>
                  )}
                </p>
                <div className="flex shrink-0 items-center gap-1">
                  <form action={setInterestedAction}>
                    <input type="hidden" name="returnTo" value={returnTo} />
                    <input type="hidden" name="showId" value={show.id} />
                    <input
                      type="hidden"
                      name="interested"
                      value={show.interestedAt ? "false" : "true"}
                    />
                    <PendingSubmitButton
                      variant="secondary"
                      size="sm"
                      pendingLabel="…"
                      aria-label={
                        show.interestedAt
                          ? "Unmark interested"
                          : "Mark interested"
                      }
                      title={
                        show.interestedAt
                          ? "Unmark interested"
                          : "Mark interested"
                      }
                      className={cn(
                        "h-8 w-8 px-0 text-base",
                        show.interestedAt
                          ? "border-amber-300 bg-amber-50 text-amber-600 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-400 dark:hover:bg-amber-950"
                          : "border-zinc-200 text-zinc-500 hover:border-amber-300 hover:text-amber-500 dark:border-zinc-800 dark:text-zinc-500 dark:hover:border-amber-800 dark:hover:text-amber-400"
                      )}
                    >
                      {show.interestedAt ? "★" : "☆"}
                    </PendingSubmitButton>
                  </form>
                  <form
                    action={
                      show.dismissedAt ? restoreShowAction : dismissShowAction
                    }
                  >
                    <input type="hidden" name="returnTo" value={returnTo} />
                    <input type="hidden" name="showId" value={show.id} />
                    <button
                      type="submit"
                      title={show.dismissedAt ? "Restore" : "Dismiss"}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-200 text-base text-zinc-500 transition hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-900 dark:border-zinc-800 dark:hover:border-zinc-700 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
                    >
                      {show.dismissedAt ? "↺" : "×"}
                    </button>
                  </form>
                </div>
              </div>

              <div className="mt-3 space-y-2">
                {show.matchedArtists.map((artist) => {
                  const emailContact = pickEmailContact(artist.contacts);
                  const phoneContact = pickPhoneContact(
                    artist.contacts,
                    emailContact
                  );
                  const directOutreachContact =
                    pickDirectOutreachContact(artist.contacts);
                  const contact =
                    emailContact ??
                    phoneContact ??
                    directOutreachContact ??
                    artist.contacts[0] ??
                    null;
                  const artistOutreaches = show.outreach.filter(
                    (outreach) =>
                      outreach.artistId === artist.id &&
                      outreach.kind === "original"
                  );
                  const manualMarker = artistOutreaches.find(
                    (outreach) =>
                      outreach.status === "sent" &&
                      outreach.isManualMarker
                  );
                  const sendability = emailContact
                    ? sendabilityByTarget.get(
                        `${show.id}\u0000${emailContact.id}`
                      )
                    : undefined;
                  const artistOutreach =
                    artistOutreaches.find(
                      (outreach) => outreach.status === "scheduled"
                    ) ??
                    artistOutreaches.find(
                      (outreach) => outreach.status === "retry_scheduled"
                    ) ??
                    artistOutreaches.find(
                      (outreach) => outreach.status === "sent"
                    ) ??
                    artistOutreaches.find(
                      (outreach) => outreach.status === "queued"
                    ) ??
                    artistOutreaches.find(
                      (outreach) => outreach.status === "manual_review"
                    ) ??
                    artistOutreaches.find(
                      (outreach) => outreach.status === "failed"
                    ) ??
                    artistOutreaches.find(
                      (outreach) => outreach.status === "test"
                    );
                  const outreach =
                    artistOutreach ??
                    (contact
                      ? show.outreach.find(
                          (row) =>
                            row.kind === "original" &&
                            row.contactId === contact.id
                        )
                      : undefined);
                  const followUpEligibility =
                    artistOutreaches
                      .map((row) => followUpByParent.get(row.id))
                      .find(
                        (row) =>
                          row &&
                          (row.state === "eligible" ||
                            row.state === "pending" ||
                            row.state === "sent"),
                      ) ??
                    artistOutreaches
                      .filter((row) => row.status === "sent")
                      .map((row) => followUpByParent.get(row.id))
                      .find((row) => row !== undefined);
                  const alreadySent =
                    sendability?.blockingStatus === "sent" ||
                    artistOutreach?.status === "sent";
                  const isScheduled =
                    isCancellableOutreachStatus(
                      sendability?.blockingStatus
                    ) ||
                    isCancellableOutreachStatus(artistOutreach?.status);
                  const emailDisabledLabel =
                    emailContact &&
                    !isScheduled &&
                    (!sendability || !sendability.sendable)
                      ? sendability?.blockingStatus === "queued"
                        ? "In progress"
                        : sendability?.blockingStatus === "retry_scheduled"
                          ? "Retry scheduled"
                          : sendability?.blockingStatus === "manual_review"
                            ? "Review"
                            : "Unavailable"
                      : undefined;
                  const scheduledOutreach =
                    artistOutreaches.find(
                      (row) =>
                        row.id === sendability?.blockingOutreachId
                    ) ??
                    (isCancellableOutreachStatus(artistOutreach?.status)
                      ? artistOutreach
                      : undefined);
                  const scheduledOutreachId =
                    sendability?.blockingOutreachId ?? scheduledOutreach?.id;
                  const scheduledStatus =
                    sendability?.blockingStatus ?? scheduledOutreach?.status;
                  const scheduledAt =
                    sendability?.blockingNextAttemptAt ??
                    scheduledOutreach?.nextAttemptAt ??
                    scheduledOutreach?.scheduledFor;
                  const scheduledInfo =
                    isScheduled && scheduledOutreachId
                      ? {
                          outreachId: scheduledOutreachId,
                          scheduledLabel: scheduledAt
                            ? `${
                                scheduledStatus === "retry_scheduled"
                                  ? "Retry"
                                  : "Scheduled"
                              } · ${scheduledAt.toLocaleString(
                                "en-US",
                                {
                                  timeZone: "America/New_York",
                                  weekday: "short",
                                  month: "short",
                                  day: "numeric",
                                  hour: "numeric",
                                  minute: "2-digit",
                                  hour12: true,
                                }
                              )}`
                            : scheduledStatus === "retry_scheduled"
                              ? "Retry scheduled"
                              : "Scheduled",
                        }
                      : null;

                  return (
                    <div
                      key={artist.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-100 bg-zinc-50/50 px-3 py-2 dark:border-zinc-900 dark:bg-zinc-900/40"
                    >
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <ArtistLink
                          artistId={artist.id}
                          returnTo={returnTo}
                          className="text-sm font-medium"
                        >
                          {artist.name}
                        </ArtistLink>
                        {artist.topSignal && (
                          <Badge tone="success">
                            {formatRankLabel(
                              artist.topSignal.source,
                              artist.topSignal.rank
                            )}
                          </Badge>
                        )}
                        {!artist.topSignal && artist.popularity != null && (
                          <Badge
                            tone="info"
                            title="Spotify popularity (0-100)"
                          >
                            Popularity {artist.popularity}
                          </Badge>
                        )}
                        {artist.playlists.map((playlist) => (
                          <a
                            key={playlist.spotifyId}
                            href={`spotify:playlist:${playlist.spotifyId}`}
                            title={`Open "${playlist.name}" in Spotify`}
                            className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200 transition hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900 dark:hover:bg-emerald-950"
                          >
                            ♪ {playlist.name}
                          </a>
                        ))}
                        {artist.playlistCount > artist.playlists.length && (
                          <span className="text-[10px] text-zinc-500">
                            +{artist.playlistCount - artist.playlists.length} more
                          </span>
                        )}
                        {artist.genres.map((genre) => (
                          <Badge key={genre} tone="muted" size="xs">
                            {genre}
                          </Badge>
                        ))}
                        {contact && (
                          <>
                            <Link
                              href={
                                artist.contacts.length > 1
                                  ? withWorkflowReturnTo(
                                      `/artists/${artist.id}`,
                                      returnTo
                                    )
                                  : withWorkflowReturnTo(
                                      `/dashboard/contact/${contact.id}`,
                                      returnTo
                                    )
                              }
                              className="inline-flex max-w-64 items-center truncate rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                              title={artist.contacts
                                .map((row) =>
                                  `${row.name ?? ""} ${
                                    row.email ? `<${row.email}>` : contactDisplayValue(row, "")
                                  }`.trim()
                                )
                                .join("\n")}
                            >
                              {hasDirectOutreachNote(contact)
                                ? contact.directOutreachNote
                                : contact.customPrice ??
                                  (artist.contacts.length > 1
                                    ? `${artist.contacts.length} contacts`
                                    : "edit")}
                            </Link>
                            {hasDirectOutreachNote(contact) && (
                              <Badge tone="warning" size="xs">
                                Direct outreach
                              </Badge>
                            )}
                            {hasDirectOutreachNote(contact) &&
                              contact.customPrice && (
                                <Badge tone="default" size="xs">
                                  {contact.customPrice}
                                </Badge>
                              )}
                            {emailContact?.isFullTeam && (
                              <Badge
                                tone="accent"
                                title="Email goes to the artist's full management team"
                              >
                                Full team
                              </Badge>
                            )}
                          </>
                        )}
                        {!contact && (
                          <Link
                            href={withWorkflowReturnTo(
                              `/dashboard/add-contact/${artist.id}`,
                              returnTo
                            )}
                            className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-200 transition hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900 dark:hover:bg-amber-950"
                          >
                            + Add contact
                          </Link>
                        )}
                        {outreach && (
                          <Badge tone={statusTone(outreach)}>
                            Original · {statusLabels(outreach).join(" · ")}
                          </Badge>
                        )}
                      </div>

                      <div className="flex shrink-0 flex-col items-end gap-1">
                        {(emailContact || phoneContact) && (
                          <div className="flex gap-1.5">
                            <SendButton
                              showId={show.id}
                              contactId={emailContact?.id ?? null}
                              contactName={emailContact?.name ?? null}
                              phone={phoneContact?.phone ?? null}
                              phoneContactName={phoneContact?.name ?? null}
                              alreadySent={alreadySent}
                              emailDisabledLabel={emailDisabledLabel}
                              emailDisabledReason={
                                sendability?.reason ?? undefined
                              }
                              isRetry={sendability?.mode === "retry"}
                              isWeekend={isWeekend}
                              scheduledInfo={scheduledInfo}
                              returnTo={returnTo}
                              action={sendNowAction}
                              cancelAction={cancelScheduledAction}
                            />
                            {emailContact &&
                              sendability?.mode !== "retry" && (
                              <LinkButton
                                href={withWorkflowReturnTo(
                                  `/dashboard/customize/${show.id}/${emailContact.id}`,
                                  returnTo
                                )}
                                variant="secondary"
                                size="sm"
                              >
                                Customize
                              </LinkButton>
                            )}
                          </div>
                        )}
                        {contact &&
                          !emailContact &&
                          !phoneContact &&
                          !isDirectOutreachOnly(contact) && (
                          <span className="text-[10px] text-amber-700 dark:text-amber-400">
                            No email or phone
                          </span>
                        )}
                        {emailContact && followUpEligibility && (
                          <FollowUpButton
                            eligibility={followUpEligibility}
                            returnTo={returnTo}
                            isWeekend={isWeekend}
                            action={sendFollowUpAction}
                            cancelAction={cancelScheduledAction}
                          />
                        )}
                        {artist.canMarkManually && (
                          <form action={markSentAction}>
                            <input
                              type="hidden"
                              name="returnTo"
                              value={returnTo}
                            />
                            <input
                              type="hidden"
                              name="showId"
                              value={show.id}
                            />
                            {contact ? (
                              <input
                                type="hidden"
                                name="contactId"
                                value={contact.id}
                              />
                            ) : (
                              <input
                                type="hidden"
                                name="artistId"
                                value={artist.id}
                              />
                            )}
                            <PendingSubmitButton
                              variant="ghost"
                              size="sm"
                              pendingLabel="Marking…"
                              title="Record as sent without actually emailing (use if you reached out via DM, personal email, etc.)"
                              className="h-auto px-0 py-0 text-[10px] font-normal text-zinc-500 hover:bg-transparent hover:text-zinc-900 dark:hover:bg-transparent dark:hover:text-zinc-100"
                            >
                              Mark sent (manual)
                            </PendingSubmitButton>
                          </form>
                        )}
                        {manualMarker && (
                          <form action={unmarkSentAction}>
                            <input
                              type="hidden"
                              name="returnTo"
                              value={returnTo}
                            />
                            <input
                              type="hidden"
                              name="outreachId"
                              value={manualMarker.id}
                            />
                            <PendingSubmitButton
                              variant="ghost"
                              size="sm"
                              pendingLabel="Unmarking…"
                              title="Remove this manual outreach marker"
                              className="h-auto px-0 py-0 text-[10px] font-normal text-zinc-500 hover:bg-transparent hover:text-zinc-900 dark:hover:bg-transparent dark:hover:text-zinc-100"
                            >
                              Unmark
                            </PendingSubmitButton>
                          </form>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {show.otherArtists.length > 0 && (
                <p className="mt-3 truncate text-xs text-zinc-400">
                  +{" "}
                  {show.otherArtists.map((artist, index) => (
                    <span key={artist.id}>
                      {index > 0 && ", "}
                      <ArtistLink
                        artistId={artist.id}
                        returnTo={returnTo}
                        className="hover:text-zinc-600 dark:hover:text-zinc-300"
                      >
                        {artist.name}
                      </ArtistLink>
                    </span>
                  ))}
                </p>
              )}
            </Card>
          ))}
        </div>
      )}

      {pagination.pageCount > 1 && (
        <nav
          aria-label="Dashboard pages"
          className="mt-6 flex items-center justify-between gap-3"
        >
          {pagination.hasPrevious ? (
            <LinkButton
              href={buildDashboardHref(
                queryWith(query, { page: pagination.page - 1 })
              )}
              variant="secondary"
            >
              ← Previous
            </LinkButton>
          ) : (
            <span />
          )}
          <span className="text-xs text-zinc-500">
            Page {pagination.page} of {pagination.pageCount}
          </span>
          {pagination.hasNext ? (
            <LinkButton
              href={buildDashboardHref(
                queryWith(query, { page: pagination.page + 1 })
              )}
              variant="secondary"
            >
              Next →
            </LinkButton>
          ) : (
            <span />
          )}
        </nav>
      )}
    </>
  );
}
