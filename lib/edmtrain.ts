import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  easternDateRange,
  parseDateOnly,
  splitDateOnlyRange,
  type DateOnlyRange,
} from "@/lib/calendarDate";
import {
  resolveArtists,
  type ArtistIdentityConflict,
  type ArtistIdentityInput,
} from "@/lib/artistIdentity";
import { normalizeCountry } from "@/lib/country";
import {
  resolveEdmtrainVenue,
  type CachedEdmtrainVenue,
  type VenueNycStatus,
} from "@/lib/edmtrainVenue";
import { festivalLeadTimeExclusion } from "@/lib/festivalEligibility";
import {
  asOperationDeadlineDeferredResult,
  assertOperationTimeRemaining,
  chunkItems,
  createOperationDeadline,
  makeIntegrationSyncLeaseKey,
  minimumDeadlineTransactionRemainingMs,
  operationDeadlineSignal,
  parseRetryAfterMs,
  PROVIDER_REQUEST_MIN_REMAINING_MS,
  ROUTE_DEADLINE_SAFETY_MARGIN_MS,
  runDeadlineBoundTransaction,
  waitForRetryBeforeDeadline,
  withIntegrationSyncLease,
  type DeadlineTransactionPolicy,
  type IntegrationSyncLeaseBusyResult,
  type IntegrationSyncLeaseGuard,
  type IntegrationSyncLeaseResult,
  type OperationDeadline,
  type OperationDeadlineDeferredResult,
} from "@/lib/integrationUtils";
import {
  acquireShowArtistMembershipLock,
  staleReadyTrajectoryRunsWithMissingMembership,
} from "@/lib/showArtistMembershipInvariant";

const EDMTRAIN_BASE = "https://edmtrain.com/api/events";
const NYC_LOCATION_ID = 38;
const EDMTRAIN_CHUNK_DAYS = 30;
const EDMTRAIN_MAX_ATTEMPTS = 4;
const EDMTRAIN_DEFAULT_OPERATION_MS = 5 * 60 * 1_000;
const EDMTRAIN_RECONCILIATION_MAX_WAIT_MS = 10_000;
const EDMTRAIN_RECONCILIATION_TIMEOUT_MS = 180_000;
const EDMTRAIN_RECONCILIATION_MIN_TIMEOUT_MS = 45_000;

function defaultEdmtrainDeadline(): OperationDeadline {
  return createOperationDeadline(EDMTRAIN_DEFAULT_OPERATION_MS, {
    safetyMarginMs: ROUTE_DEADLINE_SAFETY_MARGIN_MS,
  });
}

export interface EdmtrainArtist {
  id: number;
  name: string;
  b2bInd: boolean;
  link: string | null;
}

export interface EdmtrainEvent {
  id: number;
  date: string;
  ages: string | null;
  electronicGenreInd: boolean;
  festivalInd: boolean;
  livestreamInd: boolean;
  cancelledInd?: boolean;
  canceledInd?: boolean;
  status?: string | null;
  name: string | null;
  link: string | null;
  startTime: string | null;
  endTime: string | null;
  createdDate: string;
  artistList: EdmtrainArtist[];
  venue: {
    id: number;
    name: string;
    location: string;
    state: string;
    address: string;
    country: string;
    latitude: number;
    longitude: number;
  };
}

export function edmtrainEventGeography(event: EdmtrainEvent): {
  city: string;
  state: string | null;
  countryCode: string | null;
  countryName: string | null;
} {
  const locationParts = (event.venue.location ?? "")
    .split(",")
    .map((part) => part.trim());
  return {
    city: locationParts[0] || "Unknown",
    state: locationParts[1] || event.venue.state || null,
    ...normalizeCountry(event.venue.country),
  };
}

interface EdmtrainSnapshot {
  range: DateOnlyRange;
  events: EdmtrainEvent[];
  complete: true;
}

