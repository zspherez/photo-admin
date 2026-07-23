import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { easternTodayStoredDate } from "@/lib/calendarDate";
import { activeListenSignalWhere } from "@/lib/listenSignal";
import { satisfiesFestivalLeadTime } from "@/lib/festivalEligibility";
import {
  getFollowUpEligibilityBatch,
  getOutreachSendabilityBatch,
} from "@/lib/sendOutreach";
import {
  pickEmailContact,
  pickPhoneContact,
} from "@/lib/contactSelection";
import { isCancellableOutreachStatus } from "@/lib/outreachStatus";
import {
  getNextNormalOutreachDispatch,
  isWeekendET,
} from "@/lib/schedule";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const now = new Date();
  const today = easternTodayStoredDate(now);
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
      where: { artistId: id, kind: "original" },
      select: { id: true, showId: true, status: true },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    }),
  ]);
  if (!artist) return NextResponse.json({ error: "not found" }, { status: 404 });

  const genres: string[] = (() => {
    try {
      return artist.genres
        ? (JSON.parse(artist.genres) as string[]).filter((g) => typeof g === "string")
        : [];
    } catch {
      return [];
    }
  })();

  const upcoming = artist.shows
    .map((sa) => sa.show)
    .filter(
      (s) =>
        s.date >= today &&
        s.syncStatus === "active" &&
        satisfiesFestivalLeadTime(s, now)
    )
    .slice(0, 20);
  const emailContact = pickEmailContact(artist.contacts);
  const phoneContact = pickPhoneContact(artist.contacts, emailContact);
  const [sendabilityRows, followUpRows] = await Promise.all([
    emailContact
      ? getOutreachSendabilityBatch(
          upcoming.map((show) => ({
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
    sendabilityRows.map((row) => [row.showId, row]),
  );
  const followUpByParent = new Map(
    followUpRows.map((row) => [row.parentOutreachId, row]),
  );
  const outreachesByShow = new Map<string, typeof outreaches>();
  for (const outreach of outreaches) {
    const rows = outreachesByShow.get(outreach.showId) ?? [];
    rows.push(outreach);
    outreachesByShow.set(outreach.showId, rows);
  }
  const nextDispatch = getNextNormalOutreachDispatch(now);

  return NextResponse.json({
    id: artist.id,
    name: artist.name,
    imageUrl: artist.imageUrl,
    spotifyId: artist.spotifyId,
    statsfmId: artist.statsfmId,
    edmtrainId: artist.edmtrainId,
    popularity: artist.popularity,
    genres,
    listenSignals: artist.listenSignals.map((s) => ({
      source: s.source,
      rank: s.rank,
      playCount: s.playCount,
      lastSeenAt: s.lastSeenAt,
    })),
    playlists: artist.playlists.map((ap) => ({
      spotifyId: ap.playlist.spotifyId,
      name: ap.playlist.name,
      url: ap.playlist.url,
    })),
    contacts: artist.contacts.map((c) => ({
      id: c.id,
      name: c.name,
      email: c.email,
      phone: c.phone,
      directOutreachNote: c.directOutreachNote,
      role: c.role,
      customPrice: c.customPrice,
      isFullTeam: c.isFullTeam,
      state: c.state,
    })),
    actionContacts: {
      email: emailContact
        ? {
            id: emailContact.id,
            name: emailContact.name,
          }
        : null,
      phone: phoneContact
        ? {
            phone: phoneContact.phone,
            name: phoneContact.name,
          }
        : null,
    },
    nextDispatchBoundary: {
      renderedAtMs: now.getTime(),
      dispatchAtMs: nextDispatch.getTime(),
    },
    isWeekend: isWeekendET(now),
    upcomingShows: upcoming.map((s) => {
      const showOutreaches = outreachesByShow.get(s.id) ?? [];
      const outreach =
        showOutreaches.find((row) => row.status === "scheduled") ??
        showOutreaches.find((row) => row.status === "retry_scheduled") ??
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
      const scheduledInfo =
        isCancellableOutreachStatus(sendability?.blockingStatus) &&
        sendability?.blockingOutreachId
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
                    },
                  )}`
                : sendability.blockingStatus === "retry_scheduled"
                  ? "Retry scheduled"
                  : "Scheduled",
            }
          : null;
      return {
        id: s.id,
        date: s.date,
        venueName: s.venueName,
        state: s.state,
        city: s.city,
        eventName: s.eventName,
        isFestival: s.isFestival,
        alreadySent:
          sendability?.blockingStatus === "sent" ||
          outreach?.status === "sent",
        scheduledInfo,
        sendability: sendability
          ? {
              sendable: sendability.sendable,
              mode: sendability.mode,
              reason: sendability.reason,
              blockingStatus: sendability.blockingStatus ?? null,
            }
          : null,
        followUpEligibility: followUpEligibility
          ? {
              ...followUpEligibility,
              nextAttemptAt:
                followUpEligibility.nextAttemptAt?.toISOString() ?? null,
            }
          : null,
      };
    }),
  });
}
