import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getTopTracks } from "@/lib/statsfm";
import {
  createPlaylist,
  getCurrentSpotifyUserId,
  getValidAccessToken,
  isSpotifyPlaylistOwnedByUser,
  listAllCurrentUserPlaylists,
  playlistOwnedByUser,
  replacePlaylistItems,
  searchTrackUri,
  SpotifyApiError,
  SpotifyPlaylistDetailsMutationUncertainError,
  SpotifyPlaylistMutationUncertainError,
  SPOTIFY_SYNC_LEASE_KEY,
  updatePlaylistDescription,
  type CurrentUserPlaylist,
} from "@/lib/spotify";
import {
  asOperationDeadlineDeferredResult,
  assertOperationTimeRemaining,
  createOperationDeadline,
  DeferredRetryError,
  IntegrationSyncLeaseLostError,
  isAbortSignalDeadlineError,
  mapWithConcurrency,
  minimumDeadlineTransactionRemainingMs,
  OperationDeadlineExceededError,
  operationDeadlineWithReservedTime,
  PROVIDER_REQUEST_MIN_REMAINING_MS,
  ROUTE_DEADLINE_SAFETY_MARGIN_MS,
  runDeadlineBoundTransaction,
  sleepBeforeDeadline,
  withIntegrationSyncLease,
  type DeadlineTransactionPolicy,
  type IntegrationSyncLeaseBusyResult,
  type IntegrationSyncLeaseCompletedResult,
  type IntegrationSyncLeaseGuard,
  type OperationDeadline,
  type OperationDeadlineDeferredResult,
} from "@/lib/integrationUtils";

const PLAYLIST_ID_KEY = "top_tracks_playlist_id";
const PLAYLIST_LOCK_KEY = "top_tracks_playlist_creation_lock";
const PLAYLIST_LAST_SYNC_KEY = "top_tracks_playlist_last_sync";
const PLAYLIST_NAME = "My Top Songs · Last 4 Weeks";
export const PLAYLIST_DESCRIPTION_BASE =
  "Auto-updated every morning — my top tracks from the last 4 weeks (via stats.fm).";
const PLAYLIST_DESCRIPTION_TIMESTAMP_PREFIX = `${PLAYLIST_DESCRIPTION_BASE} Last updated: `;
const PLAYLIST_TIME_ZONE = "America/New_York";
const PLAYLIST_CREATION_GRACE_MS = 10 * 60 * 1_000;
const TOP_PLAYLIST_DEFAULT_OPERATION_MS = 3 * 60 * 1_000;
const TOP_PLAYLIST_TRANSACTION_MAX_WAIT_MS = 15_000;
const TOP_PLAYLIST_TRANSACTION_TIMEOUT_MS = 30_000;
const TOP_PLAYLIST_TRANSACTION_MIN_TIMEOUT_MS = 5_000;

function topPlaylistTransaction(
  operation: string
): DeadlineTransactionPolicy {
  return {
    operation,
    maxWaitMs: TOP_PLAYLIST_TRANSACTION_MAX_WAIT_MS,
    timeoutMs: TOP_PLAYLIST_TRANSACTION_TIMEOUT_MS,
    minimumTimeoutMs: TOP_PLAYLIST_TRANSACTION_MIN_TIMEOUT_MS,
    lockTimeoutMs: 5_000,
  };
}

const TOP_PLAYLIST_FRESHNESS_TRANSACTION = topPlaylistTransaction(
  "Top-playlist freshness persistence"
);
const TOP_PLAYLIST_CREATION_FINALIZATION_TRANSACTION = topPlaylistTransaction(
  "Top-playlist creation finalization"
);

function defaultTopPlaylistDeadline(): OperationDeadline {
  return createOperationDeadline(TOP_PLAYLIST_DEFAULT_OPERATION_MS, {
    safetyMarginMs: ROUTE_DEADLINE_SAFETY_MARGIN_MS,
  });
}

export interface TopPlaylistResult {
  sourceTracks: number;
  matchedUris: number;
  unmatched: string[];
  playlistId: string;
  playlistUrl: string;
  created: boolean;
}

export interface TopPlaylistLeaseStaleResult {
  ok: false;
  status: "stale";
  reason: "lease_lost";
  leaseKey: string;
}

export interface TopPlaylistExternalWritePartialResult {
  ok: false;
  status: "partial";
  reason: "external_write_completed_freshness_not_persisted";
  data: TopPlaylistResult;
  details: {
    phase: "freshness_persistence";
    externalWriteCompleted: true;
    freshnessPersisted: false;
    priorSnapshotPreserved: false;
    error: string;
    leaseKey: string | null;
    deadline: {
      cause: NonNullable<
        OperationDeadlineDeferredResult["details"]["deadlineCause"]
      >;
      operation: string;
      requiredMs: number;
      remainingMs: number;
      expiresAtMs: number | null;
      retryAfterMs: number | null;
      safeExecutionBudgetMs: number | null;
    } | null;
  };
}

export interface TopPlaylistExternalWriteUncertainResult {
  ok: false;
  status: "partial";
  reason: "external_write_outcome_uncertain";
  data: TopPlaylistResult;
  details: {
    phase: "external_write";
    externalWriteCompleted: null;
    externalWriteMayHaveCompleted: true;
    freshnessPersisted: false;
    priorSnapshotPreserved: false;
    verification: "not_attempted";
    error: string;
    playlistId: string;
    deadline: {
      cause: NonNullable<
        OperationDeadlineDeferredResult["details"]["deadlineCause"]
      >;
      operation: string;
      requiredMs: number;
      remainingMs: number;
      expiresAtMs: number | null;
      retryAfterMs: number | null;
      safeExecutionBudgetMs: number | null;
    } | null;
  };
}