export function isValidEdmtrainSnapshotEvent(
  event: unknown
): boolean {
  if (typeof event !== "object" || event === null) return false;
  const candidate = event as Partial<EdmtrainEvent>;
  return (
    typeof candidate.id === "number" &&
    typeof candidate.date === "string" &&
    typeof candidate.festivalInd === "boolean" &&
    typeof candidate.electronicGenreInd === "boolean" &&
    typeof candidate.venue?.id === "number" &&
    typeof candidate.venue?.name === "string" &&
    Array.isArray(candidate.artistList)
  );
}

async function fetchEdmtrainChunk(
  startDate: string,
  endDate: string,
  locationIds: number[] | null,
  deadline: OperationDeadline
): Promise<EdmtrainEvent[]> {
  const apiKey = process.env.EDMTRAIN_API_KEY;
  if (!apiKey) throw new Error("Missing EDMTRAIN_API_KEY");
  const params = new URLSearchParams({
    client: apiKey,
    startDate,
    endDate,
  });
  if (locationIds && locationIds.length > 0) {
    params.set("locationIds", locationIds.join(","));
  }

  for (let attempt = 1; attempt <= EDMTRAIN_MAX_ATTEMPTS; attempt++) {
    const operation = `EDMTrain ${startDate}–${endDate} request`;
    assertOperationTimeRemaining(
      deadline,
      PROVIDER_REQUEST_MIN_REMAINING_MS,
      operation
    );
    let response: Response;
    try {
      response = await fetch(`${EDMTRAIN_BASE}?${params.toString()}`, {
        cache: "no-store",
        signal: operationDeadlineSignal(deadline, operation),
      });
    } catch (error) {
      if (attempt === EDMTRAIN_MAX_ATTEMPTS) throw error;
      await waitForRetryBeforeDeadline(
        deadline,
        attempt,
        null,
        `${operation} retry`
      );
      continue;
    }

    if (response.ok) {
      const json = (await response.json()) as {
        success?: boolean;
        data?: unknown;
        message?: string;
      };
      if (json.success !== true || !Array.isArray(json.data)) {
        throw new Error(
          `EDMTrain returned an incomplete snapshot${
            json.message ? `: ${json.message}` : ""
          }`
        );
      }
      for (const event of json.data) {
        if (!isValidEdmtrainSnapshotEvent(event)) {
          throw new Error(
            "EDMTrain returned an incomplete event snapshot with invalid scope flags"
          );
        }
      }
      return json.data as EdmtrainEvent[];
    }

    const body = await response.text();
    if (
      attempt < EDMTRAIN_MAX_ATTEMPTS &&
      (response.status === 429 || response.status >= 500)
    ) {
      await waitForRetryBeforeDeadline(
        deadline,
        attempt,
        parseRetryAfterMs(
          response.headers.get("retry-after"),
          deadline.now()
        ),
        `${operation} retry`
      );
      continue;
    }
    throw new Error(`EDMTrain ${response.status}: ${body.slice(0, 2_000)}`);
  }
  throw new Error("EDMTrain retry loop exhausted");
}

async function fetchEdmtrainSnapshot(
  daysAhead: number,
  locationIds: number[] | null,
  deadline: OperationDeadline,
  now: Date = new Date()
): Promise<EdmtrainSnapshot> {
  const range = easternDateRange(daysAhead, now);
  const chunks = splitDateOnlyRange(
    range.startDate,
    range.endDate,
    EDMTRAIN_CHUNK_DAYS
  );
  const eventsById = new Map<number, EdmtrainEvent>();
  // Chunking bounds response size; all chunks must succeed before reconciliation.
  for (const chunk of chunks) {
    assertOperationTimeRemaining(
      deadline,
      PROVIDER_REQUEST_MIN_REMAINING_MS,
      `EDMTrain ${chunk.startDate}–${chunk.endDate} chunk`
    );
    const events = await fetchEdmtrainChunk(
      chunk.startDate,
      chunk.endDate,
      locationIds,
      deadline
    );
    for (const event of events) {
      const date = parseDateOnly(event.date);
      if (date < range.start || date > range.end) continue;
      eventsById.set(event.id, event);
    }
  }
  return { range, events: Array.from(eventsById.values()), complete: true };
}

export async function fetchEdmtrainEvents(
  daysAhead = 90,
  locationIds: number[] | null = [NYC_LOCATION_ID],
  deadline: OperationDeadline = defaultEdmtrainDeadline()
): Promise<EdmtrainEvent[]> {
  return (await fetchEdmtrainSnapshot(daysAhead, locationIds, deadline)).events;
}

export function edmtrainEventStatus(
  event: EdmtrainEvent,
  venueNycStatus: VenueNycStatus = "inside_nyc",
  now: Date = new Date()
):
  | "active"
  | "cancelled"
  | "outside_nyc"
  | "geography_unknown"
  | "festival_past"
  | "lead_time_outside_nyc"
  | "lead_time_geography_unknown" {
  if (
    event.cancelledInd === true ||
    event.canceledInd === true ||
    /cancelled|canceled/i.test(event.status ?? "")
  ) {
    return "cancelled";
  }
  if (event.festivalInd) {
    return (
      festivalLeadTimeExclusion(
        {
          isFestival: true,
          date: parseDateOnly(event.date),
          festivalNycStatus: venueNycStatus,
        },
        now
      ) ?? "active"
    );
  }
  if (venueNycStatus === "outside_nyc") return "outside_nyc";
  if (venueNycStatus === "unknown") return "geography_unknown";
  return "active";
}

type EdmtrainScope = "nyc" | "festivals";

interface ScopedSnapshot {
  scope: EdmtrainScope;
  range: DateOnlyRange;
  events: EdmtrainEvent[];
  complete: true;
}

export interface SyncResult {
  fetched: number;
  upserted: number;
  artistsLinked: number;
  missing: number;
  cancelled: number;
  outsideNyc: number;
  geographyUnknown: number;
  leadTimeExcluded: number;
  leadTimeGeographyUnknown: number;
  venuesCached: number;
  venuesReused: number;
  identityConflicts: ArtistIdentityConflict[];
}

export type EdmtrainScopeSyncResult =
  | { ok: true; data: SyncResult }
  | { ok: false; error: string }
  | IntegrationSyncLeaseBusyResult
  | OperationDeadlineDeferredResult;

export interface EdmtrainSyncResult {
  nyc: EdmtrainScopeSyncResult;
  festivals: EdmtrainScopeSyncResult;
}

export type EdmtrainReconciliationScheduler = <T>(
  work: () => Promise<T>
) => Promise<T>;

export type EdmtrainScopeLeaseAcquirer = <T>(
  work: (lease: IntegrationSyncLeaseGuard) => Promise<T>
) => Promise<IntegrationSyncLeaseResult<T>>;

export function createSerializedEdmtrainReconciliationScheduler(): EdmtrainReconciliationScheduler {
  let reconciliationTail = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const execution = reconciliationTail.then(work);
    reconciliationTail = execution.then(
      () => undefined,
      () => undefined
    );
    return execution;
  };
}

export async function runLeasedEdmtrainSnapshotSync<Snapshot, Result>(
  acquireLease: EdmtrainScopeLeaseAcquirer,
  fetchSnapshot: () => Promise<Snapshot>,
  scheduleReconciliation: EdmtrainReconciliationScheduler,
  reconcileSnapshot: (
    snapshot: Snapshot,
    lease: IntegrationSyncLeaseGuard
  ) => Promise<Result>
): Promise<IntegrationSyncLeaseResult<Result>> {
  return acquireLease(async (lease) => {
    const snapshot = await fetchSnapshot();
    await lease.assertOwned();
    return scheduleReconciliation(async () => {
      await lease.assertOwned();
      return reconcileSnapshot(snapshot, lease);
    });
  });
}

function scopedEvents(
  scope: EdmtrainScope,
  events: readonly EdmtrainEvent[]
): EdmtrainEvent[] {
  return events.filter((event) =>
    scope === "festivals"
      ? event.festivalInd && event.electronicGenreInd
      : !event.festivalInd
  );
}