export interface TopPlaylistDescriptionUpdateFailedResult {
  ok: false;
  status: "partial";
  reason: "playlist_description_update_failed";
  data: TopPlaylistResult;
  details: {
    phase: "playlist_description_update";
    itemReplacementCompleted: true;
    descriptionUpdateCompleted: false;
    descriptionUpdateMayHaveCompleted: false;
    freshnessPersisted: false;
    priorSnapshotPreserved: false;
    error: string;
    providerStatus: number | null;
    retryAfterMs: number | null;
    deadline: {
      cause: NonNullable<
        OperationDeadlineDeferredResult["details"]["deadlineCause"]
      >;
      operation: string;
      requiredMs: number;
      remainingMs: number;
      expiresAtMs: number | null;
      retryAfterMs: number | null;
      safeExecutionBudgetMs: number | null;
    } | null;
  };
}

export interface TopPlaylistDescriptionUpdateUncertainResult {
  ok: false;
  status: "partial";
  reason: "playlist_description_update_outcome_uncertain";
  data: TopPlaylistResult;
  details: {
    phase: "playlist_description_update";
    itemReplacementCompleted: true;
    descriptionUpdateCompleted: null;
    descriptionUpdateMayHaveCompleted: true;
    freshnessPersisted: false;
    priorSnapshotPreserved: false;
    verification: "not_attempted";
    error: string;
    playlistId: string;
    deadline: {
      cause: NonNullable<
        OperationDeadlineDeferredResult["details"]["deadlineCause"]
      >;
      operation: string;
      requiredMs: number;
      remainingMs: number;
      expiresAtMs: number | null;
      retryAfterMs: number | null;
      safeExecutionBudgetMs: number | null;
    } | null;
  };
}

export interface TopPlaylistCreationUncertainResult {
  ok: false;
  status: "partial";
  reason: "playlist_creation_outcome_uncertain";
  details: {
    phase: "playlist_creation";
    creationDispatched: true;
    playlistCreated: null;
    externalMutationMayHaveCompleted: true;
    playlistId: null;
    playlistUrl: null;
    replacementCompleted: false;
    freshnessPersisted: false;
    priorSnapshotPreserved: false;
    recovery: "automatic_discovery_incomplete";
    error: string;
    recoveryError: string | null;
    deadline: {
      cause: NonNullable<
        OperationDeadlineDeferredResult["details"]["deadlineCause"]
      >;
      operation: string;
      requiredMs: number;
      remainingMs: number;
      expiresAtMs: number | null;
      retryAfterMs: number | null;
      safeExecutionBudgetMs: number | null;
    } | null;
  };
}

export interface TopPlaylistCreatedIncompleteResult {
  ok: false;
  status: "partial";
  reason: "created_playlist_incomplete";
  data: TopPlaylistResult;
  details: {
    phase: "playlist_id_persistence" | "playlist_replacement";
    creationCompleted: true;
    playlistId: string;
    playlistUrl: string;
    replacementCompleted: false;
    freshnessPersisted: false;
    priorSnapshotPreserved: false;
    recovery: "retry_or_reconcile_created_playlist";
    error: string;
    leaseKey: string | null;
    deadline: {
      cause: NonNullable<
        OperationDeadlineDeferredResult["details"]["deadlineCause"]
      >;
      operation: string;
      requiredMs: number;
      remainingMs: number;
      expiresAtMs: number | null;
      retryAfterMs: number | null;
      safeExecutionBudgetMs: number | null;
    } | null;
  };
}

export type TopPlaylistExecutionResult =
  | IntegrationSyncLeaseCompletedResult<TopPlaylistResult>
  | IntegrationSyncLeaseBusyResult
  | TopPlaylistLeaseStaleResult
  | OperationDeadlineDeferredResult
  | TopPlaylistExternalWritePartialResult
  | TopPlaylistExternalWriteUncertainResult
  | TopPlaylistDescriptionUpdateFailedResult
  | TopPlaylistDescriptionUpdateUncertainResult
  | TopPlaylistCreationUncertainResult
  | TopPlaylistCreatedIncompleteResult;