async function reconcileEdmtrainSnapshots(
  snapshots: readonly ScopedSnapshot[],
  lease: IntegrationSyncLeaseGuard,
  deadline: OperationDeadline,
  transactionPolicy: DeadlineTransactionPolicy
): Promise<Record<EdmtrainScope, SyncResult | undefined>> {
  for (const snapshot of snapshots) {
    if (!snapshot.complete) {
      throw new Error(`Refusing incomplete EDMTrain ${snapshot.scope} snapshot`);
    }
  }
  const now = new Date();
  const generation = randomUUID();
  const events = Array.from(
    new Map(
      snapshots
        .flatMap((snapshot) => snapshot.events)
        .map((event) => [event.id, event])
    ).values()
  );
  const edmArtists = new Map<number, EdmtrainArtist>();
  for (const event of events) {
    for (const artist of event.artistList) edmArtists.set(artist.id, artist);
  }
  const identities: ArtistIdentityInput[] = Array.from(
    edmArtists.values(),
    (artist) => ({
      key: String(artist.id),
      name: artist.name,
      edmtrainId: artist.id,
    })
  );

  return runDeadlineBoundTransaction(
    deadline,
    transactionPolicy,
    async (tx) => {
      await lease.fenceTransaction(tx);
      const resolved = await resolveArtists(tx, identities);
      let membershipLockAcquired = false;
      const result: Record<EdmtrainScope, SyncResult | undefined> = {
        nyc: undefined,
        festivals: undefined,
      };

      for (const snapshot of snapshots) {
        const venueById = new Map(
          snapshot.events.map((event) => [event.venue.id, event.venue])
        );
        const cachedVenues = await tx.edmtrainVenue.findMany({
          where: { id: { in: [...venueById.keys()] } },
          select: {
            id: true,
            address: true,
            location: true,
            city: true,
            state: true,
            countryCode: true,
            countryName: true,
            latitude: true,
            longitude: true,
            nycStatus: true,
            nycStatusReason: true,
            classificationVersion: true,
            sourceFingerprint: true,
          },
        });
        const cachedVenueById = new Map(
          cachedVenues.map((venue) => [
            venue.id,
            venue as CachedEdmtrainVenue,
          ])
        );
        const venues = [...venueById.values()].map((venue) =>
          resolveEdmtrainVenue(venue, cachedVenueById.get(venue.id))
        );
        const resolvedVenueById = new Map(
          venues.map((venue) => [venue.id, venue])
        );

        for (const venueChunk of chunkItems(venues, 400)) {
          const values = Prisma.join(
            venueChunk.map(
              (venue) =>
                Prisma.sql`(
                  ${venue.id},
                  ${venue.name},
                  ${venue.address},
                  ${venue.location},
                  ${venue.city},
                  ${venue.state},
                  ${venue.countryCode},
                  ${venue.countryName},
                  ${venue.latitude},
                  ${venue.longitude},
                  ${venue.nycStatus},
                  ${venue.nycStatusReason},
                  ${venue.geographySource},
                  ${venue.classificationVersion},
                  ${venue.sourceFingerprint},
                  ${now},
                  ${now},
                  ${now}
                )`
            )
          );
          await tx.$executeRaw(
            Prisma.sql`
              INSERT INTO "EdmtrainVenue" (
                "id", "name", "address", "location", "city", "state",
                "countryCode", "countryName", "latitude", "longitude",
                "nycStatus", "nycStatusReason", "geographySource",
                "classificationVersion", "sourceFingerprint", "lastSeenAt",
                "createdAt", "updatedAt"
              )
              VALUES ${values}
              ON CONFLICT ("id") DO UPDATE SET
                "name" = EXCLUDED."name",
                "address" = EXCLUDED."address",
                "location" = EXCLUDED."location",
                "city" = EXCLUDED."city",
                "state" = EXCLUDED."state",
                "countryCode" = EXCLUDED."countryCode",
                "countryName" = EXCLUDED."countryName",
                "latitude" = EXCLUDED."latitude",
                "longitude" = EXCLUDED."longitude",
                "nycStatus" = EXCLUDED."nycStatus",
                "nycStatusReason" = EXCLUDED."nycStatusReason",
                "geographySource" = EXCLUDED."geographySource",
                "classificationVersion" = EXCLUDED."classificationVersion",
                "sourceFingerprint" = EXCLUDED."sourceFingerprint",
                "lastSeenAt" = EXCLUDED."lastSeenAt",
                "updatedAt" = EXCLUDED."updatedAt"
            `
          );
        }

        const rows = snapshot.events.map((event) => {
          const venue = resolvedVenueById.get(event.venue.id);
          if (!venue) {
            throw new Error(`EDMTrain venue was not resolved: ${event.venue.id}`);
          }
          return {
            id: randomUUID(),
            event,
            date: parseDateOnly(event.date),
            venue,
            city: venue.city ?? "Unknown",
            state: venue.state,
            countryCode: venue.countryCode,
            countryName: venue.countryName,
            status: edmtrainEventStatus(event, venue.nycStatus, now),
          };
        });

        for (const rowChunk of chunkItems(rows, 400)) {
          const values = Prisma.join(
            rowChunk.map(
              ({
                id,
                event,
                date,
                venue,
                city,
                state,
                countryCode,
                countryName,
                status,
              }) =>
                Prisma.sql`(
                    ${id},
                    ${event.id},
                    ${venue.id},
                    ${date},
                    ${event.venue.name},
                    ${city},
                    ${state},
                    ${countryCode},
                    ${countryName},
                    ${event.link},
                    ${event.ages},
                    ${event.electronicGenreInd ? "electronic" : "other"},
                    ${event.festivalInd},
                    ${event.festivalInd ? venue.nycStatus : null},
                    ${event.name},
                    ${"edmtrain"},
                    ${status},
                    ${now},
                    ${generation},
                    ${JSON.stringify(event)},
                    ${now},
                    ${now}
                  )`
            )
          );
          await tx.$executeRaw(
            Prisma.sql`
                INSERT INTO "Show" (
                  "id", "edmtrainId", "edmtrainVenueId", "date", "venueName", "city", "state",
                  "countryCode", "countryName", "ticketUrl", "ages",
                  "electronicGenre", "isFestival", "festivalNycStatus", "eventName", "source",
                  "syncStatus", "sourceLastSeenAt", "sourceGeneration", "raw",
                  "createdAt", "updatedAt"
                )
                VALUES ${values}
                ON CONFLICT ("edmtrainId") DO UPDATE SET
                  "date" = EXCLUDED."date",
                  "edmtrainVenueId" = EXCLUDED."edmtrainVenueId",
                  "venueName" = EXCLUDED."venueName",
                  "city" = EXCLUDED."city",
                  "state" = EXCLUDED."state",
                  "countryCode" = EXCLUDED."countryCode",
                  "countryName" = EXCLUDED."countryName",
                  "ticketUrl" = EXCLUDED."ticketUrl",
                  "ages" = EXCLUDED."ages",
                  "electronicGenre" = EXCLUDED."electronicGenre",
                  "isFestival" = EXCLUDED."isFestival",
                  "festivalNycStatus" = EXCLUDED."festivalNycStatus",
                  "eventName" = EXCLUDED."eventName",
                  "source" = EXCLUDED."source",
                  "syncStatus" = EXCLUDED."syncStatus",
                  "sourceLastSeenAt" = EXCLUDED."sourceLastSeenAt",
                  "sourceGeneration" = EXCLUDED."sourceGeneration",
                  "raw" = EXCLUDED."raw",
                  "updatedAt" = EXCLUDED."updatedAt"
              `
          );
        }

        const eventIds = rows.map((row) => row.event.id);
        const persistedShows = (
          await Promise.all(
            chunkItems(eventIds, 2_000).map((eventIdChunk) =>
              tx.show.findMany({
                where: { edmtrainId: { in: eventIdChunk } },
                select: { id: true, edmtrainId: true },
              })
            )
          )
        ).flat();
        const showIdByEvent = new Map(
          persistedShows.map((show) => [show.edmtrainId, show.id])
        );
        if (persistedShows.length > 0) {
          if (!membershipLockAcquired) {
            await acquireShowArtistMembershipLock(tx);
            membershipLockAcquired = true;
          }
          await tx.showArtist.deleteMany({
            where: { showId: { in: persistedShows.map((show) => show.id) } },
          });
        }
        const lineupRows = rows.flatMap(({ event }) => {
          const showId = showIdByEvent.get(event.id);
          if (!showId) throw new Error(`EDMTrain event was not persisted: ${event.id}`);
          return event.artistList.map((artist) => {
            const resolvedArtist = resolved.artistsByKey.get(String(artist.id));
            if (!resolvedArtist) {
              throw new Error(`EDMTrain artist was not resolved: ${artist.id}`);
            }
            return {
              showId,
              artistId: resolvedArtist.id,
              headliner: false,
            };
          });
        });
        for (const lineupChunk of chunkItems(lineupRows, 2_000)) {
          await tx.showArtist.createMany({
            data: lineupChunk,
            skipDuplicates: true,
          });
        }

        const scopeFestival = snapshot.scope === "festivals";
        const missingWhere: Prisma.ShowWhereInput = {
          source: "edmtrain",
          isFestival: scopeFestival,
          date: { gte: snapshot.range.start, lte: snapshot.range.end },
          ...(eventIds.length > 0
            ? { edmtrainId: { notIn: eventIds } }
            : { edmtrainId: { not: null } }),
        };
        const missing = await tx.show.updateMany({
          where: missingWhere,
          data: {
            syncStatus: "missing",
            sourceGeneration: generation,
          },
        });

        const cancelledCount = rows.filter(
          (row) => row.status === "cancelled"
        ).length;
        const outsideNycCount = rows.filter(
          (row) => row.status === "outside_nyc"
        ).length;
        const geographyUnknownCount = rows.filter(
          (row) => row.status === "geography_unknown"
        ).length;
        const leadTimeExcludedCount = rows.filter(
          (row) => row.status === "lead_time_outside_nyc"
        ).length;
        const leadTimeGeographyUnknownCount = rows.filter(
          (row) => row.status === "lead_time_geography_unknown"
        ).length;
        const settingKey =
          snapshot.scope === "festivals"
            ? "edmtrain_festivals_last_sync"
            : "edmtrain_last_sync";
        await tx.setting.upsert({
          where: { key: settingKey },
          create: { key: settingKey, value: now.toISOString() },
          update: { value: now.toISOString() },
        });
        result[snapshot.scope] = {
          fetched: snapshot.events.length,
          upserted: rows.length,
          artistsLinked: lineupRows.length,
          missing: missing.count,
          cancelled: cancelledCount,
          outsideNyc: outsideNycCount,
          geographyUnknown: geographyUnknownCount,
          leadTimeExcluded: leadTimeExcludedCount,
          leadTimeGeographyUnknown: leadTimeGeographyUnknownCount,
          venuesCached: venues.length,
          venuesReused: venues.filter((venue) => venue.reused).length,
          identityConflicts: resolved.conflicts,
        };
      }
      if (membershipLockAcquired) {
        await staleReadyTrajectoryRunsWithMissingMembership(tx);
      }
      return result;
    }
  );
}

function edmtrainReconciliationTransaction(
  scope: EdmtrainScope
): DeadlineTransactionPolicy {
  return {
    operation: `${scope} EDMTrain reconciliation`,
    maxWaitMs: EDMTRAIN_RECONCILIATION_MAX_WAIT_MS,
    timeoutMs: EDMTRAIN_RECONCILIATION_TIMEOUT_MS,
    minimumTimeoutMs: EDMTRAIN_RECONCILIATION_MIN_TIMEOUT_MS,
    lockTimeoutMs: EDMTRAIN_RECONCILIATION_MAX_WAIT_MS,
  };
}

async function makeScopedSnapshot(
  scope: EdmtrainScope,
  snapshot: EdmtrainSnapshot
): Promise<ScopedSnapshot> {
  if (!snapshot.events.every(isValidEdmtrainSnapshotEvent)) {
    throw new Error(
      `Refusing incomplete EDMTrain ${scope} snapshot with invalid scope flags`
    );
  }
  return {
    scope,
    range: snapshot.range,
    events: scopedEvents(scope, snapshot.events),
    complete: true,
  };
}

async function fetchScopedEdmtrainSnapshot(
  scope: EdmtrainScope,
  daysAhead: number,
  locationIds: number[] | null,
  deadline: OperationDeadline
): Promise<ScopedSnapshot> {
  const transactionPolicy = edmtrainReconciliationTransaction(scope);
  assertOperationTimeRemaining(
    deadline,
    minimumDeadlineTransactionRemainingMs(transactionPolicy),
    `${scope} EDMTrain synchronization`
  );
  const snapshot = await fetchEdmtrainSnapshot(
    daysAhead,
    locationIds,
    deadline
  );
  return makeScopedSnapshot(scope, snapshot);
}