export function formatManagedPlaylistDescription(refreshedAt: Date): string {
  if (Number.isNaN(refreshedAt.getTime())) {
    throw new RangeError("Playlist refresh timestamp must be a valid date");
  }
  const timestamp = new Intl.DateTimeFormat("en-US", {
    timeZone: PLAYLIST_TIME_ZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(refreshedAt);
  return `${PLAYLIST_DESCRIPTION_TIMESTAMP_PREFIX}${timestamp}.`;
}

function isManagedPlaylistDescription(
  description: string | undefined
): boolean {
  return (
    description === PLAYLIST_DESCRIPTION_BASE ||
    description?.startsWith(PLAYLIST_DESCRIPTION_TIMESTAMP_PREFIX) === true
  );
}

export function minimumTopPlaylistFreshnessRemainingMs(): number {
  return minimumDeadlineTransactionRemainingMs(
    TOP_PLAYLIST_FRESHNESS_TRANSACTION
  );
}

export function minimumTopPlaylistExternalWriteRemainingMs(): number {
  return (
    PROVIDER_REQUEST_MIN_REMAINING_MS * 2 +
    minimumTopPlaylistFreshnessRemainingMs()
  );
}

export function minimumTopPlaylistCreationRemainingMs(): number {
  return (
    PROVIDER_REQUEST_MIN_REMAINING_MS +
    minimumDeadlineTransactionRemainingMs(
      TOP_PLAYLIST_CREATION_FINALIZATION_TRANSACTION
    ) +
    minimumTopPlaylistExternalWriteRemainingMs()
  );
}

export class TopPlaylistCreationOutcomeUncertainError extends Error {
  constructor(
    readonly creationFailure: unknown,
    readonly recoveryFailure: unknown = null
  ) {
    super(
      "Spotify playlist creation was dispatched, but the created resource could not be confirmed",
      { cause: recoveryFailure ?? creationFailure }
    );
    this.name = "TopPlaylistCreationOutcomeUncertainError";
  }
}

export type TopPlaylistCreationFailureClassification =
  | {
      disposition: "deferred" | "retryable" | "permanent";
      claimAction: "release";
      claimQuarantineMs: 0;
      creationDispatched: boolean;
      externalMutationMayHaveCompleted: false;
      priorSnapshotPreserved: true;
      providerStatus: number | null;
      retryAfterMs: number | null;
    }
  | {
      disposition: "uncertain";
      claimAction: "quarantine";
      claimQuarantineMs: number;
      creationDispatched: true;
      externalMutationMayHaveCompleted: true;
      priorSnapshotPreserved: false;
      providerStatus: number | null;
      retryAfterMs: number | null;
    };

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const visited = new Set<unknown>();
  let candidate = error;
  while (candidate && !visited.has(candidate) && chain.length < 10) {
    chain.push(candidate);
    visited.add(candidate);
    candidate =
      typeof candidate === "object" || typeof candidate === "function"
        ? Reflect.get(candidate, "cause")
        : null;
  }
  return chain;
}

function isAmbiguousPlaylistCreationNetworkFailure(error: unknown): boolean {
  return errorChain(error).some((candidate) => {
    if (isAbortSignalDeadlineError(candidate)) return true;
    if (!candidate || typeof candidate !== "object") return false;
    if (Reflect.get(candidate, "name") === "NetworkError") return true;
    const code = Reflect.get(candidate, "code");
    if (
      typeof code === "string" &&
      ([
        "ECONNABORTED",
        "ECONNRESET",
        "EHOSTUNREACH",
        "ENETRESET",
        "ENETUNREACH",
        "EPIPE",
        "ETIMEDOUT",
      ].includes(code) ||
        code.startsWith("UND_ERR_"))
    ) {
      return true;
    }
    const message =
      candidate instanceof Error ? candidate.message.toLowerCase() : "";
    return (
      message.includes("spotify returned invalid json") ||
      message.includes("fetch failed") ||
      message.includes("lost response")
    );
  });
}

export function classifyTopPlaylistCreationFailure(
  error: unknown
): TopPlaylistCreationFailureClassification {
  if (
    error instanceof OperationDeadlineExceededError ||
    error instanceof DeferredRetryError
  ) {
    const creationDispatched =
      error instanceof DeferredRetryError ||
      (error instanceof OperationDeadlineExceededError &&
        error.operation.includes(" retry"));
    return {
      disposition: "deferred",
      claimAction: "release",
      claimQuarantineMs: 0,
      creationDispatched,
      externalMutationMayHaveCompleted: false,
      priorSnapshotPreserved: true,
      providerStatus: null,
      retryAfterMs:
        error instanceof DeferredRetryError ? error.retryAfterMs : null,
    };
  }

  if (error instanceof SpotifyApiError) {
    if (error.status >= 500) {
      return {
        disposition: "uncertain",
        claimAction: "quarantine",
        claimQuarantineMs: PLAYLIST_CREATION_GRACE_MS,
        creationDispatched: true,
        externalMutationMayHaveCompleted: true,
        priorSnapshotPreserved: false,
        providerStatus: error.status,
        retryAfterMs: error.retryAfterMs,
      };
    }
    return {
      disposition:
        error.status === 408 || error.status === 429
          ? "retryable"
          : "permanent",
      claimAction: "release",
      claimQuarantineMs: 0,
      creationDispatched: true,
      externalMutationMayHaveCompleted: false,
      priorSnapshotPreserved: true,
      providerStatus: error.status,
      retryAfterMs: error.retryAfterMs,
    };
  }

  if (isAmbiguousPlaylistCreationNetworkFailure(error)) {
    return {
      disposition: "uncertain",
      claimAction: "quarantine",
      claimQuarantineMs: PLAYLIST_CREATION_GRACE_MS,
      creationDispatched: true,
      externalMutationMayHaveCompleted: true,
      priorSnapshotPreserved: false,
      providerStatus: null,
      retryAfterMs: null,
    };
  }

  return {
    disposition: "permanent",
    claimAction: "release",
    claimQuarantineMs: 0,
    creationDispatched: false,
    externalMutationMayHaveCompleted: false,
    priorSnapshotPreserved: true,
    providerStatus: null,
    retryAfterMs: null,
  };
}

export class TopPlaylistCreatedIncompleteError<
  T extends { id?: string; playlistId?: string },
> extends Error {
  constructor(
    readonly data: T,
    readonly phase: "playlist_id_persistence" | "playlist_replacement",
    readonly incompleteFailure: unknown
  ) {
    super(
      `Spotify created playlist ${
        data.playlistId ?? data.id ?? "unknown"
      }, but ${phase.replaceAll("_", " ")} did not complete`,
      { cause: incompleteFailure }
    );
    this.name = "TopPlaylistCreatedIncompleteError";
  }
}

export class TopPlaylistExternalWriteCompletedError<T> extends Error {
  constructor(
    readonly data: T,
    readonly freshnessFailure: unknown
  ) {
    super(
      "Spotify playlist replacement completed, but freshness persistence failed",
      { cause: freshnessFailure }
    );
    this.name = "TopPlaylistExternalWriteCompletedError";
  }
}

export class TopPlaylistExternalWriteUncertainError<T> extends Error {
  constructor(
    readonly data: T,
    readonly mutationFailure: SpotifyPlaylistMutationUncertainError
  ) {
    super(
      "Spotify playlist replacement outcome is uncertain; freshness was not persisted",
      { cause: mutationFailure }
    );
    this.name = "TopPlaylistExternalWriteUncertainError";
  }
}

export class TopPlaylistDescriptionUpdateFailedError<T> extends Error {
  constructor(
    readonly data: T,
    readonly descriptionFailure: unknown
  ) {
    super(
      "Spotify playlist items were replaced, but the description update failed",
      { cause: descriptionFailure }
    );
    this.name = "TopPlaylistDescriptionUpdateFailedError";
  }
}

export class TopPlaylistDescriptionUpdateUncertainError<T> extends Error {
  constructor(
    readonly data: T,
    readonly mutationFailure: SpotifyPlaylistDetailsMutationUncertainError
  ) {
    super(
      "Spotify playlist items were replaced, but the description update outcome is uncertain",
      { cause: mutationFailure }
    );
    this.name = "TopPlaylistDescriptionUpdateUncertainError";
  }
}

export async function runTopPlaylistExternalWrites<T>(
  data: T,
  replaceItems: () => Promise<void>,
  updateDescription: () => Promise<void>
): Promise<T> {
  try {
    await replaceItems();
  } catch (error) {
    if (error instanceof SpotifyPlaylistMutationUncertainError) {
      throw new TopPlaylistExternalWriteUncertainError(data, error);
    }
    throw error;
  }

  try {
    await updateDescription();
  } catch (error) {
    if (error instanceof SpotifyPlaylistDetailsMutationUncertainError) {
      throw new TopPlaylistDescriptionUpdateUncertainError(data, error);
    }
    throw new TopPlaylistDescriptionUpdateFailedError(data, error);
  }
  return data;
}

export async function runTopPlaylistCreationWithReservedDownstream<
  T extends { id?: string; playlistId?: string },
>(
  deadline: OperationDeadline,
  createRemotePlaylist: (
    creationDeadline: OperationDeadline
  ) => Promise<T>,
  persistCreatedPlaylist: (
    created: T,
    persistenceDeadline: OperationDeadline
  ) => Promise<void>
): Promise<T> {
  const externalWriteBudgetMs = minimumTopPlaylistExternalWriteRemainingMs();
  const persistenceBudgetMs = minimumDeadlineTransactionRemainingMs(
    TOP_PLAYLIST_CREATION_FINALIZATION_TRANSACTION
  );
  assertOperationTimeRemaining(
    deadline,
    PROVIDER_REQUEST_MIN_REMAINING_MS +
      persistenceBudgetMs +
      externalWriteBudgetMs,
    "Top-playlist creation with downstream persistence"
  );
  const creationDeadline = operationDeadlineWithReservedTime(
    deadline,
    persistenceBudgetMs + externalWriteBudgetMs,
    "Top-playlist creation downstream reservation"
  );
  let created: T;
  try {
    created = await createRemotePlaylist(creationDeadline);
  } catch (error) {
    const classification = classifyTopPlaylistCreationFailure(error);
    if (classification.claimAction === "quarantine") {
      throw new TopPlaylistCreationOutcomeUncertainError(error);
    }
    throw error;
  }

  const persistenceDeadline = operationDeadlineWithReservedTime(
    deadline,
    externalWriteBudgetMs,
    "Top-playlist replacement and freshness reservation"
  );
  try {
    await persistCreatedPlaylist(created, persistenceDeadline);
  } catch (error) {
    throw new TopPlaylistCreatedIncompleteError(
      created,
      "playlist_id_persistence",
      error
    );
  }
  return created;
}

export async function runTopPlaylistExternalWriteAndFreshness<T>(
  deadline: OperationDeadline,
  externalWrite: (writeDeadline: OperationDeadline) => Promise<T>,
  persistFreshness: () => Promise<void>
): Promise<T> {
  const freshnessBudgetMs = minimumTopPlaylistFreshnessRemainingMs();
  assertOperationTimeRemaining(
    deadline,
    minimumTopPlaylistExternalWriteRemainingMs(),
    "Top-playlist replacement with freshness persistence"
  );
  const writeDeadline = operationDeadlineWithReservedTime(
    deadline,
    freshnessBudgetMs,
    "Top-playlist freshness reservation"
  );
  const data = await externalWrite(writeDeadline);
  try {
    await persistFreshness();
  } catch (error) {
    throw new TopPlaylistExternalWriteCompletedError(data, error);
  }
  return data;
}

export function asTopPlaylistExternalWritePartialResult(
  error: unknown,
  deadline: OperationDeadline
):
  | TopPlaylistExternalWritePartialResult
  | TopPlaylistExternalWriteUncertainResult
  | TopPlaylistDescriptionUpdateFailedResult
  | TopPlaylistDescriptionUpdateUncertainResult
  | TopPlaylistCreationUncertainResult
  | TopPlaylistCreatedIncompleteResult
  | null {
  if (error instanceof TopPlaylistCreationOutcomeUncertainError) {
    const cause = error.recoveryFailure ?? error.creationFailure;
    const deferred = asOperationDeadlineDeferredResult(cause, {
      deadline,
      operation: "Spotify playlist creation recovery",
    });
    const details = deferred?.details;
    return {
      ok: false,
      status: "partial",
      reason: "playlist_creation_outcome_uncertain",
      details: {
        phase: "playlist_creation",
        creationDispatched: true,
        playlistCreated: null,
        externalMutationMayHaveCompleted: true,
        playlistId: null,
        playlistUrl: null,
        replacementCompleted: false,
        freshnessPersisted: false,
        priorSnapshotPreserved: false,
        recovery: "automatic_discovery_incomplete",
        error:
          error.creationFailure instanceof Error
            ? error.creationFailure.message
            : String(error.creationFailure),
        recoveryError:
          error.recoveryFailure == null
            ? null
            : error.recoveryFailure instanceof Error
              ? error.recoveryFailure.message
              : String(error.recoveryFailure),
        deadline: details
          ? {
              cause: details.deadlineCause ?? "operation_deadline",
              operation: details.operation,
              requiredMs: details.requiredMs,
              remainingMs: details.remainingMs,
              expiresAtMs: details.expiresAtMs ?? null,
              retryAfterMs: details.retryAfterMs ?? null,
              safeExecutionBudgetMs:
                details.safeExecutionBudgetMs ?? null,
            }
          : null,
      },
    };
  }
  if (error instanceof TopPlaylistCreatedIncompleteError) {
    const cause = error.incompleteFailure;
    const deferred = asOperationDeadlineDeferredResult(cause, {
      deadline,
      operation:
        error.phase === "playlist_id_persistence"
          ? "Top-playlist creation finalization"
          : "Spotify playlist replacement",
    });
    const details = deferred?.details;
    const data = error.data as TopPlaylistResult;
    return {
      ok: false,
      status: "partial",
      reason: "created_playlist_incomplete",
      data,
      details: {
        phase: error.phase,
        creationCompleted: true,
        playlistId: data.playlistId,
        playlistUrl: data.playlistUrl,
        replacementCompleted: false,
        freshnessPersisted: false,
        priorSnapshotPreserved: false,
        recovery: "retry_or_reconcile_created_playlist",
        error: cause instanceof Error ? cause.message : String(cause),
        leaseKey:
          cause instanceof IntegrationSyncLeaseLostError
            ? cause.leaseKey
            : null,
        deadline: details
          ? {
              cause: details.deadlineCause ?? "operation_deadline",
              operation: details.operation,
              requiredMs: details.requiredMs,
              remainingMs: details.remainingMs,
              expiresAtMs: details.expiresAtMs ?? null,
              retryAfterMs: details.retryAfterMs ?? null,
              safeExecutionBudgetMs:
                details.safeExecutionBudgetMs ?? null,
            }
          : null,
      },
    };
  }
  if (error instanceof TopPlaylistExternalWriteUncertainError) {
    const cause = error.mutationFailure;
    const deferred = asOperationDeadlineDeferredResult(
      cause.mutationFailure,
      {
        deadline,
        operation: "Spotify playlist replacement",
      }
    );
    const details = deferred?.details;
    return {
      ok: false,
      status: "partial",
      reason: "external_write_outcome_uncertain",
      data: error.data as TopPlaylistResult,
      details: {
        phase: "external_write",
        externalWriteCompleted: null,
        externalWriteMayHaveCompleted: true,
        freshnessPersisted: false,
        priorSnapshotPreserved: false,
        verification: "not_attempted",
        error:
          cause.mutationFailure instanceof Error
            ? cause.mutationFailure.message
            : String(cause.mutationFailure),
        playlistId: cause.playlistId,
        deadline: details
          ? {
              cause: details.deadlineCause ?? "operation_deadline",
              operation: details.operation,
              requiredMs: details.requiredMs,
              remainingMs: details.remainingMs,
              expiresAtMs: details.expiresAtMs ?? null,
              retryAfterMs: details.retryAfterMs ?? null,
              safeExecutionBudgetMs:
                details.safeExecutionBudgetMs ?? null,
            }
          : null,
      },
    };
  }
  if (error instanceof TopPlaylistDescriptionUpdateUncertainError) {
    const cause = error.mutationFailure;
    const deferred = asOperationDeadlineDeferredResult(
      cause.mutationFailure,
      {
        deadline,
        operation: "Spotify playlist description update",
      }
    );
    const details = deferred?.details;
    return {
      ok: false,
      status: "partial",
      reason: "playlist_description_update_outcome_uncertain",
      data: error.data as TopPlaylistResult,
      details: {
        phase: "playlist_description_update",
        itemReplacementCompleted: true,
        descriptionUpdateCompleted: null,
        descriptionUpdateMayHaveCompleted: true,
        freshnessPersisted: false,
        priorSnapshotPreserved: false,
        verification: "not_attempted",
        error:
          cause.mutationFailure instanceof Error
            ? cause.mutationFailure.message
            : String(cause.mutationFailure),
        playlistId: cause.playlistId,
        deadline: details
          ? {
              cause: details.deadlineCause ?? "operation_deadline",
              operation: details.operation,
              requiredMs: details.requiredMs,
              remainingMs: details.remainingMs,
              expiresAtMs: details.expiresAtMs ?? null,
              retryAfterMs: details.retryAfterMs ?? null,
              safeExecutionBudgetMs:
                details.safeExecutionBudgetMs ?? null,
            }
          : null,
      },
    };
  }
  if (error instanceof TopPlaylistDescriptionUpdateFailedError) {
    const cause = error.descriptionFailure;
    const deferred = asOperationDeadlineDeferredResult(cause, {
      deadline,
      operation: "Spotify playlist description update",
    });
    const details = deferred?.details;
    return {
      ok: false,
      status: "partial",
      reason: "playlist_description_update_failed",
      data: error.data as TopPlaylistResult,
      details: {
        phase: "playlist_description_update",
        itemReplacementCompleted: true,
        descriptionUpdateCompleted: false,
        descriptionUpdateMayHaveCompleted: false,
        freshnessPersisted: false,
        priorSnapshotPreserved: false,
        error: cause instanceof Error ? cause.message : String(cause),
        providerStatus: cause instanceof SpotifyApiError ? cause.status : null,
        retryAfterMs:
          cause instanceof SpotifyApiError ? cause.retryAfterMs : null,
        deadline: details
          ? {
              cause: details.deadlineCause ?? "operation_deadline",
              operation: details.operation,
              requiredMs: details.requiredMs,
              remainingMs: details.remainingMs,
              expiresAtMs: details.expiresAtMs ?? null,
              retryAfterMs: details.retryAfterMs ?? null,
              safeExecutionBudgetMs:
                details.safeExecutionBudgetMs ?? null,
            }
          : null,
      },
    };
  }
  if (!(error instanceof TopPlaylistExternalWriteCompletedError)) return null;
  const cause = error.freshnessFailure;
  const deferred = asOperationDeadlineDeferredResult(cause, {
    deadline,
    operation: "Top-playlist freshness persistence",
  });
  const details = deferred?.details;
  return {
    ok: false,
    status: "partial",
    reason: "external_write_completed_freshness_not_persisted",
    data: error.data as TopPlaylistResult,
    details: {
      phase: "freshness_persistence",
      externalWriteCompleted: true,
      freshnessPersisted: false,
      priorSnapshotPreserved: false,
      error: cause instanceof Error ? cause.message : String(cause),
      leaseKey:
        cause instanceof IntegrationSyncLeaseLostError
          ? cause.leaseKey
          : null,
      deadline: details
        ? {
            cause: details.deadlineCause ?? "operation_deadline",
            operation: details.operation,
            requiredMs: details.requiredMs,
            remainingMs: details.remainingMs,
            expiresAtMs: details.expiresAtMs ?? null,
            retryAfterMs: details.retryAfterMs ?? null,
            safeExecutionBudgetMs:
              details.safeExecutionBudgetMs ?? null,
          }
        : null,
    },
  };
}

export function selectOwnedManagedPlaylist(
  playlists: readonly CurrentUserPlaylist[],
  currentUserId: string
): CurrentUserPlaylist | null {
  return (
    playlists
      .filter(
        (playlist) =>
          playlist.name === PLAYLIST_NAME &&
          isManagedPlaylistDescription(playlist.description) &&
          isSpotifyPlaylistOwnedByUser(playlist, currentUserId)
      )
      .sort((left, right) => left.id.localeCompare(right.id))[0] ?? null
  );
}

async function persistPlaylistId(
  tx: Prisma.TransactionClient,
  playlistId: string
): Promise<void> {
  await tx.setting.upsert({
    where: { key: PLAYLIST_ID_KEY },
    create: { key: PLAYLIST_ID_KEY, value: playlistId },
    update: { value: playlistId },
  });
}

type PlaylistCreationState =
  | { status: "idle" }
  | {
      status: "creating" | "uncertain";
      token: string;
      startedAt: string;
    };

type PlaylistCreationDecision =
  | { kind: "stored"; playlistId: string }
  | { kind: "wait"; state: Exclude<PlaylistCreationState, { status: "idle" }> }
  | { kind: "claim"; token: string };

function parseCreationState(value: string): PlaylistCreationState {
  try {
    const parsed = JSON.parse(value) as Partial<PlaylistCreationState>;
    if (parsed.status === "idle") return { status: "idle" };
    if (
      (parsed.status === "creating" || parsed.status === "uncertain") &&
      typeof parsed.token === "string" &&
      typeof parsed.startedAt === "string"
    ) {
      return {
        status: parsed.status,
        token: parsed.token,
        startedAt: parsed.startedAt,
      };
    }
  } catch {
    // Legacy lock values are treated as idle.
  }
  return { status: "idle" };
}

async function lockCreationState(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$queryRaw`
    SELECT "key"
    FROM "Setting"
    WHERE "key" = ${PLAYLIST_LOCK_KEY}
    FOR UPDATE
  `;
}

async function creationDecision(
  lease: IntegrationSyncLeaseGuard,
  deadline: OperationDeadline
): Promise<PlaylistCreationDecision> {
  return runDeadlineBoundTransaction(
    deadline,
    topPlaylistTransaction("Top-playlist creation decision"),
    async (tx) => {
      await lease.fenceTransaction(tx);
      await lockCreationState(tx);
      const [stored, stateSetting] = await Promise.all([
        tx.setting.findUnique({ where: { key: PLAYLIST_ID_KEY } }),
        tx.setting.findUnique({ where: { key: PLAYLIST_LOCK_KEY } }),
      ]);
      if (stored?.value) {
        return { kind: "stored", playlistId: stored.value };
      }

      const state = parseCreationState(stateSetting?.value ?? "");
      if (
        state.status !== "idle" &&
        Date.now() - Date.parse(state.startedAt) < PLAYLIST_CREATION_GRACE_MS
      ) {
        return { kind: "wait", state };
      }

      const token = randomUUID();
      await tx.setting.update({
        where: { key: PLAYLIST_LOCK_KEY },
        data: {
          value: JSON.stringify({
            status: "creating",
            token,
            startedAt: new Date().toISOString(),
          } satisfies PlaylistCreationState),
        },
      });
      return { kind: "claim", token };
    }
  );
}

async function finalizePlaylist(
  playlistId: string,
  lease: IntegrationSyncLeaseGuard,
  deadline: OperationDeadline
): Promise<void> {
  await runDeadlineBoundTransaction(
    deadline,
    TOP_PLAYLIST_CREATION_FINALIZATION_TRANSACTION,
    async (tx) => {
      await lease.fenceTransaction(tx);
      await lockCreationState(tx);
      await persistPlaylistId(tx, playlistId);
      await tx.setting.update({
        where: { key: PLAYLIST_LOCK_KEY },
        data: { value: JSON.stringify({ status: "idle" }) },
      });
    }
  );
}

async function clearMissingStoredPlaylist(
  playlistId: string,
  lease: IntegrationSyncLeaseGuard,
  deadline: OperationDeadline
): Promise<void> {
  await runDeadlineBoundTransaction(
    deadline,
    topPlaylistTransaction("Top-playlist missing-id cleanup"),
    async (tx) => {
      await lease.fenceTransaction(tx);
      await lockCreationState(tx);
      const current = await tx.setting.findUnique({
        where: { key: PLAYLIST_ID_KEY },
      });
      if (current?.value !== playlistId) return;
      await tx.setting.deleteMany({
        where: { key: PLAYLIST_ID_KEY, value: playlistId },
      });
      await tx.setting.update({
        where: { key: PLAYLIST_LOCK_KEY },
        data: { value: JSON.stringify({ status: "idle" }) },
      });
    }
  );
}

async function finishClaim(
  token: string,
  status: "idle" | "uncertain",
  lease: IntegrationSyncLeaseGuard,
  deadline: OperationDeadline
): Promise<void> {
  await runDeadlineBoundTransaction(
    deadline,
    topPlaylistTransaction("Top-playlist claim cleanup"),
    async (tx) => {
      await lease.fenceTransaction(tx);
      await lockCreationState(tx);
      const [stored, stateSetting] = await Promise.all([
        tx.setting.findUnique({ where: { key: PLAYLIST_ID_KEY } }),
        tx.setting.findUnique({ where: { key: PLAYLIST_LOCK_KEY } }),
      ]);
      if (stored?.value) return;
      const state = parseCreationState(stateSetting?.value ?? "");
      if (state.status === "idle" || state.token !== token) return;
      await tx.setting.update({
        where: { key: PLAYLIST_LOCK_KEY },
        data: {
          value: JSON.stringify(
            status === "idle"
              ? { status: "idle" }
              : {
                  status: "uncertain",
                  token,
                  startedAt: new Date().toISOString(),
                }
          ),
        },
      });
    }
  );
}

async function findOrCreateManagedPlaylist(
  token: string,
  currentUserId: string,
  description: string,
  lease: IntegrationSyncLeaseGuard,
  deadline: OperationDeadline
): Promise<{
  id: string;
  url: string;
  created: boolean;
}> {
  await runDeadlineBoundTransaction(
    deadline,
    topPlaylistTransaction("Top-playlist lock initialization"),
    async (tx) => {
      await lease.fenceTransaction(tx);
      await tx.setting.upsert({
        where: { key: PLAYLIST_LOCK_KEY },
        create: {
          key: PLAYLIST_LOCK_KEY,
          value: JSON.stringify({ status: "idle" }),
        },
        update: {},
      });
    }
  );

  while (true) {
    assertOperationTimeRemaining(
      deadline,
      PROVIDER_REQUEST_MIN_REMAINING_MS,
      "Top-playlist discovery"
    );
    const decision = await creationDecision(lease, deadline);
    if (decision.kind === "stored") {
      await lease.assertOwned();
      if (
        await playlistOwnedByUser(
          decision.playlistId,
          currentUserId,
          token,
          deadline
        )
      ) {
        return {
          id: decision.playlistId,
          url: `https://open.spotify.com/playlist/${decision.playlistId}`,
          created: false,
        };
      }
      await clearMissingStoredPlaylist(
        decision.playlistId,
        lease,
        deadline
      );
      continue;
    }

    if (decision.kind === "wait") {
      await lease.assertOwned();
      const existing = selectOwnedManagedPlaylist(
        await listAllCurrentUserPlaylists(token, deadline),
        currentUserId
      );
      if (existing) {
        await finalizePlaylist(existing.id, lease, deadline);
        return {
          id: existing.id,
          url:
            existing.external_urls?.spotify ??
            `https://open.spotify.com/playlist/${existing.id}`,
          created: false,
        };
      }
      throw new Error(
        `Top-playlist creation is ${decision.state.status}; retry after the recovery window`
      );
    }

    try {
      await lease.assertOwned();
      const existing = selectOwnedManagedPlaylist(
        await listAllCurrentUserPlaylists(token, deadline),
        currentUserId
      );
      if (existing) {
        await finalizePlaylist(existing.id, lease, deadline);
        return {
          id: existing.id,
          url:
            existing.external_urls?.spotify ??
            `https://open.spotify.com/playlist/${existing.id}`,
          created: false,
        };
      }

      assertOperationTimeRemaining(
        deadline,
        minimumTopPlaylistCreationRemainingMs(),
        "Top-playlist creation with downstream persistence"
      );
      await lease.assertOwned();
      const created = await runTopPlaylistCreationWithReservedDownstream(
        deadline,
        (creationDeadline) =>
          createPlaylist(
            PLAYLIST_NAME,
            description,
            false,
            token,
            creationDeadline
          ),
        (playlist, persistenceDeadline) =>
          finalizePlaylist(playlist.id, lease, persistenceDeadline)
      );
      return { id: created.id, url: created.url, created: true };
    } catch (creationError) {
      if (
        !(creationError instanceof TopPlaylistCreationOutcomeUncertainError) &&
        !(creationError instanceof TopPlaylistCreatedIncompleteError)
      ) {
        await finishClaim(decision.token, "idle", lease, deadline);
        throw creationError;
      }

      if (creationError instanceof TopPlaylistCreatedIncompleteError) {
        throw creationError;
      }

      let recoveryError: unknown = null;
      for (const delayMs of [1_000, 2_000, 4_000]) {
        try {
          const recoveryDeadline = operationDeadlineWithReservedTime(
            deadline,
            minimumTopPlaylistExternalWriteRemainingMs(),
            "Top-playlist creation recovery downstream reservation"
          );
          await sleepBeforeDeadline(
            recoveryDeadline,
            delayMs,
            "Spotify playlist creation recovery",
            PROVIDER_REQUEST_MIN_REMAINING_MS
          );
          await lease.assertOwned();
          const recovered = selectOwnedManagedPlaylist(
            await listAllCurrentUserPlaylists(token, recoveryDeadline),
            currentUserId
          );
          if (!recovered) continue;
          const recoveredPlaylist = {
            id: recovered.id,
            url:
              recovered.external_urls?.spotify ??
              `https://open.spotify.com/playlist/${recovered.id}`,
          };
          try {
            await finalizePlaylist(
              recovered.id,
              lease,
              recoveryDeadline
            );
          } catch (error) {
            throw new TopPlaylistCreatedIncompleteError(
              recoveredPlaylist,
              "playlist_id_persistence",
              error
            );
          }
          return {
            ...recoveredPlaylist,
            created: true,
          };
        } catch (error) {
          if (error instanceof TopPlaylistCreatedIncompleteError) {
            throw error;
          }
          recoveryError = error;
          if (error instanceof IntegrationSyncLeaseLostError) break;
        }
      }
      try {
        await finishClaim(decision.token, "uncertain", lease, deadline);
      } catch (error) {
        recoveryError ??= error;
      }
      throw new TopPlaylistCreationOutcomeUncertainError(
        creationError.creationFailure,
        recoveryError
      );
    }
  }
}

function uniqueSpotifyTrackId(ids: readonly string[] | undefined): string | null {
  const unique = Array.from(new Set((ids ?? []).filter(Boolean)));
  return unique.length === 1 ? unique[0] : null;
}

async function persistPlaylistFreshness(
  lease: IntegrationSyncLeaseGuard,
  refreshedAt: string,
  deadline: OperationDeadline
): Promise<void> {
  await runDeadlineBoundTransaction(
    deadline,
    TOP_PLAYLIST_FRESHNESS_TRANSACTION,
    async (tx) => {
      await lease.fenceTransaction(tx);
      await tx.setting.upsert({
        where: { key: PLAYLIST_LAST_SYNC_KEY },
        create: { key: PLAYLIST_LAST_SYNC_KEY, value: refreshedAt },
        update: { value: refreshedAt },
      });
    }
  );
}

export function asTopPlaylistLeaseStaleResult(
  error: unknown
): TopPlaylistLeaseStaleResult | null {
  if (!(error instanceof IntegrationSyncLeaseLostError)) return null;
  return {
    ok: false,
    status: "stale",
    reason: "lease_lost",
    leaseKey: error.leaseKey,
  };
}

async function refreshTopTracksPlaylistUnleased(
  limit: number,
  description: string,
  lease: IntegrationSyncLeaseGuard,
  deadline: OperationDeadline
): Promise<TopPlaylistResult> {
  assertOperationTimeRemaining(
    deadline,
    PROVIDER_REQUEST_MIN_REMAINING_MS,
    "Top-playlist snapshot acquisition"
  );
  await lease.assertOwned();
  const credential = await db.integrationCredential.findUnique({
    where: { provider: "statsfm" },
  });
  if (!credential?.meta) throw new Error("Stats.fm not connected");
  const { userId } = JSON.parse(credential.meta) as { userId?: unknown };
  if (typeof userId !== "string" || !userId) {
    throw new Error("Stats.fm credential is missing a user id");
  }

  assertOperationTimeRemaining(
    deadline,
    PROVIDER_REQUEST_MIN_REMAINING_MS,
    "Stats.fm top-track snapshot"
  );
  const items = await getTopTracks(userId, "weeks", limit, deadline);
  assertOperationTimeRemaining(
    deadline,
    PROVIDER_REQUEST_MIN_REMAINING_MS,
    "Spotify track matching"
  );
  await lease.assertOwned();
  const token = await getValidAccessToken(deadline);
  if (!token) throw new Error("Spotify not connected");
  const currentUserId = await getCurrentSpotifyUserId(token, deadline);
  const matches = await mapWithConcurrency(items, 4, async (item) => {
    const externalIds = item.track.externalIds?.spotify;
    const spotifyId = uniqueSpotifyTrackId(externalIds);
    if (spotifyId) return { uri: `spotify:track:${spotifyId}`, label: "" };
    if (externalIds && Array.from(new Set(externalIds)).length > 1) {
      return {
        uri: null,
        label: `${item.track.name} — ambiguous Spotify ids`,
      };
    }
    const artist = item.track.artists?.[0]?.name ?? "";
    const uri = await searchTrackUri(
      item.track.name,
      artist,
      token,
      deadline
    );
    return {
      uri,
      label: `${item.track.name}${artist ? ` — ${artist}` : ""}`,
    };
  });

  const uris: string[] = [];
  const unmatched: string[] = [];
  for (const match of matches) {
    if (match.uri) uris.push(match.uri);
    else unmatched.push(match.label);
  }
  const uniqueUris = Array.from(new Set(uris));
  let playlist: Awaited<ReturnType<typeof findOrCreateManagedPlaylist>>;
  try {
    playlist = await findOrCreateManagedPlaylist(
      token,
      currentUserId,
      description,
      lease,
      deadline
    );
  } catch (error) {
    if (error instanceof TopPlaylistCreatedIncompleteError) {
      const created = error.data as { id: string; url: string };
      throw new TopPlaylistCreatedIncompleteError(
        {
          sourceTracks: items.length,
          matchedUris: uniqueUris.length,
          unmatched,
          playlistId: created.id,
          playlistUrl: created.url,
          created: true,
        } satisfies TopPlaylistResult,
        error.phase,
        error.incompleteFailure
      );
    }
    throw error;
  }
  const result = {
    sourceTracks: items.length,
    matchedUris: uniqueUris.length,
    unmatched,
    playlistId: playlist.id,
    playlistUrl: playlist.url,
    created: playlist.created,
  };
  try {
    await lease.assertOwned();
    return await runTopPlaylistExternalWriteAndFreshness(
      deadline,
      async (replacementDeadline) => {
        return runTopPlaylistExternalWrites(
          result,
          () =>
            replacePlaylistItems(
              playlist.id,
              uniqueUris,
              token,
              replacementDeadline
            ),
          () =>
            updatePlaylistDescription(
              playlist.id,
              description,
              token,
              replacementDeadline
            )
        );
      },
      async () => {
        await persistPlaylistFreshness(
          lease,
          new Date().toISOString(),
          deadline
        );
      }
    );
  } catch (error) {
    if (
      playlist.created &&
      !(error instanceof TopPlaylistExternalWriteCompletedError) &&
      !(error instanceof TopPlaylistExternalWriteUncertainError) &&
      !(error instanceof TopPlaylistDescriptionUpdateFailedError) &&
      !(error instanceof TopPlaylistDescriptionUpdateUncertainError)
    ) {
      throw new TopPlaylistCreatedIncompleteError(
        result,
        "playlist_replacement",
        error
      );
    }
    throw error;
  }
}

export async function refreshTopTracksPlaylist(
  limit = 50,
  deadline: OperationDeadline = defaultTopPlaylistDeadline(),
  refreshedAt: Date = new Date()
): Promise<TopPlaylistExecutionResult> {
  const description = formatManagedPlaylistDescription(refreshedAt);
  try {
    return await withIntegrationSyncLease(
      SPOTIFY_SYNC_LEASE_KEY,
      (lease) =>
        refreshTopTracksPlaylistUnleased(
          limit,
          description,
          lease,
          deadline
        ),
      {
        deadline,
        minimumRemainingMs: minimumDeadlineTransactionRemainingMs(
          topPlaylistTransaction("Top-playlist transaction")
        ),
      }
    );
  } catch (error) {
    const partial = asTopPlaylistExternalWritePartialResult(error, deadline);
    if (partial) return partial;
    const stale = asTopPlaylistLeaseStaleResult(error);
    if (stale) return stale;
    const deferred = asOperationDeadlineDeferredResult(error, {
      deadline,
      operation: "Top-playlist refresh",
    });
    if (deferred) return deferred;
    throw error;
  }
}