async function reconcileScopedEdmtrainSnapshot(
  snapshot: ScopedSnapshot,
  lease: IntegrationSyncLeaseGuard,
  deadline: OperationDeadline
): Promise<SyncResult> {
  const transactionPolicy = edmtrainReconciliationTransaction(snapshot.scope);
  const result = await reconcileEdmtrainSnapshots(
    [snapshot],
    lease,
    deadline,
    transactionPolicy
  );
  const reconciled = result[snapshot.scope];
  if (!reconciled) {
    throw new Error(`${snapshot.scope} EDMTrain snapshot was not reconciled`);
  }
  return reconciled;
}

async function syncEdmtrainScope(
  scope: EdmtrainScope,
  daysAhead: number,
  locationIds: number[] | null,
  deadline: OperationDeadline,
  scheduleReconciliation: EdmtrainReconciliationScheduler = (work) => work()
): Promise<EdmtrainScopeSyncResult> {
  try {
    const transactionPolicy = edmtrainReconciliationTransaction(scope);
    assertOperationTimeRemaining(
      deadline,
      minimumDeadlineTransactionRemainingMs(transactionPolicy),
      `${scope} EDMTrain synchronization`
    );
    const execution = await runLeasedEdmtrainSnapshotSync(
      (work) =>
        withIntegrationSyncLease(
          makeIntegrationSyncLeaseKey(`edmtrain-${scope}`),
          work,
          {
            deadline,
            minimumRemainingMs:
              minimumDeadlineTransactionRemainingMs(transactionPolicy),
          }
        ),
      () =>
        fetchScopedEdmtrainSnapshot(
          scope,
          daysAhead,
          locationIds,
          deadline
        ),
      scheduleReconciliation,
      (snapshot, lease) =>
        reconcileScopedEdmtrainSnapshot(snapshot, lease, deadline)
    );
    return execution.ok ? { ok: true, data: execution.data } : execution;
  } catch (error) {
    const deferred = asOperationDeadlineDeferredResult(error, {
      deadline,
      operation: `${scope} EDMTrain synchronization`,
    });
    if (deferred) return deferred;
    throw error;
  }
}

export async function syncEdmtrainShows(
  daysAhead = 90,
  deadline: OperationDeadline = defaultEdmtrainDeadline()
): Promise<EdmtrainScopeSyncResult> {
  return syncEdmtrainScope("nyc", daysAhead, [NYC_LOCATION_ID], deadline);
}

export async function syncEdmtrainFestivals(
  daysAhead = 365,
  deadline: OperationDeadline = defaultEdmtrainDeadline()
): Promise<EdmtrainScopeSyncResult> {
  return syncEdmtrainScope("festivals", daysAhead, null, deadline);
}

export async function syncAllEdmtrain(
  showDaysAhead = 90,
  festivalDaysAhead = 365,
  deadline: OperationDeadline = defaultEdmtrainDeadline()
): Promise<EdmtrainSyncResult> {
  const scheduleReconciliation =
    createSerializedEdmtrainReconciliationScheduler();
  const [nyc, festivals] = await Promise.all([
    captureEdmtrainSync(
      () =>
        syncEdmtrainScope(
          "nyc",
          showDaysAhead,
          [NYC_LOCATION_ID],
          deadline,
          scheduleReconciliation
        ),
      { deadline, operation: "nyc EDMTrain synchronization" }
    ),
    captureEdmtrainSync(
      () =>
        syncEdmtrainScope(
          "festivals",
          festivalDaysAhead,
          null,
          deadline,
          scheduleReconciliation
        ),
      {
        deadline,
        operation: "festivals EDMTrain synchronization",
      }
    ),
  ]);
  return { nyc, festivals };
}

async function captureEdmtrainSync(
  work: () => Promise<SyncResult | EdmtrainScopeSyncResult>,
  context?: { deadline: OperationDeadline; operation: string }
): Promise<EdmtrainScopeSyncResult> {
  try {
    const result = await work();
    return "ok" in result ? result : { ok: true, data: result };
  } catch (error) {
    const deferred = asOperationDeadlineDeferredResult(error, context ?? {});
    if (deferred) return deferred;
    return {
      ok: false,
      error: (error instanceof Error ? error.message : String(error)).slice(
        0,
        2_000
      ),
    };
  }
}

export async function runConcurrentEdmtrainSnapshotSyncs<
  NycSnapshot,
  FestivalSnapshot,
>(
  fetchNyc: () => Promise<NycSnapshot>,
  fetchFestivals: () => Promise<FestivalSnapshot>,
  reconcileNyc: (
    snapshot: NycSnapshot
  ) => Promise<SyncResult | EdmtrainScopeSyncResult>,
  reconcileFestivals: (
    snapshot: FestivalSnapshot
  ) => Promise<SyncResult | EdmtrainScopeSyncResult>,
  contexts: {
    nyc?: { deadline: OperationDeadline; operation: string };
    festivals?: { deadline: OperationDeadline; operation: string };
  } = {}
): Promise<EdmtrainSyncResult> {
  const serializeReconciliation =
    createSerializedEdmtrainReconciliationScheduler();
  const runScope = async <Snapshot>(
    fetchSnapshot: () => Promise<Snapshot>,
    reconcileSnapshot: (
      snapshot: Snapshot
    ) => Promise<SyncResult | EdmtrainScopeSyncResult>,
    context?: { deadline: OperationDeadline; operation: string }
  ): Promise<EdmtrainScopeSyncResult> => {
    let snapshot: Snapshot;
    try {
      snapshot = await fetchSnapshot();
    } catch (error) {
      return captureEdmtrainSync(async () => {
        throw error;
      }, context);
    }
    return serializeReconciliation(() =>
      captureEdmtrainSync(() => reconcileSnapshot(snapshot), context)
    );
  };

  const [nyc, festivals] = await Promise.all([
    runScope(fetchNyc, reconcileNyc, contexts.nyc),
    runScope(fetchFestivals, reconcileFestivals, contexts.festivals),
  ]);
  return { nyc, festivals };
}

export async function runIndependentEdmtrainSyncs(
  syncNyc: () => Promise<SyncResult | EdmtrainScopeSyncResult>,
  syncFestivals: () => Promise<SyncResult | EdmtrainScopeSyncResult>
): Promise<EdmtrainSyncResult> {
  const [nyc, festivals] = await Promise.all([
    captureEdmtrainSync(syncNyc),
    captureEdmtrainSync(syncFestivals),
  ]);
  return { nyc, festivals };
}
