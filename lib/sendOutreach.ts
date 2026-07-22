import { randomUUID } from "node:crypto";
import { Prisma, type EmailTemplatePurpose } from "@prisma/client";
import { db } from "@/lib/db";
import {
  festivalLeadTimeError,
  festivalLeadTimeExclusion,
} from "@/lib/festivalEligibility";
import {
  applyTemplate,
  buildVarsForShow,
  ensureFollowUpTemplate,
  ensureOriginalTemplateForShow,
  normalizeLegacyRateTemplateHtml,
  normalizeLegacyOutreachSnapshot,
  normalizeLegacyRateTemplateVariable,
  originalTemplatePurposeForShow,
} from "@/lib/template";
import {
  appendEmailUtmToHtml,
  renderTrackedEmailHtml,
} from "@/lib/emailUtm";
import { readEmailUtmSettingsSnapshot } from "@/lib/generalSettings";
import {
  RESEND_CONFIGURATION_ERROR,
  buildResendDeliveryPolicy,
  canRetryResendRequest,
  compareResendRequestToPolicy,
  getResendConfigurationError,
  getResendCredentialScope,
  getResendDeliverySettingsSnapshot,
  getResendSubmissionCredential,
  hashAttachmentContent,
  hashResendRequestSnapshot,
  normalizeEmails,
  parseResendRequestSnapshot,
  prepareResendRequest,
  sendPreparedEmailViaResend,
  type ResendAttachmentBlob,
  type ResendDeliveryPolicy,
  type ResendFailureDisposition,
  type ResendPreparationDisposition,
  type ResendRequestSnapshot,
  type ResendSubmissionCredential,
} from "@/lib/resend";
import { acquireOutreachRecipientPolicyLocks } from "@/lib/outreachPolicyLocks";
import {
  customizeRecipientIdentity,
  customizeRecipientIdentityError,
  type CustomizeRecipientIdentity,
} from "@/lib/customizeRecipients";
import {
  CANCELLABLE_OUTREACH_STATUSES,
  isCancellableOutreachStatus,
} from "@/lib/outreachStatus";
import {
  isStaleOutreachClaim,
  OUTREACH_CLAIM_TIMEOUT_MS,
  OUTREACH_PROVIDER_TRANSACTION_TIMEOUT_MS,
} from "@/lib/schedule";
import {
  requireActionableTrajectoryRecommendation,
  requireActionableTrajectoryRecommendationInTransaction,
  trajectoryActionTargetMismatch,
  type TrajectoryActionContext,
} from "@/lib/trajectoryActiveRun";
import { trajectoryActionErrorMessage } from "@/lib/trajectoryActionError";

export { OUTREACH_PROVIDER_TRANSACTION_TIMEOUT_MS } from "@/lib/schedule";

export interface SendOutreachInput {
  showId: string;
  contactId: string;
  subjectOverride?: string;
  htmlOverride?: string;
  singleRecipient?: boolean;
  expectedRecipientIdentity?: CustomizeRecipientIdentity;
  trajectoryContext?: TrajectoryActionContext;
}

export type OutreachKindValue = "original" | "follow_up";

export interface SendOutreachOutput {
  ok: boolean;
  outreachId?: string;
  error?: string;
  trajectoryError?: boolean;
  scheduled?: boolean;
  scheduledFor?: Date;
  skipped?: boolean;
  retryScheduled?: boolean;
  nextAttemptAt?: Date;
  warnings?: string[];
  rateCardAttachmentOmitted?: boolean;
}

export interface FollowUpParentOutreachProof {
  id: string;
  kind: OutreachKindValue;
  parentOutreachId: string | null;
  idempotencyKey: string;
  providerMessageId: string | null;
}

export interface FollowUpParentAttemptProof {
  outreachId: string;
  status: string;
  idempotencyKey: string;
  testSend: boolean | null;
  providerMessageId: string | null;
  acceptedAt: Date | null;
}

export function isConclusiveRealOutreachAcceptance(
  outreach: Pick<
    FollowUpParentOutreachProof,
    "id" | "idempotencyKey" | "providerMessageId"
  >,
  attempt: FollowUpParentAttemptProof | null | undefined,
): boolean {
  return (
    !!attempt &&
    attempt.outreachId === outreach.id &&
    attempt.idempotencyKey === outreach.idempotencyKey &&
    attempt.testSend === false &&
    outreach.providerMessageId !== null &&
    attempt.providerMessageId !== null &&
    outreach.providerMessageId === attempt.providerMessageId &&
    attempt.acceptedAt !== null &&
    ["accepted", "delivery_failed"].includes(attempt.status)
  );
}

export function followUpParentBlockingReason(
  parent: FollowUpParentOutreachProof | null | undefined,
  attempt: FollowUpParentAttemptProof | null | undefined,
): string | null {
  if (!parent) return "Original outreach not found";
  if (parent.kind !== "original" || parent.parentOutreachId !== null) {
    return "Follow-ups can only be sent from an original outreach";
  }
  if (!attempt) {
    return "Original outreach has no matching immutable provider attempt";
  }
  if (
    attempt.outreachId !== parent.id ||
    attempt.idempotencyKey !== parent.idempotencyKey
  ) {
    return "Original outreach current provider attempt does not match";
  }
  if (attempt.testSend !== false) {
    return attempt.testSend === true
      ? "Test sends do not qualify for follow-up"
      : "Original outreach has no verified real/test classification";
  }
  if (
    !parent.providerMessageId ||
    !attempt.providerMessageId ||
    parent.providerMessageId !== attempt.providerMessageId
  ) {
    return "Original outreach has no matching provider acceptance";
  }
  if (!attempt.acceptedAt) {
    return "Original outreach provider acceptance is not conclusive";
  }
  if (!["accepted", "delivery_failed"].includes(attempt.status)) {
    return "Original outreach provider attempt is not conclusively accepted";
  }
  if (!isConclusiveRealOutreachAcceptance(parent, attempt)) {
    return "Original outreach provider acceptance is not conclusive";
  }
  return null;
}

export interface FollowUpEligibility {
  parentOutreachId: string;
  eligible: boolean;
  state: "eligible" | "pending" | "sent" | "blocked";
  mode: "new" | "retry" | null;
  reason: string | null;
  recipients: string[];
  fullTeamSend: boolean;
  followUpOutreachId?: string;
  followUpStatus?: string;
  nextAttemptAt?: Date;
}

interface PreparedOutreach {
  kind: OutreachKindValue;
  parentOutreachId: string | null;
  trajectoryRecommendationId: string | null;
  trajectoryContext: TrajectoryActionContext | null;
  showId: string;
  artistId: string;
  contactId: string;
  templateId: string;
  templatePurpose: EmailTemplatePurpose;
  recipients: string[];
  fullTeamSend: boolean;
  subject: string;
  html: string;
  expectedRecipientIdentity: CustomizeRecipientIdentity | null;
}

export function resolveTrajectoryRecommendationAttribution(
  explicitRecommendationId: string | null,
  inheritedRecommendationId: string | null,
  existingRecommendationId: string | null = null,
): string | null {
  return (
    explicitRecommendationId ??
    existingRecommendationId ??
    inheritedRecommendationId
  );
}

function trajectoryAttributionData(
  outreach: Pick<
    PreparedOutreach,
    "trajectoryRecommendationId" | "trajectoryContext"
  >,
  existingRecommendationId: string | null = null,
): { trajectoryRecommendationId?: string } {
  const recommendationId = resolveTrajectoryRecommendationAttribution(
    outreach.trajectoryContext?.recommendationId ?? null,
    outreach.trajectoryRecommendationId,
    existingRecommendationId,
  );
  return recommendationId
    ? { trajectoryRecommendationId: recommendationId }
    : {};
}

interface StoredExpectedRecipientIdentity {
  expectedRecipientContactId: string | null;
  expectedRecipientArtistId: string | null;
  expectedRecipientEmail: string | null;
  expectedRecipientUpdatedAt: Date | null;
}

function expectedRecipientIdentityData(
  identity: CustomizeRecipientIdentity | null,
): StoredExpectedRecipientIdentity {
  return {
    expectedRecipientContactId: identity?.contactId ?? null,
    expectedRecipientArtistId: identity?.artistId ?? null,
    expectedRecipientEmail: identity?.normalizedEmail ?? null,
    expectedRecipientUpdatedAt: identity
      ? new Date(identity.updatedAt)
      : null,
  };
}

function storedExpectedRecipientIdentity(
  row: StoredExpectedRecipientIdentity,
): CustomizeRecipientIdentity | null {
  const values = [
    row.expectedRecipientContactId,
    row.expectedRecipientArtistId,
    row.expectedRecipientEmail,
    row.expectedRecipientUpdatedAt,
  ];
  if (values.every((value) => value === null)) return null;
  if (values.some((value) => value === null)) {
    throw new Error("Stored Customize recipient identity is incomplete");
  }
  return {
    contactId: row.expectedRecipientContactId!,
    artistId: row.expectedRecipientArtistId!,
    normalizedEmail: row.expectedRecipientEmail!,
    updatedAt: row.expectedRecipientUpdatedAt!.toISOString(),
  };
}

function sameExpectedRecipientIdentity(
  row: StoredExpectedRecipientIdentity,
  identity: CustomizeRecipientIdentity | null,
): boolean {
  const stored = storedExpectedRecipientIdentity(row);
  if (!stored || !identity) return stored === identity;
  return (
    stored.contactId === identity.contactId &&
    stored.artistId === identity.artistId &&
    stored.normalizedEmail === identity.normalizedEmail &&
    stored.updatedAt === identity.updatedAt
  );
}

interface StoredAttempt {
  id: string;
  outreachId: string;
  status: string;
  idempotencyKey: string;
  providerRequest: Prisma.JsonValue | null;
  requestHash: string | null;
  testSend: boolean | null;
  providerCredentialScope: string | null;
  providerMessageId: string | null;
  firstAttemptAt: Date | null;
  lastAttemptAt: Date | null;
  attemptCount: number;
  failureDisposition: string | null;
  nextAttemptAt: Date | null;
  acceptedAt: Date | null;
  error: string | null;
  bouncedAt: Date | null;
  complainedAt: Date | null;
}

export interface OutreachAttemptRecoveryState {
  status: string;
  error: string | null;
  failureDisposition: string | null;
  nextAttemptAt: Date | null;
  lastAttemptAt: Date | null;
  attemptCount: number;
}

export interface OutreachClaimRecoveryState {
  status: string;
  error: string | null;
  scheduledFor: Date | null;
  nextAttemptAt: Date | null;
  lastAttemptAt: Date | null;
  attemptCount: number;
}

interface ClaimedOutreach {
  id: string;
  kind: OutreachKindValue;
  parentOutreachId: string | null;
  showId: string;
  artistId: string;
  contactId: string | null;
  claimToken: string;
  finalSubject: string;
  finalHtml: string;
  recipientEmails: string[];
  recipientSnapshotState: string;
  fullTeamSend: boolean;
  idempotencyKey: string;
  providerMessageId: string | null;
  sentAt: Date | null;
  attemptCount: number;
  attempt: StoredAttempt | null;
  automaticRetry: boolean;
  preparationRetryCount: number;
  claimRecovery: OutreachClaimRecoveryState;
  expectedRecipientIdentity: CustomizeRecipientIdentity | null;
  contact: {
    id: string;
    artistId: string;
    email: string | null;
    state: "active" | "quarantined";
    isFullTeam: boolean;
  } | null;
}

type CompletedResult = { kind: "complete"; result: SendOutreachOutput };

type ClaimResult =
  | { kind: "claimed"; outreach: ClaimedOutreach }
  | CompletedResult;

type AttemptResult =
  | {
      kind: "ready";
      outreach: ClaimedOutreach;
      attempt: StoredAttempt;
      warnings: string[];
      rateCardAttachmentOmitted: boolean;
    }
  | CompletedResult;

type SendingClaimResult =
  | {
      kind: "ready";
      attempt: StoredAttempt;
      configurationRecovery: OutreachAttemptRecoveryState;
    }
  | CompletedResult;

type StartedAttempt =
  | {
      kind: "ready";
      request: NonNullable<ReturnType<typeof parseResendRequestSnapshot>>;
      requestHash: string;
      testSend: boolean;
      attachmentBlobs: ResendAttachmentBlob[];
      result: Awaited<ReturnType<typeof sendPreparedEmailViaResend>>;
    }
  | CompletedResult;

const MANUAL_REVIEW_EXPIRED =
  "Resend idempotency retention expired; do not retry this immutable request without manual review";
const MANUAL_REVIEW_LEGACY =
  "Provider attempt has no immutable request snapshot; review manually before sending again";
const MANUAL_REVIEW_UNCERTAIN =
  "Provider acceptance is uncertain; review the provider state before sending again";
const MANUAL_REVIEW_IN_FLIGHT =
  "Resend reports this idempotency key is still processing; reconcile provider or webhook state before replacing the immutable request";
const MANUAL_REVIEW_IN_FLIGHT_EXPIRED =
  "Resend idempotency retention expired while provider acceptance remained unresolved; reconcile provider or webhook state before replacing the immutable request";
const MANUAL_REVIEW_SNAPSHOT =
  "Current active contact membership, recipient addresses, or suppressions conflict with the verified outreach snapshot; review manually";
const MANUAL_REVIEW_LEGACY_RATE_SNAPSHOT =
  "Scheduled outreach contains legacy rate/custom-price content that could not be normalized safely; review manually before sending";
const MANUAL_REVIEW_LEGACY_RATE_ATTEMPT =
  "Immutable provider request contains legacy rate/custom-price content; review manually and do not resend this request";
const MANUAL_REVIEW_CREDENTIAL_SCOPE_MISSING =
  "Provider attempt has no provable Resend credential scope; reconcile provider or webhook state before retrying";
const MANUAL_REVIEW_CREDENTIAL_SCOPE_CHANGED =
  "Resend credential scope changed; do not retry this immutable request in a different provider idempotency namespace";
const TERMINAL_PERMANENT_FAILURE =
  "The immutable provider request failed permanently and cannot be retried";
export const LEGACY_AMBIGUOUS_BOUNCE_QUARANTINE_ERROR =
  "Legacy failed bounce may have been a test send; provider events are quarantined and real outreach may replace it";
export const DEFINITIVELY_UNSENT_CANCELLATION_ERROR =
  "Cancelled only after the provider request was proven unsent";

export const OUTREACH_MAX_SEND_ATTEMPTS = 5;
export const OUTREACH_RETRY_BASE_DELAY_MS = 60 * 1000;
export const OUTREACH_RETRY_MAX_DELAY_MS = 30 * 60 * 1000;

export type LegacyScheduledSnapshotProtection =
  | { kind: "unchanged" }
  | { kind: "normalize"; subject: string; html: string }
  | { kind: "block"; error: string };

export interface LegacyScheduledSnapshotProtectionInput {
  status: string;
  finalSubject: string;
  finalHtml: string;
  trustedTemplate?: {
    templateId: string;
    subject: string;
    html: string;
  } | null;
  immutableRequest?: { subject: string; html: string } | null;
}

export function schedulingTimeTemplateProvenance(
  outreachCreatedAt: Date,
  template: {
    id: string;
    subject: string;
    htmlBody: string;
    updatedAt: Date;
  } | null,
): { templateId: string; subject: string; html: string } | null {
  // Template contents are only scheduling-time evidence if the row has not
  // changed since this immutable outreach snapshot was created.
  if (!template || template.updatedAt >= outreachCreatedAt) return null;
  return {
    templateId: template.id,
    subject: template.subject,
    html: template.htmlBody,
  };
}

export function protectLegacyScheduledSnapshot(
  input: LegacyScheduledSnapshotProtectionInput,
): LegacyScheduledSnapshotProtection {
  if (
    input.status !== "scheduled" &&
    input.status !== "retry_scheduled" &&
    input.status !== "queued"
  ) {
    return { kind: "unchanged" };
  }

  const snapshot = normalizeLegacyOutreachSnapshot({
    subject: input.finalSubject,
    html: input.finalHtml,
    trustedTemplateSubject: input.trustedTemplate?.subject,
    trustedTemplateHtml: input.trustedTemplate?.html,
  });

  if (input.immutableRequest) {
    const request = normalizeLegacyOutreachSnapshot({
      subject: input.immutableRequest.subject,
      html: input.immutableRequest.html,
      trustedTemplateSubject: input.trustedTemplate?.subject,
      trustedTemplateHtml: input.trustedTemplate?.html,
    });
    return snapshot.outcome !== "safe_unchanged" ||
      request.outcome !== "safe_unchanged"
      ? { kind: "block", error: MANUAL_REVIEW_LEGACY_RATE_ATTEMPT }
      : { kind: "unchanged" };
  }

  if (snapshot.outcome === "safe_unchanged") return { kind: "unchanged" };
  if (snapshot.outcome === "requires_manual_review") {
    return { kind: "block", error: MANUAL_REVIEW_LEGACY_RATE_SNAPSHOT };
  }
  return {
    kind: "normalize",
    subject: snapshot.subject,
    html: snapshot.html,
  };
}

export function getOutreachRetryDelayMs(completedAttempts: number): number {
  const exponent = Math.max(0, completedAttempts - 1);
  return Math.min(
    OUTREACH_RETRY_BASE_DELAY_MS * 2 ** exponent,
    OUTREACH_RETRY_MAX_DELAY_MS,
  );
}

export function activeContactRecipientEmails(
  contacts: readonly {
    email: string | null;
    directOutreachNote?: string | null;
    state: "active" | "quarantined";
  }[],
): string[] {
  return normalizeEmails(
    contacts.flatMap((contact) =>
      contact.state === "active" && contact.email ? [contact.email] : [],
    ),
  );
}

export function getOutreachConfigurationRetryAt(
  completedAttempts: number,
  now: Date = new Date(),
): Date {
  return new Date(
    now.getTime() + getOutreachRetryDelayMs(Math.max(1, completedAttempts)),
  );
}

export type OutreachConfigurationOutageState =
  | {
      status: "retry_scheduled";
      error: string;
      nextAttemptAt: Date;
      retryScheduled: true;
    }
  | {
      status: "failed";
      error: string;
      nextAttemptAt: null;
      retryScheduled: false;
    };

export function getOutreachConfigurationOutageState(
  automaticRetry: boolean,
  completedAttempts: number,
  error: string,
  now: Date = new Date(),
): OutreachConfigurationOutageState {
  const visibleError = `configuration_unavailable: ${error}`;
  if (!automaticRetry) {
    return {
      status: "failed",
      error: visibleError,
      nextAttemptAt: null,
      retryScheduled: false,
    };
  }
  return {
    status: "retry_scheduled",
    error: visibleError,
    nextAttemptAt: getOutreachConfigurationRetryAt(completedAttempts, now),
    retryScheduled: true,
  };
}

export function getOutreachConfigurationAttemptRecoveryData(
  prior: OutreachAttemptRecoveryState,
) {
  return {
    status: prior.status,
    error: prior.error,
    failureDisposition: prior.failureDisposition,
    nextAttemptAt: prior.nextAttemptAt,
    lastAttemptAt: prior.lastAttemptAt,
    attemptCount: prior.attemptCount,
  };
}

export function getOutreachClaimRecoveryData(
  prior: OutreachClaimRecoveryState,
) {
  return {
    status: prior.status,
    error: prior.error,
    scheduledFor: prior.scheduledFor,
    nextAttemptAt: prior.nextAttemptAt,
    lastAttemptAt: prior.lastAttemptAt,
    attemptCount: prior.attemptCount,
    claimedAt: null,
    claimToken: null,
  };
}

function attemptRecoveryState(
  attempt: StoredAttempt,
): OutreachAttemptRecoveryState {
  return {
    status: attempt.status,
    error: attempt.error,
    failureDisposition: attempt.failureDisposition,
    nextAttemptAt: attempt.nextAttemptAt,
    lastAttemptAt: attempt.lastAttemptAt,
    attemptCount: attempt.attemptCount,
  };
}

function outreachClaimRecoveryState(outreach: {
  status: string;
  error: string | null;
  scheduledFor: Date | null;
  nextAttemptAt: Date | null;
  lastAttemptAt: Date | null;
  attemptCount: number;
}): OutreachClaimRecoveryState {
  return {
    status: outreach.status,
    error: outreach.error,
    scheduledFor: outreach.scheduledFor,
    nextAttemptAt: outreach.nextAttemptAt,
    lastAttemptAt: outreach.lastAttemptAt,
    attemptCount: outreach.attemptCount,
  };
}

function freshImmediateClaimRecoveryState(): OutreachClaimRecoveryState {
  return {
    status: "failed",
    error: null,
    scheduledFor: null,
    nextAttemptAt: null,
    lastAttemptAt: null,
    attemptCount: 0,
  };
}

export function isOutreachConfigurationOutageError(
  error: string | null,
): boolean {
  return error?.startsWith("configuration_unavailable:") ?? false;
}

export function canRecoverConfigurationOutageWithoutAttempt(outreach: {
  status: string;
  error: string | null;
  attemptCount: number;
  providerMessageId: string | null;
}): boolean {
  return (
    outreach.status === "retry_scheduled" &&
    isOutreachConfigurationOutageError(outreach.error) &&
    outreach.attemptCount === 0 &&
    outreach.providerMessageId === null
  );
}

const RETRYABLE_PREPARATION_ERROR_PREFIX = "preparation_retryable:";

export type OutreachPreparationFailureState =
  | {
      status: "retry_scheduled";
      storedError: string;
      nextAttemptAt: Date;
      retryScheduled: true;
      retryCount: number;
    }
  | {
      status: "failed";
      storedError: string;
      nextAttemptAt: null;
      retryScheduled: false;
      retryCount: number;
    };

export function getOutreachPreparationFailureState(
  automaticRetry: boolean,
  previousRetryCount: number,
  disposition: ResendPreparationDisposition,
  error: string,
  now: Date = new Date(),
): OutreachPreparationFailureState {
  const retryCount = Math.max(0, previousRetryCount) + 1;
  if (automaticRetry && disposition === "retryable") {
    return {
      status: "retry_scheduled",
      storedError: `${RETRYABLE_PREPARATION_ERROR_PREFIX}${retryCount}: ${error}`,
      nextAttemptAt: new Date(
        now.getTime() + getOutreachRetryDelayMs(retryCount),
      ),
      retryScheduled: true,
      retryCount,
    };
  }
  return {
    status: "failed",
    storedError: `preparation_failed: ${error}`,
    nextAttemptAt: null,
    retryScheduled: false,
    retryCount,
  };
}

export function getOutreachPreparationRetryCount(
  error: string | null,
): number | null {
  const match = error?.match(/^preparation_retryable:(\d+): /);
  if (!match) return null;
  const count = Number(match[1]);
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}

export function canRecoverPreparationFailureWithoutAttempt(outreach: {
  status: string;
  error: string | null;
  attemptCount: number;
  providerMessageId: string | null;
}): boolean {
  return (
    outreach.status === "retry_scheduled" &&
    getOutreachPreparationRetryCount(outreach.error) !== null &&
    outreach.attemptCount === 0 &&
    outreach.providerMessageId === null
  );
}

export function hasProtectedCurrentSendState(
  outreach: {
    attemptCount: number;
    providerMessageId: string | null;
  },
  hasCurrentAttempt: boolean,
): boolean {
  return (
    hasCurrentAttempt ||
    outreach.attemptCount > 0 ||
    outreach.providerMessageId !== null
  );
}

export function canReplaceUnattemptedOutreachSnapshot(
  outreach: {
    attemptCount: number;
    providerMessageId: string | null;
    recipientSnapshotState: string;
  },
  hasCurrentAttempt: boolean,
): boolean {
  return (
    outreach.recipientSnapshotState === "verified" &&
    !hasProtectedCurrentSendState(outreach, hasCurrentAttempt)
  );
}

export function isNonBlockingLegacyUnknownAttempt(
  attempt:
    | (Pick<
        StoredAttempt,
        | "status"
        | "providerRequest"
        | "requestHash"
        | "providerMessageId"
        | "attemptCount"
        | "bouncedAt"
        | "complainedAt"
      > &
        Partial<Pick<StoredAttempt, "error" | "testSend">>)
    | null
    | undefined,
): boolean {
  if (
    attempt?.status === "legacy_unknown" &&
    attempt.providerRequest === null &&
    attempt.requestHash === null
  ) {
    return (
      (attempt.providerMessageId === null &&
        attempt.attemptCount === 0 &&
        attempt.bouncedAt === null &&
        attempt.complainedAt === null) ||
      (attempt.error === LEGACY_AMBIGUOUS_BOUNCE_QUARANTINE_ERROR &&
        attempt.testSend == null &&
        attempt.complainedAt === null)
    );
  }
  return false;
}

function hasProviderSubmissionMarker(
  attempt: Pick<
    StoredAttempt,
    "status" | "firstAttemptAt" | "attemptCount" | "failureDisposition"
  >,
): boolean {
  return (
    attempt.firstAttemptAt !== null ||
    attempt.attemptCount > 0 ||
    attempt.status === "sending" ||
    attempt.failureDisposition === "in_flight" ||
    attempt.failureDisposition === "uncertain"
  );
}

export function isProviderAcceptanceUnresolvedAttempt(
  attempt: Pick<
    StoredAttempt,
    | "status"
    | "providerMessageId"
    | "providerCredentialScope"
    | "firstAttemptAt"
    | "attemptCount"
    | "failureDisposition"
  >,
): boolean {
  if (attempt.providerMessageId) return false;
  if (
    attempt.status === "sending" ||
    attempt.failureDisposition === "in_flight" ||
    attempt.failureDisposition === "uncertain"
  ) {
    return true;
  }
  return (
    attempt.providerCredentialScope === null &&
    hasProviderSubmissionMarker(attempt) &&
    attempt.failureDisposition !== "configuration"
  );
}

export function getResendCredentialScopeConflict(
  attempt: Pick<
    StoredAttempt,
    | "status"
    | "providerCredentialScope"
    | "firstAttemptAt"
    | "attemptCount"
    | "failureDisposition"
  >,
  currentCredentialScope: string | null | undefined,
): string | null {
  if (!attempt.providerCredentialScope) {
    return hasProviderSubmissionMarker(attempt)
      ? MANUAL_REVIEW_CREDENTIAL_SCOPE_MISSING
      : null;
  }
  if (
    currentCredentialScope &&
    attempt.providerCredentialScope !== currentCredentialScope
  ) {
    return attempt.failureDisposition === "in_flight"
      ? `${MANUAL_REVIEW_IN_FLIGHT}: ${MANUAL_REVIEW_CREDENTIAL_SCOPE_CHANGED}`
      : MANUAL_REVIEW_CREDENTIAL_SCOPE_CHANGED;
  }
  return null;
}

export function isDefinitivelyUnsentOutreachAttempt(
  attempt: Pick<
    StoredAttempt,
    | "status"
    | "providerCredentialScope"
    | "providerMessageId"
    | "firstAttemptAt"
    | "attemptCount"
    | "failureDisposition"
  >,
): boolean {
  if (attempt.providerMessageId) return false;
  if (attempt.status === "prepared") {
    return attempt.firstAttemptAt === null && attempt.attemptCount === 0;
  }
  if (
    hasProviderSubmissionMarker(attempt) &&
    attempt.providerCredentialScope === null &&
    attempt.failureDisposition !== "configuration"
  ) {
    return false;
  }
  if (attempt.status === "request_failed") {
    return ["configuration", "retryable", "permanent", "policy"].includes(
      attempt.failureDisposition ?? "",
    );
  }
  return (
    attempt.status === "cancelled" &&
    ["configuration", "retryable", "permanent", "policy"].includes(
      attempt.failureDisposition ?? "",
    )
  );
}

export function isDefinitiveConfigurationRejection(
  attempt:
    | Pick<
        StoredAttempt,
        | "status"
        | "providerMessageId"
        | "firstAttemptAt"
        | "attemptCount"
        | "failureDisposition"
      >
    | null
    | undefined,
): boolean {
  return (
    !!attempt &&
    attempt.providerMessageId === null &&
    attempt.firstAttemptAt !== null &&
    attempt.attemptCount > 0 &&
    attempt.failureDisposition === "configuration" &&
    ["request_failed", "manual_review", "cancelled"].includes(attempt.status)
  );
}

type AttemptRetryDecision =
  | { ok: true }
  | { ok: false; state: "manual_review" | "failed"; error: string };

export function evaluateAttemptRetryEligibility(
  attempt: Pick<
    StoredAttempt,
    | "status"
    | "providerMessageId"
    | "providerRequest"
    | "requestHash"
    | "providerCredentialScope"
    | "firstAttemptAt"
    | "attemptCount"
    | "failureDisposition"
    | "error"
  >,
  now: Date = new Date(),
  currentCredentialScope?: string | null,
): AttemptRetryDecision {
  if (attempt.providerMessageId) {
    return {
      ok: false,
      state: "manual_review",
      error:
        "Resend already accepted this provider request; review delivery before sending again",
    };
  }
  if (!attempt.providerRequest || !attempt.requestHash) {
    return { ok: false, state: "manual_review", error: MANUAL_REVIEW_LEGACY };
  }
  const credentialScopeConflict = getResendCredentialScopeConflict(
    attempt,
    currentCredentialScope,
  );
  if (credentialScopeConflict) {
    return {
      ok: false,
      state: "manual_review",
      error: credentialScopeConflict,
    };
  }
  if (attempt.status === "sending") {
    return { ok: false, state: "manual_review", error: MANUAL_REVIEW_UNCERTAIN };
  }
  if (attempt.status === "manual_review" || attempt.status === "legacy_unknown") {
    return {
      ok: false,
      state: "manual_review",
      error: attempt.error ?? MANUAL_REVIEW_UNCERTAIN,
    };
  }
  if (attempt.status === "accepted" || attempt.status === "delivery_failed") {
    return {
      ok: false,
      state: "manual_review",
      error:
        attempt.error ??
        "Resend accepted this immutable request; review delivery before sending again",
    };
  }
  if (attempt.status === "prepared") {
    if (attempt.attemptCount !== 0) {
      return {
        ok: false,
        state: "manual_review",
        error: MANUAL_REVIEW_UNCERTAIN,
      };
    }
    return canRetryResendRequest(attempt.firstAttemptAt, now)
      ? { ok: true }
      : { ok: false, state: "manual_review", error: MANUAL_REVIEW_EXPIRED };
  }
  if (attempt.status !== "request_failed") {
    return {
      ok: false,
      state: "manual_review",
      error: `Immutable provider attempt is in unsupported state ${attempt.status}`,
    };
  }
  if (attempt.failureDisposition === "uncertain") {
    return { ok: false, state: "manual_review", error: MANUAL_REVIEW_UNCERTAIN };
  }
  if (attempt.failureDisposition === "in_flight") {
    if (attempt.attemptCount >= OUTREACH_MAX_SEND_ATTEMPTS) {
      return {
        ok: false,
        state: "manual_review",
        error: `${MANUAL_REVIEW_IN_FLIGHT}: automatic retry attempt cap reached (${OUTREACH_MAX_SEND_ATTEMPTS})`,
      };
    }
    if (!canRetryResendRequest(attempt.firstAttemptAt, now)) {
      return {
        ok: false,
        state: "manual_review",
        error: MANUAL_REVIEW_IN_FLIGHT_EXPIRED,
      };
    }
    return { ok: true };
  }
  if (attempt.failureDisposition === "configuration") {
    return { ok: true };
  }
  if (attempt.failureDisposition === "policy") {
    return {
      ok: false,
      state: "manual_review",
      error: attempt.error ?? "Stored provider request violates safety policy",
    };
  }
  if (attempt.failureDisposition === "permanent") {
    return {
      ok: false,
      state: "failed",
      error: attempt.error ?? TERMINAL_PERMANENT_FAILURE,
    };
  }
  if (attempt.failureDisposition !== "retryable") {
    return { ok: false, state: "manual_review", error: MANUAL_REVIEW_UNCERTAIN };
  }
  if (attempt.attemptCount >= OUTREACH_MAX_SEND_ATTEMPTS) {
    return {
      ok: false,
      state: "failed",
      error:
        attempt.error ??
        `Automatic retry attempt cap reached (${OUTREACH_MAX_SEND_ATTEMPTS})`,
    };
  }
  if (!canRetryResendRequest(attempt.firstAttemptAt, now)) {
    return { ok: false, state: "manual_review", error: MANUAL_REVIEW_EXPIRED };
  }
  return { ok: true };
}

function sameEmails(left: string[], right: string[]): boolean {
  const normalizedLeft = normalizeEmails(left);
  const normalizedRight = normalizeEmails(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((email, index) => email === normalizedRight[index])
  );
}

export function recipientSnapshotConflict(
  stored: {
    recipientEmails: string[];
    recipientSnapshotState: string;
    fullTeamSend: boolean;
  },
  currentRecipients: string[],
  currentFullTeamSend: boolean,
): string | null {
  if (stored.recipientSnapshotState !== "verified") {
    return "Outreach recipient snapshot is unverified";
  }
  if (
    stored.fullTeamSend !== currentFullTeamSend ||
    !sameEmails(stored.recipientEmails, currentRecipients)
  ) {
    return MANUAL_REVIEW_SNAPSHOT;
  }
  return null;
}

export interface DeliveryPolicyContact {
  id: string;
  artistId: string;
  email: string | null;
  state: "active" | "quarantined";
  isFullTeam: boolean;
}

export interface DeliveryPolicySnapshot {
  id: string;
  idempotencyKey: string;
  recipientEmails: string[];
  recipientSnapshotState: string;
  fullTeamSend: boolean;
  finalHtml: string;
}

export interface DeliveryPolicyAttempt {
  id: string;
  idempotencyKey: string;
  providerRequest: Prisma.JsonValue | null;
  requestHash: string | null;
  testSend: boolean | null;
}

export interface EvaluateOutreachDeliveryPolicyInput {
  showSyncStatus: string | null;
  associationExists: boolean;
  artistId: string;
  contactId: string | null;
  subject: string;
  contact: DeliveryPolicyContact | null;
  artistContacts: readonly DeliveryPolicyContact[];
  stored: DeliveryPolicySnapshot | null;
  attempt: DeliveryPolicyAttempt | null;
  from: string | undefined;
  testOverride: string | null;
  bccEmails: string[];
  suppressedEmails: readonly string[];
  configurationError?: string | null;
  allowMissingFrom?: boolean;
  requestedFullTeamSend?: boolean;
}

export type OutreachDeliveryPolicyDecision =
  | {
      ok: true;
      currentRecipients: string[];
      fullTeamSend: boolean;
      policy: ResendDeliveryPolicy;
      request: ResendRequestSnapshot | null;
    }
  | {
      ok: false;
      state: "cancelled" | "manual_review" | "configuration";
      error: string;
    };

function deliveryPolicyConfigurationError(error: string): boolean {
  return (
    error === "Missing RESEND_FROM_EMAIL" ||
    error.startsWith("Invalid RESEND_FROM_EMAIL;") ||
    error === "Test override email is invalid" ||
    error === "Test override email is suppressed"
  );
}

export function evaluateOutreachDeliveryPolicy({
  showSyncStatus,
  associationExists,
  artistId,
  contactId,
  subject,
  contact,
  artistContacts,
  stored,
  attempt,
  from,
  testOverride,
  bccEmails,
  suppressedEmails,
  configurationError = null,
  allowMissingFrom = false,
  requestedFullTeamSend,
}: EvaluateOutreachDeliveryPolicyInput): OutreachDeliveryPolicyDecision {
  if (showSyncStatus === null) {
    return { ok: false, state: "cancelled", error: "Show not found" };
  }
  if (showSyncStatus !== "active") {
    return {
      ok: false,
      state: "cancelled",
      error: showInactiveError(showSyncStatus),
    };
  }
  if (!associationExists) {
    return {
      ok: false,
      state: "cancelled",
      error: artistNotOnShowError(),
    };
  }
  if (!contactId || !contact || contact.id !== contactId) {
    return {
      ok: false,
      state: "cancelled",
      error: "Selected contact is no longer available",
    };
  }
  if (contact.state !== "active") {
    return {
      ok: false,
      state: "cancelled",
      error: "Selected contact is quarantined",
    };
  }
  if (contact.artistId !== artistId) {
    return {
      ok: false,
      state: "cancelled",
      error: "Selected contact no longer belongs to the outreach artist",
    };
  }
  if (!normalizeEmails(contact.email ? [contact.email] : []).length) {
    return {
      ok: false,
      state: "cancelled",
      error: "Selected contact has no valid active recipient address",
    };
  }

  const fullTeamSend =
    stored?.fullTeamSend ?? requestedFullTeamSend ?? contact.isFullTeam;
  if (fullTeamSend && !contact.isFullTeam) {
    return {
      ok: false,
      state: stored ? "manual_review" : "cancelled",
      error: stored
        ? "Current full-team contact marker conflicts with the verified outreach snapshot"
        : "Selected contact is not eligible for full-team outreach",
    };
  }

  const intendedRecipients = fullTeamSend
    ? activeContactRecipientEmails(artistContacts)
    : activeContactRecipientEmails([contact]);
  if (intendedRecipients.length === 0) {
    return {
      ok: false,
      state: "cancelled",
      error: "Selected contact has no valid active recipient addresses",
    };
  }

  const parsedRequest = attempt
    ? parseResendRequestSnapshot(attempt.providerRequest)
    : null;
  const resolved = buildResendDeliveryPolicy({
    from: from ?? (configurationError ? parsedRequest?.from : undefined),
    intendedRecipients,
    subject,
    testOverride,
    bccEmails,
    suppressedEmails,
    allowMissingFrom: allowMissingFrom || !!configurationError,
  });
  if (!resolved.ok) {
    return {
      ok: false,
      state: deliveryPolicyConfigurationError(resolved.error)
        ? "configuration"
        : "cancelled",
      error: resolved.error,
    };
  }

  if (stored) {
    const snapshotConflict = recipientSnapshotConflict(
      stored,
      resolved.policy.intendedRecipients,
      fullTeamSend,
    );
    if (snapshotConflict) {
      return {
        ok: false,
        state: "manual_review",
        error: snapshotConflict,
      };
    }
  }

  let request: ResendRequestSnapshot | null = null;
  if (attempt) {
    if (!stored) {
      return {
        ok: false,
        state: "manual_review",
        error: "Immutable provider attempt has no outreach snapshot",
      };
    }
    request = parsedRequest;
    if (
      !request ||
      !attempt.requestHash ||
      hashResendRequestSnapshot(request) !== attempt.requestHash ||
      !requestIdentityMatches(stored, attempt, request)
    ) {
      return {
        ok: false,
        state: "manual_review",
        error: "Stored Resend request failed its identity or integrity check",
      };
    }
    if (request.html !== stored.finalHtml) {
      return {
        ok: false,
        state: "manual_review",
        error: "Stored Resend request body conflicts with the outreach snapshot",
      };
    }
    if (attempt.testSend === null) {
      return {
        ok: false,
        state: "manual_review",
        error:
          "Legacy provider attempt has no verified real/test classification",
      };
    }
    const policyConflict = compareResendRequestToPolicy(
      request,
      attempt.testSend,
      resolved.policy,
    );
    if (policyConflict) {
      return {
        ok: false,
        state: "manual_review",
        error: `Current send policy conflicts with the immutable request: ${policyConflict}`,
      };
    }
  }

  if (configurationError) {
    return {
      ok: false,
      state: "configuration",
      error: configurationError,
    };
  }

  return {
    ok: true,
    currentRecipients: resolved.policy.intendedRecipients,
    fullTeamSend,
    policy: resolved.policy,
    request,
  };
}

function showInactiveError(syncStatus: string): string {
  return `Show is not active (${syncStatus})`;
}

export function festivalOutreachBlockingReason(
  show:
    | {
        isFestival: boolean;
        dismissedAt: Date | null;
        date: Date;
        festivalNycStatus: string | null;
    }
    | null
    | undefined,
  kind: OutreachKindValue,
  now: Date = new Date(),
): string | null {
  if (!show?.isFestival) return null;
  const leadTimeExclusion = festivalLeadTimeExclusion(show, now);
  if (leadTimeExclusion) return festivalLeadTimeError(leadTimeExclusion);
  if (show.dismissedAt === null) return null;
  return kind === "follow_up"
    ? "Restore this festival before sending follow-up"
    : "Restore this festival before sending outreach";
}

function artistNotOnShowError(): string {
  return "The selected contact's artist is not on this show";
}

function newAttemptIdentity(outreachId: string): {
  attemptId: string;
  idempotencyKey: string;
} {
  const attemptId = randomUUID();
  return {
    attemptId,
    idempotencyKey: `outreach/${outreachId}/${attemptId}`,
  };
}

function attemptIdFromKey(outreachId: string, idempotencyKey: string): string | null {
  const prefix = `outreach/${outreachId}/`;
  if (!idempotencyKey.startsWith(prefix)) return null;
  const attemptId = idempotencyKey.slice(prefix.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    attemptId,
  )
    ? attemptId
    : null;
}

function resetDeliveryState() {
  return {
    providerMessageId: null,
    sentAt: null,
    deliveredAt: null,
    firstOpenedAt: null,
    lastOpenedAt: null,
    openCount: 0,
    firstClickedAt: null,
    lastClickedAt: null,
    clickCount: 0,
    bouncedAt: null,
    complainedAt: null,
  };
}

export function getAcceptedDeliveryFailureOutreachState(
  testSend: boolean,
  error: string,
  providerMessageId: string,
  sentAt: Date,
) {
  return {
    status: testSend ? "test" : "failed",
    error: testSend ? null : error,
    providerMessageId,
    sentAt,
    scheduledFor: null,
    nextAttemptAt: null,
    claimedAt: null,
    claimToken: null,
  };
}

async function withSerializableRetry<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await db.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (isRetryableOutreachTransactionError(error) && attempt < 3) continue;
      throw error;
    }
  }
  throw new Error("Unable to complete outreach transaction");
}

function isRetryableOutreachTransactionError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  return (
    error.code === "P2034" ||
    error.code === "P2002" ||
    error.code === "P2028"
  );
}

export interface OutreachSendabilityInput {
  showId: string;
  contactId: string;
  singleRecipient?: boolean;
}

export interface OutreachSendability {
  showId: string;
  contactId: string;
  artistId: string | null;
  sendable: boolean;
  mode: "new" | "retry" | null;
  reason: string | null;
  recipients: string[];
  fullTeamSend: boolean;
  blockingOutreachId?: string;
  blockingStatus?: string;
  blockingNextAttemptAt?: Date;
}

function requestIdentityMatches(
  outreach: { id: string; idempotencyKey: string },
  attempt: { id: string; idempotencyKey: string },
  request: NonNullable<ReturnType<typeof parseResendRequestSnapshot>>,
): boolean {
  const tags = new Map(request.tags.map((tag) => [tag.name, tag.value]));
  return (
    request.idempotencyKey === attempt.idempotencyKey &&
    attempt.idempotencyKey === outreach.idempotencyKey &&
    request.headers["X-Outreach-Id"] === outreach.id &&
    request.headers["X-Outreach-Attempt-Id"] === attempt.id &&
    tags.get("outreach_id") === outreach.id &&
    tags.get("outreach_attempt_id") === attempt.id
  );
}

interface LockedPolicyOutreach extends DeliveryPolicySnapshot {
  kind: OutreachKindValue;
  parentOutreachId: string | null;
  showId: string;
  artistId: string;
  contactId: string | null;
  finalSubject: string;
  expectedRecipientIdentity?: CustomizeRecipientIdentity | null;
}

interface LockedOutreachDeliveryPolicy {
  decision: OutreachDeliveryPolicyDecision;
  submissionCredential: ResendSubmissionCredential | null;
}

async function evaluateLockedOutreachDeliveryPolicy(
  tx: Prisma.TransactionClient,
  outreach: LockedPolicyOutreach,
  attempt: StoredAttempt,
): Promise<LockedOutreachDeliveryPolicy> {
  if (outreach.kind === "follow_up") {
    await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`
        SELECT "id"
        FROM "Outreach"
        WHERE "id" = ${outreach.parentOutreachId}
        FOR UPDATE
      `,
    );
    const followUpBlocked = await preparedFollowUpBlockingReason(
      tx,
      outreach,
    );
    if (followUpBlocked) {
      return {
        decision: {
          ok: false,
          state: "cancelled",
          error: followUpBlocked,
        },
        submissionCredential: null,
      };
    }
  }
  const [show] = await tx.$queryRaw<
    Array<{
      syncStatus: string;
      isFestival: boolean;
      dismissedAt: Date | null;
      date: Date;
      festivalNycStatus: string | null;
    }>
  >(
    Prisma.sql`
      SELECT
        show."syncStatus",
        show."isFestival",
        show."dismissedAt",
        show."date",
        show."festivalNycStatus"
      FROM "Show" show
      WHERE show."id" = ${outreach.showId}
      FOR UPDATE OF show
    `,
  );
  const festivalBlocked = festivalOutreachBlockingReason(show, outreach.kind);
  if (festivalBlocked) {
    return {
      decision: {
        ok: false,
        state: "cancelled",
        error: festivalBlocked,
      },
      submissionCredential: null,
    };
  }
  await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`
      SELECT "id"
      FROM "Artist"
      WHERE "id" = ${outreach.artistId}
      FOR UPDATE
    `,
  );
  const association = await tx.$queryRaw<Array<{ showId: string }>>(
    Prisma.sql`
      SELECT "showId"
      FROM "ShowArtist"
      WHERE "showId" = ${outreach.showId}
        AND "artistId" = ${outreach.artistId}
      FOR UPDATE
    `,
  );
  const artistContacts = await tx.$queryRaw<
    Array<DeliveryPolicyContact & { updatedAt: Date }>
  >(
    Prisma.sql`
      SELECT
        "id",
        "artistId",
        "email",
        "state",
        "isFullTeam",
        "updatedAt"
      FROM "Contact"
      WHERE "artistId" = ${outreach.artistId}
      ORDER BY "id"
      FOR UPDATE
    `,
  );
  const contact =
    artistContacts.find((candidate) => candidate.id === outreach.contactId) ??
    null;

  const deliverySettings = await getResendDeliverySettingsSnapshot(tx);
  const { testOverride, bccEmails } = deliverySettings;
  const intendedRecipients =
    outreach.fullTeamSend
      ? activeContactRecipientEmails(artistContacts)
      : contact
        ? activeContactRecipientEmails([contact])
        : [];
  const storedRequest = parseResendRequestSnapshot(attempt.providerRequest);
  const policyEmails = normalizeEmails([
    ...intendedRecipients,
    ...(outreach.expectedRecipientIdentity
      ? [outreach.expectedRecipientIdentity.normalizedEmail]
      : []),
    ...bccEmails,
    ...(testOverride ? [testOverride] : []),
    ...(storedRequest?.to ?? []),
    ...(storedRequest?.cc ?? []),
    ...(storedRequest?.bcc ?? []),
    ...(storedRequest?.replyTo ?? []),
  ]);
  await acquireOutreachRecipientPolicyLocks(tx, policyEmails);
  const identityError = outreach.expectedRecipientIdentity
    ? customizeRecipientIdentityError(
        contact,
        outreach.expectedRecipientIdentity,
      )
    : null;
  if (identityError) {
    return {
      decision: {
        ok: false,
        state: "manual_review",
        error: identityError,
      },
      submissionCredential: null,
    };
  }
  const suppressions =
    policyEmails.length === 0
      ? []
      : await tx.emailSuppression.findMany({
          where: { normalizedEmail: { in: policyEmails } },
          select: { normalizedEmail: true },
        });

  return {
    decision: evaluateOutreachDeliveryPolicy({
      showSyncStatus: show?.syncStatus ?? null,
      associationExists: association.length === 1,
      artistId: outreach.artistId,
      contactId: outreach.contactId,
      subject: outreach.finalSubject,
      contact,
      artistContacts,
      stored: outreach,
      attempt,
      from: deliverySettings.from,
      testOverride,
      bccEmails,
      suppressedEmails: suppressions.map(
        (suppression) => suppression.normalizedEmail,
      ),
      configurationError: getResendConfigurationError(
        deliverySettings.apiKey,
        deliverySettings.from,
      ),
    }),
    submissionCredential: getResendSubmissionCredential(
      deliverySettings.apiKey,
    ),
  };
}

function blockedSendability(
  input: OutreachSendabilityInput,
  reason: string,
  details: {
    artistId?: string | null;
    recipients?: string[];
    fullTeamSend?: boolean;
    outreachId?: string;
    status?: string;
    nextAttemptAt?: Date | null;
  } = {},
): OutreachSendability {
  return {
    ...input,
    artistId: details.artistId ?? null,
    sendable: false,
    mode: null,
    reason,
    recipients: details.recipients ?? [],
    fullTeamSend: details.fullTeamSend ?? false,
    ...(details.outreachId ? { blockingOutreachId: details.outreachId } : {}),
    ...(details.status ? { blockingStatus: details.status } : {}),
    ...(details.nextAttemptAt
      ? { blockingNextAttemptAt: details.nextAttemptAt }
      : {}),
  };
}

export async function getOutreachSendabilityBatch(
  inputs: readonly OutreachSendabilityInput[],
  now: Date = new Date(),
): Promise<OutreachSendability[]> {
  if (inputs.length === 0) return [];

  const showIds = Array.from(new Set(inputs.map((input) => input.showId)));
  const contactIds = Array.from(new Set(inputs.map((input) => input.contactId)));
  const [shows, targetContacts, deliverySettings] = await Promise.all([
    db.show.findMany({
      where: { id: { in: showIds } },
      select: {
        id: true,
        syncStatus: true,
        isFestival: true,
        date: true,
        festivalNycStatus: true,
        dismissedAt: true,
        artists: { select: { artistId: true } },
      },
    }),
    db.contact.findMany({
      where: { id: { in: contactIds } },
      select: {
        id: true,
        artistId: true,
        email: true,
        state: true,
        isFullTeam: true,
      },
    }),
    getResendDeliverySettingsSnapshot(),
  ]);
  const { testOverride, bccEmails } = deliverySettings;
  const showById = new Map(shows.map((show) => [show.id, show]));
  const targetById = new Map(
    targetContacts.map((contact) => [contact.id, contact]),
  );
  const artistIds = Array.from(
    new Set(targetContacts.map((contact) => contact.artistId)),
  );
  const allArtistContacts =
    artistIds.length === 0
      ? []
      : await db.contact.findMany({
          where: { artistId: { in: artistIds } },
          select: {
            id: true,
            artistId: true,
            email: true,
            state: true,
            isFullTeam: true,
          },
        });
  const contactsByArtist = new Map<string, DeliveryPolicyContact[]>();
  for (const contact of allArtistContacts) {
    const contacts = contactsByArtist.get(contact.artistId) ?? [];
    contacts.push(contact);
    contactsByArtist.set(contact.artistId, contacts);
  }
  const emailsByArtist = new Map<string, string[]>();
  for (const [artistId, contacts] of contactsByArtist) {
    emailsByArtist.set(artistId, activeContactRecipientEmails(contacts));
  }
  const suppressionCandidates = normalizeEmails([
    ...inputs.flatMap((input) => {
      const contact = targetById.get(input.contactId);
      if (!contact) return [];
      return !input.singleRecipient && contact.isFullTeam
        ? emailsByArtist.get(contact.artistId) ?? []
        : contact.state === "active" && contact.email
          ? [contact.email]
          : [];
    }),
    ...bccEmails,
    ...(testOverride ? [testOverride] : []),
  ]);
  const suppressions =
    suppressionCandidates.length === 0
      ? []
      : await db.emailSuppression.findMany({
          where: { normalizedEmail: { in: suppressionCandidates } },
          select: { normalizedEmail: true },
        });
  const suppressedEmails = suppressions.map((row) => row.normalizedEmail);

  const relevantOutreaches =
    showIds.length === 0 || artistIds.length === 0
      ? []
      : await db.outreach.findMany({
          where: {
            kind: "original",
            showId: { in: showIds },
            artistId: { in: artistIds },
            status: {
              in: [
                "sent",
                "scheduled",
                "retry_scheduled",
                "queued",
                "failed",
                "manual_review",
              ],
            },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
  const attempts =
    relevantOutreaches.length === 0
      ? []
      : await db.outreachSendAttempt.findMany({
          where: {
            outreachId: { in: relevantOutreaches.map((row) => row.id) },
          },
        });
  const attemptByKey = new Map(
    attempts.map((attempt) => [attempt.idempotencyKey, attempt]),
  );
  const outreachesByTarget = new Map<string, typeof relevantOutreaches>();
  for (const outreach of relevantOutreaches) {
    const key = `${outreach.showId}\u0000${outreach.artistId}`;
    const rows = outreachesByTarget.get(key) ?? [];
    rows.push(outreach);
    outreachesByTarget.set(key, rows);
  }

  return inputs.map((input) => {
    const show = showById.get(input.showId);
    if (!show) return blockedSendability(input, "Show not found");
    if (show.syncStatus !== "active") {
      return blockedSendability(input, showInactiveError(show.syncStatus));
    }
    const festivalBlocked = festivalOutreachBlockingReason(show, "original");
    if (festivalBlocked) {
      return blockedSendability(input, festivalBlocked);
    }

    const contact = targetById.get(input.contactId);
    if (!contact) return blockedSendability(input, "Contact not found");
    const artistContacts = contactsByArtist.get(contact.artistId) ?? [];
    const initialPolicy = evaluateOutreachDeliveryPolicy({
      showSyncStatus: show.syncStatus,
      associationExists: show.artists.some(
        (artist) => artist.artistId === contact.artistId,
      ),
      artistId: contact.artistId,
      contactId: contact.id,
      subject: "",
      contact,
      artistContacts,
      stored: null,
      attempt: null,
      from: deliverySettings.from,
      testOverride,
      bccEmails,
      suppressedEmails,
      allowMissingFrom: true,
      requestedFullTeamSend: input.singleRecipient ? false : undefined,
    });
    if (!initialPolicy.ok) {
      return blockedSendability(input, initialPolicy.error, {
        artistId: contact.artistId,
        fullTeamSend: contact.isFullTeam,
      });
    }
    const recipients = initialPolicy.currentRecipients;
    const rows =
      outreachesByTarget.get(`${input.showId}\u0000${contact.artistId}`) ?? [];
    const details = {
      artistId: contact.artistId,
      recipients,
      fullTeamSend: initialPolicy.fullTeamSend,
    };

    const sent = rows.find((row) => row.status === "sent");
    if (sent) {
      return blockedSendability(input, "Already sent for this artist on this show", {
        ...details,
        outreachId: sent.id,
        status: sent.status,
      });
    }
    const scheduled = rows.find((row) => row.status === "scheduled");
    if (scheduled) {
      return blockedSendability(
        input,
        "Already scheduled for this artist on this show",
        {
          ...details,
          outreachId: scheduled.id,
          status: scheduled.status,
          nextAttemptAt: scheduled.nextAttemptAt ?? scheduled.scheduledFor,
        },
      );
    }
    const retryScheduled = rows.find(
      (row) => row.status === "retry_scheduled",
    );
    if (retryScheduled) {
      const retryAttempt = attemptByKey.get(retryScheduled.idempotencyKey);
      if (retryAttempt) {
        const retryDecision = evaluateAttemptRetryEligibility(
          retryAttempt,
          now,
          deliverySettings.credentialScope,
        );
        if (!retryDecision.ok) {
          return blockedSendability(input, retryDecision.error, {
            ...details,
            outreachId: retryScheduled.id,
            status: retryScheduled.status,
          });
        }
        const retryContact =
          artistContacts.find(
            (candidate) => candidate.id === retryScheduled.contactId,
          ) ?? null;
        const retryPolicy = evaluateOutreachDeliveryPolicy({
          showSyncStatus: show.syncStatus,
          associationExists: true,
          artistId: retryScheduled.artistId,
          contactId: retryScheduled.contactId,
          subject: retryScheduled.finalSubject,
          contact: retryContact,
          artistContacts,
          stored: retryScheduled,
          attempt: retryAttempt,
          from: deliverySettings.from,
          testOverride,
          bccEmails,
          suppressedEmails,
          configurationError: getResendConfigurationError(
            deliverySettings.apiKey,
            deliverySettings.from,
          ),
        });
        if (!retryPolicy.ok) {
          return blockedSendability(input, retryPolicy.error, {
            ...details,
            outreachId: retryScheduled.id,
            status: retryScheduled.status,
          });
        }
      }
      return blockedSendability(input, "Automatic retry is already scheduled", {
        ...details,
        outreachId: retryScheduled.id,
        status: retryScheduled.status,
        nextAttemptAt: retryScheduled.nextAttemptAt,
      });
    }
    const manualReview = rows.find(
      (row) =>
        row.status === "manual_review" &&
        !isNonBlockingLegacyUnknownAttempt(
          attemptByKey.get(row.idempotencyKey),
        ) &&
        !isDefinitiveConfigurationRejection(
          attemptByKey.get(row.idempotencyKey),
        ),
    );
    if (manualReview) {
      return blockedSendability(
        input,
        manualReview.error ?? "A previous send requires manual review",
        {
          ...details,
          outreachId: manualReview.id,
          status: manualReview.status,
        },
      );
    }

    const failedForAnotherContact = rows.find(
      (row) =>
        row.status === "failed" &&
        row.contactId !== contact.id &&
        !isNonBlockingLegacyUnknownAttempt(
          attemptByKey.get(row.idempotencyKey),
        ) &&
        !isDefinitiveConfigurationRejection(
          attemptByKey.get(row.idempotencyKey),
        ) &&
        hasProtectedCurrentSendState(
          row,
          attemptByKey.has(row.idempotencyKey),
        ),
    );
    if (failedForAnotherContact) {
      return blockedSendability(
        input,
        "A previous failed send for this artist must be recovered with its original recipient snapshot",
        {
          ...details,
          outreachId: failedForAnotherContact.id,
          status: failedForAnotherContact.status,
        },
      );
    }

    const candidate =
      rows.find((row) => row.status === "queued") ??
      rows.find(
        (row) => row.status === "failed" && row.contactId === contact.id,
      ) ??
      rows.find(
        (row) =>
          row.status === "manual_review" &&
          row.contactId === contact.id &&
          (isNonBlockingLegacyUnknownAttempt(
            attemptByKey.get(row.idempotencyKey),
          ) ||
            isDefinitiveConfigurationRejection(
              attemptByKey.get(row.idempotencyKey),
            )),
      );
    if (!candidate) {
      return {
        ...input,
        ...details,
        sendable: true,
        mode: "new",
        reason: null,
      };
    }
    if (
      candidate.status === "queued" &&
      !isStaleOutreachClaim(candidate.claimedAt, now)
    ) {
      return blockedSendability(input, "Send already in progress", {
        ...details,
        outreachId: candidate.id,
        status: candidate.status,
      });
    }
    if (
      candidate.status === "queued" &&
      candidate.contactId !== contact.id
    ) {
      return blockedSendability(
        input,
        "A previous queued send must be recovered with its original contact",
        {
          ...details,
          outreachId: candidate.id,
          status: candidate.status,
        },
      );
    }

    const attempt = attemptByKey.get(candidate.idempotencyKey);
    if (isDefinitiveConfigurationRejection(attempt)) {
      return {
        ...input,
        ...details,
        sendable: true,
        mode: "new",
        reason: null,
      };
    }
    if (isNonBlockingLegacyUnknownAttempt(attempt)) {
      return {
        ...input,
        ...details,
        sendable: true,
        mode: "new",
        reason: null,
      };
    }
    if (!attempt) {
      if (!canReplaceUnattemptedOutreachSnapshot(candidate, false)) {
        return blockedSendability(input, MANUAL_REVIEW_LEGACY, {
          ...details,
          outreachId: candidate.id,
          status: candidate.status,
        });
      }
      return {
        ...input,
        ...details,
        sendable: true,
        mode: "new",
        reason: null,
      };
    }

    const retryDecision = evaluateAttemptRetryEligibility(
      attempt,
      now,
      deliverySettings.credentialScope,
    );
    if (!retryDecision.ok) {
      return blockedSendability(input, retryDecision.error, {
        ...details,
        outreachId: candidate.id,
        status: candidate.status,
      });
    }
    const currentPolicy = evaluateOutreachDeliveryPolicy({
      showSyncStatus: show.syncStatus,
      associationExists: true,
      artistId: candidate.artistId,
      contactId: candidate.contactId,
      subject: candidate.finalSubject,
      contact,
      artistContacts,
      stored: candidate,
      attempt,
      from: deliverySettings.from,
      testOverride,
      bccEmails,
      suppressedEmails,
    });
    if (!currentPolicy.ok) {
      return blockedSendability(input, currentPolicy.error, {
        ...details,
        outreachId: candidate.id,
        status: candidate.status,
      });
    }
    return {
      ...input,
      ...details,
      recipients: currentPolicy.currentRecipients,
      fullTeamSend: currentPolicy.fullTeamSend,
      sendable: true,
      mode: "retry",
      reason: null,
      blockingOutreachId: candidate.id,
      blockingStatus: candidate.status,
    };
  });
}

function followUpResult(
  parentOutreachId: string,
  state: FollowUpEligibility["state"],
  reason: string | null,
  details: {
    mode?: FollowUpEligibility["mode"];
    followUpOutreachId?: string;
    followUpStatus?: string;
    nextAttemptAt?: Date | null;
    recipients?: string[];
    fullTeamSend?: boolean;
  } = {},
): FollowUpEligibility {
  return {
    parentOutreachId,
    eligible: state === "eligible",
    state,
    mode: state === "eligible" ? (details.mode ?? "new") : null,
    reason,
    recipients: details.recipients ?? [],
    fullTeamSend: details.fullTeamSend ?? false,
    ...(details.followUpOutreachId
      ? { followUpOutreachId: details.followUpOutreachId }
      : {}),
    ...(details.followUpStatus
      ? { followUpStatus: details.followUpStatus }
      : {}),
    ...(details.nextAttemptAt
      ? { nextAttemptAt: details.nextAttemptAt }
      : {}),
  };
}

export async function getFollowUpEligibilityBatch(
  parentOutreachIds: readonly string[],
  now: Date = new Date(),
): Promise<FollowUpEligibility[]> {
  if (parentOutreachIds.length === 0) return [];
  const ids = Array.from(new Set(parentOutreachIds));
  const [parents, deliverySettings] = await Promise.all([
    db.outreach.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        kind: true,
        parentOutreachId: true,
        idempotencyKey: true,
        providerMessageId: true,
        showId: true,
        artistId: true,
        contactId: true,
        followUp: {
          select: {
            id: true,
            kind: true,
            parentOutreachId: true,
            idempotencyKey: true,
            providerMessageId: true,
            showId: true,
            artistId: true,
            contactId: true,
            finalSubject: true,
            finalHtml: true,
            recipientEmails: true,
            recipientSnapshotState: true,
            fullTeamSend: true,
            status: true,
            error: true,
            scheduledFor: true,
            nextAttemptAt: true,
            claimedAt: true,
            attemptCount: true,
          },
        },
      },
    }),
    getResendDeliverySettingsSnapshot(),
  ]);
  const parentById = new Map(parents.map((parent) => [parent.id, parent]));
  const allOutreaches = parents.flatMap((parent) =>
    parent.followUp ? [parent, parent.followUp] : [parent],
  );
  const attempts =
    allOutreaches.length === 0
      ? []
      : await db.outreachSendAttempt.findMany({
          where: {
            idempotencyKey: {
              in: allOutreaches.map((outreach) => outreach.idempotencyKey),
            },
          },
        });
  const attemptByKey = new Map(
    attempts.map((attempt) => [attempt.idempotencyKey, attempt]),
  );
  const artistIds = Array.from(
    new Set(parents.map((parent) => parent.artistId)),
  );
  const showIds = Array.from(new Set(parents.map((parent) => parent.showId)));
  const [shows, contacts] = await Promise.all([
    db.show.findMany({
      where: { id: { in: showIds } },
      select: {
        id: true,
        syncStatus: true,
        isFestival: true,
        date: true,
        festivalNycStatus: true,
        dismissedAt: true,
        artists: { select: { artistId: true } },
      },
    }),
    db.contact.findMany({
      where: { artistId: { in: artistIds } },
      select: {
        id: true,
        artistId: true,
        email: true,
        state: true,
        isFullTeam: true,
      },
    }),
  ]);
  const showById = new Map(shows.map((show) => [show.id, show]));
  const contactsByArtist = new Map<string, DeliveryPolicyContact[]>();
  for (const contact of contacts) {
    const rows = contactsByArtist.get(contact.artistId) ?? [];
    rows.push(contact);
    contactsByArtist.set(contact.artistId, rows);
  }
  const suppressionCandidates = normalizeEmails([
    ...contacts.flatMap((contact) =>
      contact.state === "active" && contact.email ? [contact.email] : [],
    ),
    ...deliverySettings.bccEmails,
    ...(deliverySettings.testOverride
      ? [deliverySettings.testOverride]
      : []),
  ]);
  const suppressions =
    suppressionCandidates.length === 0
      ? []
      : await db.emailSuppression.findMany({
          where: { normalizedEmail: { in: suppressionCandidates } },
          select: { normalizedEmail: true },
        });
  const suppressedEmails = suppressions.map(
    (suppression) => suppression.normalizedEmail,
  );

  return parentOutreachIds.map((parentOutreachId) => {
    const parent = parentById.get(parentOutreachId);
    const parentAttempt = parent
      ? attemptByKey.get(parent.idempotencyKey)
      : null;
    const parentBlocked = followUpParentBlockingReason(parent, parentAttempt);
    if (parentBlocked) {
      return followUpResult(parentOutreachId, "blocked", parentBlocked);
    }
    if (!parent) {
      return followUpResult(
        parentOutreachId,
        "blocked",
        "Original outreach not found",
      );
    }

    const child = parent.followUp;
    const childAttempt = child
      ? attemptByKey.get(child.idempotencyKey)
      : null;
    if (
      child &&
      (child.kind !== "follow_up" ||
        child.parentOutreachId !== parent.id ||
        child.showId !== parent.showId ||
        child.artistId !== parent.artistId ||
        child.contactId !== parent.contactId)
    ) {
      return followUpResult(
        parent.id,
        "blocked",
        "Stored follow-up identity conflicts with its original outreach",
        {
          followUpOutreachId: child.id,
          followUpStatus: child.status,
        },
      );
    }
    if (
      child &&
      isConclusiveRealOutreachAcceptance(child, childAttempt)
    ) {
      return followUpResult(parent.id, "sent", "Follow-up already sent", {
        followUpOutreachId: child.id,
        followUpStatus: child.status,
      });
    }
    if (child?.status === "sent") {
      return followUpResult(
        parent.id,
        "blocked",
        "Follow-up is marked sent without conclusive current provider proof",
        {
          followUpOutreachId: child.id,
          followUpStatus: child.status,
        },
      );
    }
    if (
      child &&
      (child.status === "scheduled" ||
        child.status === "retry_scheduled" ||
        (child.status === "queued" &&
          !isStaleOutreachClaim(child.claimedAt, now)))
    ) {
      return followUpResult(
        parent.id,
        "pending",
        child.status === "queued"
          ? "Follow-up send is in progress"
          : child.status === "retry_scheduled"
            ? "Follow-up retry is scheduled"
            : "Follow-up is scheduled",
        {
          followUpOutreachId: child.id,
          followUpStatus: child.status,
          nextAttemptAt: child.nextAttemptAt ?? child.scheduledFor,
        },
      );
    }

    let mode: FollowUpEligibility["mode"] = "new";
    if (child) {
      if (
        childAttempt &&
        childAttempt.providerMessageId &&
        childAttempt.testSend !== true
      ) {
        return followUpResult(
          parent.id,
          "blocked",
          "Follow-up provider acceptance requires review",
          {
            followUpOutreachId: child.id,
            followUpStatus: child.status,
          },
        );
      }
      if (
        child.status === "manual_review" &&
        !isNonBlockingLegacyUnknownAttempt(childAttempt) &&
        !isDefinitiveConfigurationRejection(childAttempt)
      ) {
        return followUpResult(
          parent.id,
          "blocked",
          child.error ?? "Follow-up requires manual review",
          {
            followUpOutreachId: child.id,
            followUpStatus: child.status,
          },
        );
      }
      if (
        isDefinitiveConfigurationRejection(childAttempt) ||
        isNonBlockingLegacyUnknownAttempt(childAttempt) ||
        (child.status === "cancelled" &&
          !!childAttempt &&
          isDefinitivelyUnsentOutreachAttempt(childAttempt)) ||
        (childAttempt?.providerMessageId &&
          childAttempt.testSend === true &&
          ["accepted", "delivery_failed"].includes(childAttempt.status))
      ) {
        mode = "new";
      } else if (childAttempt) {
        const retry = evaluateAttemptRetryEligibility(
          childAttempt,
          now,
          deliverySettings.credentialScope,
        );
        if (!retry.ok) {
          return followUpResult(parent.id, "blocked", retry.error, {
            followUpOutreachId: child.id,
            followUpStatus: child.status,
          });
        }
        mode = "retry";
      } else if (!canReplaceUnattemptedOutreachSnapshot(child, false)) {
        return followUpResult(parent.id, "blocked", MANUAL_REVIEW_LEGACY, {
          followUpOutreachId: child.id,
          followUpStatus: child.status,
        });
      }
    }

    const show = showById.get(parent.showId);
    const festivalBlocked = festivalOutreachBlockingReason(
      show,
      "follow_up",
      now,
    );
    if (festivalBlocked) {
      return followUpResult(
        parent.id,
        "blocked",
        festivalBlocked,
        {
          followUpOutreachId: child?.id,
          followUpStatus: child?.status,
        },
      );
    }
    const artistContacts = contactsByArtist.get(parent.artistId) ?? [];
    const contact =
      artistContacts.find((candidate) => candidate.id === parent.contactId) ??
      null;
    const policy = evaluateOutreachDeliveryPolicy({
      showSyncStatus: show?.syncStatus ?? null,
      associationExists:
        show?.artists.some(
          (association) => association.artistId === parent.artistId,
        ) ?? false,
      artistId: parent.artistId,
      contactId: parent.contactId,
      subject: mode === "retry" && child ? child.finalSubject : "",
      contact,
      artistContacts,
      stored: mode === "retry" && child ? child : null,
      attempt: mode === "retry" && childAttempt ? childAttempt : null,
      from: deliverySettings.from,
      testOverride: deliverySettings.testOverride,
      bccEmails: deliverySettings.bccEmails,
      suppressedEmails,
      allowMissingFrom: mode === "new",
    });
    if (!policy.ok) {
      return followUpResult(parent.id, "blocked", policy.error, {
        followUpOutreachId: child?.id,
        followUpStatus: child?.status,
      });
    }
    return followUpResult(parent.id, "eligible", null, {
      mode,
      recipients: policy.currentRecipients,
      fullTeamSend: policy.fullTeamSend,
      followUpOutreachId: child?.id,
      followUpStatus: child?.status,
    });
  });
}

async function prepareOriginalOutreach(
  input: SendOutreachInput,
): Promise<PreparedOutreach | { error: string; trajectoryError?: boolean }> {
  const {
    showId,
    contactId,
    subjectOverride,
    htmlOverride,
    singleRecipient,
    expectedRecipientIdentity,
    trajectoryContext,
  } = input;
  const [sendability] = await getOutreachSendabilityBatch([
    { showId, contactId, singleRecipient },
  ]);
  if (!sendability.sendable) {
    return { error: sendability.reason ?? "Outreach is not sendable" };
  }

  const [show, contact, utmSettings] = await Promise.all([
    db.show.findUnique({ where: { id: showId } }),
    db.contact.findUnique({
      where: { id: contactId },
      include: { artist: true },
    }),
    readEmailUtmSettingsSnapshot(),
  ]);
  if (!show) return { error: "Show not found" };
  if (show.syncStatus !== "active") {
    return { error: showInactiveError(show.syncStatus) };
  }
  const festivalBlocked = festivalOutreachBlockingReason(show, "original");
  if (festivalBlocked) return { error: festivalBlocked };
  const templatePurpose = originalTemplatePurposeForShow(show);
  const template = await ensureOriginalTemplateForShow(show);
  if (template.purpose !== templatePurpose) {
    return { error: "The selected outreach template purpose is unavailable" };
  }
  if (!contact) return { error: "Contact not found" };
  if (contact.state !== "active") {
    return { error: "Selected contact is quarantined" };
  }
  const identityError = expectedRecipientIdentity
    ? customizeRecipientIdentityError(contact, expectedRecipientIdentity)
    : null;
  if (identityError) return { error: identityError };
  const currentRecipientIdentity = customizeRecipientIdentity(contact);
  if (!currentRecipientIdentity) {
    return { error: "Selected contact has no valid active recipient address" };
  }
  const association = await db.showArtist.findUnique({
    where: {
      showId_artistId: { showId, artistId: contact.artistId },
    },
    select: { showId: true },
  });
  if (!association) return { error: artistNotOnShowError() };
  if (trajectoryContext) {
    if (
      trajectoryContext.showId !== showId ||
      trajectoryContext.artistId !== contact.artistId
    ) {
      return {
        error: "Trajectory recommendation outreach target changed",
        trajectoryError: true,
      };
    }
    try {
      await requireActionableTrajectoryRecommendation(trajectoryContext);
    } catch (error) {
      const message = trajectoryActionErrorMessage(error);
      if (!message) throw error;
      return { error: message, trajectoryError: true };
    }
  }

  const vars = await buildVarsForShow({
    artistName: contact.artist.name,
    venueName: show.venueName,
    showDate: show.date,
    managerName: contact.name,
    eventName: show.eventName,
    city: show.city,
    state: show.state,
    countryCode: show.countryCode,
    countryName: show.countryName,
  });
  const normalizedSubjectOverride = normalizeLegacyRateTemplateVariable(
    subjectOverride?.trim() ?? "",
  );
  const normalizedHtmlOverride = normalizeLegacyRateTemplateHtml(
    htmlOverride?.trim() ?? "",
  );

  return {
    kind: "original",
    parentOutreachId: null,
    trajectoryRecommendationId:
      trajectoryContext?.recommendationId ?? null,
    trajectoryContext: trajectoryContext ?? null,
    showId,
    artistId: contact.artistId,
    contactId,
    templateId: template.id,
    templatePurpose,
    recipients: sendability.recipients,
    fullTeamSend: sendability.fullTeamSend,
    subject: normalizedSubjectOverride || applyTemplate(template.subject, vars),
    html: normalizedHtmlOverride
      ? appendEmailUtmToHtml(
          normalizedHtmlOverride,
          "original",
          contact.artist.name,
          utmSettings,
        )
      : renderTrackedEmailHtml(
          template.htmlBody,
          vars,
          "original",
          contact.artist.name,
          utmSettings,
        ),
    expectedRecipientIdentity:
      expectedRecipientIdentity ?? currentRecipientIdentity,
  };
}

async function prepareFollowUpOutreach(
  parentOutreachId: string,
  trajectoryContext?: TrajectoryActionContext,
): Promise<PreparedOutreach | { error: string; trajectoryError?: boolean }> {
  const [eligibility] = await getFollowUpEligibilityBatch([
    parentOutreachId,
  ]);
  if (!eligibility?.eligible) {
    return {
      error:
        eligibility?.reason ?? "Original outreach is not eligible for follow-up",
    };
  }

  const [parent, template, utmSettings] = await Promise.all([
    db.outreach.findUnique({
      where: { id: parentOutreachId },
      select: {
        id: true,
        kind: true,
        parentOutreachId: true,
        trajectoryRecommendationId: true,
        showId: true,
        artistId: true,
        contactId: true,
        show: {
          select: {
            venueName: true,
            date: true,
            eventName: true,
            city: true,
            state: true,
            countryCode: true,
            countryName: true,
            syncStatus: true,
            isFestival: true,
            festivalNycStatus: true,
            dismissedAt: true,
          },
        },
        contact: {
          select: {
            id: true,
            artistId: true,
            email: true,
            name: true,
            state: true,
            updatedAt: true,
            artist: { select: { name: true } },
          },
        },
      },
    }),
    ensureFollowUpTemplate(),
    readEmailUtmSettingsSnapshot(),
  ]);
  if (!parent || parent.kind !== "original") {
    return { error: "Original outreach not found" };
  }
  if (template.purpose !== "follow_up") {
    return { error: "The follow-up template purpose is unavailable" };
  }
  if (parent.show.syncStatus !== "active") {
    return { error: showInactiveError(parent.show.syncStatus) };
  }
  if (parent.show.isFestival && parent.show.dismissedAt) {
    return { error: "Restore this festival before sending follow-up" };
  }
  if (
    !parent.contactId ||
    !parent.contact ||
    parent.contact.id !== parent.contactId ||
    parent.contact.state !== "active"
  ) {
    return { error: "Selected contact is no longer available" };
  }
  if (parent.contact.artistId !== parent.artistId) {
    return {
      error: "Selected contact no longer belongs to the outreach artist",
    };
  }
  const expectedRecipientIdentity = customizeRecipientIdentity(parent.contact);
  if (!expectedRecipientIdentity) {
    return { error: "Selected contact has no valid active recipient address" };
  }
  const association = await db.showArtist.findUnique({
    where: {
      showId_artistId: {
        showId: parent.showId,
        artistId: parent.artistId,
      },
    },
    select: { showId: true },
  });
  if (!association) return { error: artistNotOnShowError() };
  if (trajectoryContext) {
    if (
      trajectoryContext.showId !== parent.showId ||
      trajectoryContext.artistId !== parent.artistId
    ) {
      return {
        error: "Trajectory recommendation follow-up target changed",
        trajectoryError: true,
      };
    }
    try {
      await requireActionableTrajectoryRecommendation(trajectoryContext);
    } catch (error) {
      const message = trajectoryActionErrorMessage(error);
      if (!message) throw error;
      return { error: message, trajectoryError: true };
    }
  }

  const vars = await buildVarsForShow({
    artistName: parent.contact.artist.name,
    venueName: parent.show.venueName,
    showDate: parent.show.date,
    managerName: parent.contact.name,
    eventName: parent.show.eventName,
    city: parent.show.city,
    state: parent.show.state,
    countryCode: parent.show.countryCode,
    countryName: parent.show.countryName,
  });
  return {
    kind: "follow_up",
    parentOutreachId: parent.id,
    trajectoryRecommendationId: parent.trajectoryRecommendationId,
    trajectoryContext: trajectoryContext ?? null,
    showId: parent.showId,
    artistId: parent.artistId,
    contactId: parent.contactId,
    templateId: template.id,
    templatePurpose: "follow_up",
    recipients: eligibility.recipients,
    fullTeamSend: eligibility.fullTeamSend,
    subject: applyTemplate(template.subject, vars),
    html: renderTrackedEmailHtml(
      template.htmlBody,
      vars,
      "follow_up",
      parent.contact.artist.name,
      utmSettings,
    ),
    expectedRecipientIdentity,
  };
}

async function currentAttempt(
  tx: Prisma.TransactionClient,
  idempotencyKey: string,
): Promise<StoredAttempt | null> {
  return tx.outreachSendAttempt.findUnique({ where: { idempotencyKey } });
}

function claimedOutreach(
  row: {
    id: string;
    kind: OutreachKindValue;
    parentOutreachId: string | null;
    showId: string;
    artistId: string;
    contactId: string | null;
    claimToken: string | null;
    finalSubject: string;
    finalHtml: string;
    recipientEmails: string[];
    recipientSnapshotState: string;
    fullTeamSend: boolean;
    idempotencyKey: string;
    providerMessageId: string | null;
    sentAt: Date | null;
    attemptCount: number;
    expectedRecipientContactId: string | null;
    expectedRecipientArtistId: string | null;
    expectedRecipientEmail: string | null;
    expectedRecipientUpdatedAt: Date | null;
    contact?: {
      id: string;
      artistId: string;
      email: string | null;
      state: "active" | "quarantined";
      isFullTeam: boolean;
    } | null;
  },
  attempt: StoredAttempt | null,
  automaticRetry: boolean,
  claimRecovery: OutreachClaimRecoveryState,
  preparationRetryCount = 0,
): ClaimedOutreach {
  if (!row.claimToken) throw new Error("Claim token was not persisted");
  return {
    id: row.id,
    kind: row.kind,
    parentOutreachId: row.parentOutreachId,
    showId: row.showId,
    artistId: row.artistId,
    contactId: row.contactId,
    claimToken: row.claimToken,
    finalSubject: row.finalSubject,
    finalHtml: row.finalHtml,
    recipientEmails: row.recipientEmails,
    recipientSnapshotState: row.recipientSnapshotState,
    fullTeamSend: row.fullTeamSend,
    idempotencyKey: row.idempotencyKey,
    providerMessageId: row.providerMessageId,
    sentAt: row.sentAt,
    attemptCount: row.attemptCount,
    attempt,
    automaticRetry,
    preparationRetryCount,
    claimRecovery,
    expectedRecipientIdentity: storedExpectedRecipientIdentity(row),
    contact: row.contact ?? null,
  };
}

async function markManualReview(
  tx: Prisma.TransactionClient,
  outreachId: string,
  error: string,
  attemptId?: string,
): Promise<CompletedResult> {
  if (attemptId) {
    await tx.outreachSendAttempt.update({
      where: { id: attemptId },
      data: { status: "manual_review", error, nextAttemptAt: null },
    });
  }
  await tx.outreach.update({
    where: { id: outreachId },
    data: {
      status: "manual_review",
      error,
      scheduledFor: null,
      nextAttemptAt: null,
      claimedAt: null,
      claimToken: null,
    },
  });
  return {
    kind: "complete",
    result: { ok: false, outreachId, error },
  };
}

async function markPolicyCancelled(
  tx: Prisma.TransactionClient,
  outreachId: string,
  attempt: StoredAttempt,
  error: string,
): Promise<CompletedResult> {
  if (!isDefinitivelyUnsentOutreachAttempt(attempt)) {
    return markProviderAcceptanceUncertain(
      tx,
      outreachId,
      attempt.id,
      `${MANUAL_REVIEW_UNCERTAIN}: current delivery policy blocks automatic retry (${error})`,
      attempt.failureDisposition === "in_flight" ? "in_flight" : "uncertain",
    );
  }
  await tx.outreachSendAttempt.updateMany({
    where: { id: attempt.id, providerMessageId: null },
    data: {
      status: "cancelled",
      error,
      failureDisposition: "policy",
      nextAttemptAt: null,
    },
  });
  await tx.outreach.update({
    where: { id: outreachId },
    data: {
      status: "cancelled",
      error,
      scheduledFor: null,
      nextAttemptAt: null,
      claimedAt: null,
      claimToken: null,
    },
  });
  return {
    kind: "complete",
    result: { ok: false, outreachId, error },
  };
}

async function retireDefinitiveConfigurationAttempt(
  tx: Prisma.TransactionClient,
  attempt: StoredAttempt,
): Promise<boolean> {
  if (!isDefinitiveConfigurationRejection(attempt)) return false;
  const retired = await tx.outreachSendAttempt.updateMany({
    where: {
      id: attempt.id,
      providerMessageId: null,
      failureDisposition: "configuration",
      firstAttemptAt: { not: null },
      attemptCount: { gt: 0 },
      status: { in: ["request_failed", "manual_review", "cancelled"] },
    },
    data: {
      status: "cancelled",
      nextAttemptAt: null,
    },
  });
  return retired.count === 1;
}

async function applyDeliveryPolicyDecision(
  tx: Prisma.TransactionClient,
  outreach: Pick<ClaimedOutreach, "id" | "attemptCount" | "automaticRetry">,
  attempt: StoredAttempt,
  decision: Extract<OutreachDeliveryPolicyDecision, { ok: false }>,
  now: Date,
  configurationRecovery?: OutreachAttemptRecoveryState,
): Promise<CompletedResult> {
  if (isProviderAcceptanceUnresolvedAttempt(attempt)) {
    return markProviderAcceptanceUncertain(
      tx,
      outreach.id,
      attempt.id,
      `${MANUAL_REVIEW_UNCERTAIN}: current delivery policy blocks automatic retry (${decision.error})`,
      attempt.failureDisposition === "in_flight" ? "in_flight" : "uncertain",
    );
  }
  if (decision.state === "cancelled") {
    return markPolicyCancelled(tx, outreach.id, attempt, decision.error);
  }
  if (decision.state === "manual_review") {
    return markManualReview(tx, outreach.id, decision.error, attempt.id);
  }

  const outage = getOutreachConfigurationOutageState(
    outreach.automaticRetry,
    outreach.attemptCount,
    decision.error,
    now,
  );
  if (configurationRecovery) {
    await tx.outreachSendAttempt.update({
      where: { id: attempt.id },
      data: getOutreachConfigurationAttemptRecoveryData(
        configurationRecovery,
      ),
    });
  }
  await tx.outreach.update({
    where: { id: outreach.id },
    data: {
      status: outage.status,
      error: outage.error,
      nextAttemptAt: outage.nextAttemptAt,
      claimedAt: null,
      claimToken: null,
      ...(configurationRecovery
        ? { lastAttemptAt: configurationRecovery.lastAttemptAt }
        : {}),
    },
  });
  return {
    kind: "complete",
    result: {
      ok: false,
      outreachId: outreach.id,
      error: outage.error,
      ...(outage.retryScheduled
        ? {
            retryScheduled: true,
            nextAttemptAt: outage.nextAttemptAt,
          }
        : {}),
    },
  };
}

async function markProviderAcceptanceUncertain(
  tx: Prisma.TransactionClient,
  outreachId: string,
  attemptId: string,
  error: string,
  disposition: Extract<
    ResendFailureDisposition,
    "uncertain" | "in_flight"
  > = "uncertain",
): Promise<CompletedResult> {
  await tx.outreachSendAttempt.update({
    where: { id: attemptId },
    data: {
      status: "request_failed",
      error,
      failureDisposition: disposition,
      nextAttemptAt: null,
    },
  });
  await tx.outreach.update({
    where: { id: outreachId },
    data: {
      status: "manual_review",
      error,
      scheduledFor: null,
      nextAttemptAt: null,
      claimedAt: null,
      claimToken: null,
    },
  });
  return {
    kind: "complete",
    result: { ok: false, outreachId, error },
  };
}

async function markTerminalFailure(
  tx: Prisma.TransactionClient,
  outreachId: string,
  error: string,
  attemptId?: string,
): Promise<CompletedResult> {
  if (attemptId) {
    await tx.outreachSendAttempt.update({
      where: { id: attemptId },
      data: { error, nextAttemptAt: null },
    });
  }
  await tx.outreach.update({
    where: { id: outreachId },
    data: {
      status: "failed",
      error,
      nextAttemptAt: null,
      claimedAt: null,
      claimToken: null,
    },
  });
  return {
    kind: "complete",
    result: { ok: false, outreachId, error },
  };
}

async function applyRetryDecision(
  tx: Prisma.TransactionClient,
  outreachId: string,
  attempt: StoredAttempt,
  now: Date,
): Promise<CompletedResult | null> {
  const decision = evaluateAttemptRetryEligibility(
    attempt,
    now,
    getResendCredentialScope(process.env.RESEND_API_KEY),
  );
  if (decision.ok) return null;
  if (
    decision.state === "manual_review" &&
    (attempt.status === "sending" ||
      attempt.failureDisposition === "uncertain" ||
      attempt.failureDisposition === "in_flight" ||
      (attempt.status === "request_failed" &&
        attempt.failureDisposition === null))
  ) {
    return markProviderAcceptanceUncertain(
      tx,
      outreachId,
      attempt.id,
      decision.error,
      attempt.failureDisposition === "in_flight" ? "in_flight" : "uncertain",
    );
  }
  return decision.state === "manual_review"
    ? markManualReview(tx, outreachId, decision.error, attempt.id)
    : markTerminalFailure(tx, outreachId, decision.error, attempt.id);
}

async function finishAlreadyAccepted(
  tx: Prisma.TransactionClient,
  outreach: {
    id: string;
    idempotencyKey: string;
  },
  attempt: StoredAttempt,
): Promise<CompletedResult> {
  if (!attempt.providerMessageId) {
    throw new Error("Accepted attempt has no provider message ID");
  }
  if (attempt.testSend === null) {
    return markManualReview(
      tx,
      outreach.id,
      "Legacy provider attempt has no verified real/test classification",
      attempt.id,
    );
  }
  if (attempt.status === "delivery_failed") {
    const error =
      attempt.error ??
      "Resend accepted the request but later reported delivery failure; review manually";
    if (attempt.testSend) {
      await tx.outreach.updateMany({
        where: {
          id: outreach.id,
          idempotencyKey: attempt.idempotencyKey,
        },
        data: getAcceptedDeliveryFailureOutreachState(
          true,
          error,
          attempt.providerMessageId,
          attempt.acceptedAt ?? new Date(),
        ),
      });
      return {
        kind: "complete",
        result: { ok: false, outreachId: outreach.id, error },
      };
    }
    return markManualReview(tx, outreach.id, error);
  }
  await tx.outreachSendAttempt.update({
    where: { id: attempt.id },
    data: {
      status: "accepted",
      error: null,
      failureDisposition: null,
      nextAttemptAt: null,
      acceptedAt: attempt.acceptedAt ?? new Date(),
    },
  });
  await tx.outreach.updateMany({
    where: { id: outreach.id, idempotencyKey: outreach.idempotencyKey },
    data: {
      status: attempt.testSend ? "test" : "sent",
      error: null,
      providerMessageId: attempt.providerMessageId,
      sentAt: attempt.acceptedAt ?? new Date(),
      scheduledFor: null,
      nextAttemptAt: null,
      claimedAt: null,
      claimToken: null,
    },
  });
  return {
    kind: "complete",
    result: { ok: true, outreachId: outreach.id },
  };
}

function preparedOutreachScopeWhere(
  prep: PreparedOutreach,
): Prisma.OutreachWhereInput {
  return prep.kind === "follow_up"
    ? {
        kind: "follow_up",
        parentOutreachId: prep.parentOutreachId,
      }
    : {
        kind: "original",
        showId: prep.showId,
        artistId: prep.artistId,
      };
}

function preparedOutreachUniqueWhere(
  prep: PreparedOutreach,
): Prisma.OutreachWhereUniqueInput {
  if (prep.kind === "follow_up") {
    if (!prep.parentOutreachId) {
      throw new Error("Follow-up preparation is missing its original outreach");
    }
    return { parentOutreachId: prep.parentOutreachId };
  }
  return {
    showId_contactId_kind: {
      showId: prep.showId,
      contactId: prep.contactId,
      kind: "original",
    },
  };
}

function preparedOutreachName(kind: OutreachKindValue): string {
  return kind === "follow_up" ? "Follow-up" : "Outreach";
}

async function preparedFollowUpBlockingReason(
  tx: Prisma.TransactionClient,
  prep: {
    kind: OutreachKindValue;
    parentOutreachId: string | null;
    showId: string;
    artistId: string;
    contactId: string | null;
  },
): Promise<string | null> {
  if (prep.kind !== "follow_up") return null;
  if (!prep.parentOutreachId) {
    return "Follow-up preparation is missing its original outreach";
  }
  const parent = await tx.outreach.findUnique({
    where: { id: prep.parentOutreachId },
    select: {
      id: true,
      kind: true,
      parentOutreachId: true,
      idempotencyKey: true,
      providerMessageId: true,
      showId: true,
      artistId: true,
      contactId: true,
      show: {
        select: {
          isFestival: true,
          date: true,
          festivalNycStatus: true,
          dismissedAt: true,
        },
      },
    },
  });
  const attempt = parent
    ? await currentAttempt(tx, parent.idempotencyKey)
    : null;
  const proofError = followUpParentBlockingReason(parent, attempt);
  if (proofError) return proofError;
  if (parent?.show.isFestival && parent.show.dismissedAt) {
    return "Restore this festival before sending follow-up";
  }
  if (
    !parent ||
    parent.showId !== prep.showId ||
    parent.artistId !== prep.artistId ||
    parent.contactId !== prep.contactId
  ) {
    return "Follow-up identity no longer matches its original outreach";
  }
  return null;
}

async function preparedTrajectoryBlockingReason(
  tx: Prisma.TransactionClient,
  prep: PreparedOutreach,
  now: Date,
): Promise<{ error: string; trajectoryError: true } | null> {
  if (!prep.trajectoryContext) return null;
  if (
    prep.trajectoryContext.showId !== prep.showId ||
    prep.trajectoryContext.artistId !== prep.artistId
  ) {
    return {
      error: "Trajectory recommendation outreach target changed",
      trajectoryError: true,
    };
  }
  try {
    await requireActionableTrajectoryRecommendationInTransaction(
      tx,
      prep.trajectoryContext,
      now,
    );
    return null;
  } catch (error) {
    const message = trajectoryActionErrorMessage(error);
    if (!message) throw error;
    return { error: message, trajectoryError: true };
  }
}

async function preparedDeliveryPolicyBlockingReason(
  tx: Prisma.TransactionClient,
  prep: PreparedOutreach,
): Promise<string | null> {
  const [show, association] = await Promise.all([
      tx.show.findUnique({
        where: { id: prep.showId },
        select: {
          syncStatus: true,
          isFestival: true,
          date: true,
          festivalNycStatus: true,
          dismissedAt: true,
        },
      }),
      tx.showArtist.findUnique({
        where: {
          showId_artistId: {
            showId: prep.showId,
            artistId: prep.artistId,
          },
        },
        select: { showId: true },
      }),
    ]);
  const artistContacts = await tx.$queryRaw<
    Array<DeliveryPolicyContact & { updatedAt: Date }>
  >(
    Prisma.sql`
      SELECT
        "id",
        "artistId",
        "email",
        "state",
        "isFullTeam",
        "updatedAt"
      FROM "Contact"
      WHERE "artistId" = ${prep.artistId}
      ORDER BY "id"
      FOR UPDATE
    `,
  );
  const deliverySettings = await getResendDeliverySettingsSnapshot(tx);
  const festivalBlocked = festivalOutreachBlockingReason(show, prep.kind);
  if (festivalBlocked) return festivalBlocked;
  const contact =
    artistContacts.find((candidate) => candidate.id === prep.contactId) ?? null;
  if (!contact || contact.artistId !== prep.artistId) {
    return "Selected contact no longer belongs to the outreach artist";
  }
  const policyEmails = normalizeEmails([
    ...artistContacts.flatMap((candidate) =>
      candidate.state === "active" && candidate.email
        ? [candidate.email]
        : [],
    ),
    ...deliverySettings.bccEmails,
    ...(deliverySettings.testOverride
      ? [deliverySettings.testOverride]
      : []),
    ...(prep.expectedRecipientIdentity
      ? [prep.expectedRecipientIdentity.normalizedEmail]
      : []),
  ]);
  await acquireOutreachRecipientPolicyLocks(tx, policyEmails);
  const identityError = prep.expectedRecipientIdentity
    ? customizeRecipientIdentityError(
        contact,
        prep.expectedRecipientIdentity,
      )
    : null;
  if (identityError) return identityError;
  const suppressions =
    policyEmails.length === 0
      ? []
      : await tx.emailSuppression.findMany({
          where: { normalizedEmail: { in: policyEmails } },
          select: { normalizedEmail: true },
        });
  const decision = evaluateOutreachDeliveryPolicy({
    showSyncStatus: show?.syncStatus ?? null,
    associationExists: association !== null,
    artistId: prep.artistId,
    contactId: prep.contactId,
    subject: prep.subject,
    contact,
    artistContacts,
    stored: null,
    attempt: null,
    from: deliverySettings.from,
    testOverride: deliverySettings.testOverride,
    bccEmails: deliverySettings.bccEmails,
    suppressedEmails: suppressions.map(
      (suppression) => suppression.normalizedEmail,
    ),
    allowMissingFrom: true,
    requestedFullTeamSend: prep.fullTeamSend,
  });
  if (!decision.ok) return decision.error;
  if (
    decision.fullTeamSend !== prep.fullTeamSend ||
    !sameEmails(decision.currentRecipients, prep.recipients)
  ) {
    return MANUAL_REVIEW_SNAPSHOT;
  }
  return null;
}

export function preparedTemplatePurposeBlockingReason(
  show: { isFestival: boolean },
  prep: {
    kind: OutreachKindValue;
    templatePurpose: EmailTemplatePurpose;
  },
): string | null {
  const expectedPurpose =
    prep.kind === "follow_up"
      ? "follow_up"
      : originalTemplatePurposeForShow(show);
  return prep.templatePurpose === expectedPurpose
    ? null
    : "Show festival classification changed while preparing outreach; retry to reprepare the correct template";
}

async function claimImmediateOutreach(prep: PreparedOutreach): Promise<ClaimResult> {
  const now = new Date();
  return withSerializableRetry(async (tx) => {
    const [show, association] = await Promise.all([
      tx.show.findUnique({
        where: { id: prep.showId },
        select: {
          syncStatus: true,
          isFestival: true,
          date: true,
          festivalNycStatus: true,
          dismissedAt: true,
        },
      }),
      tx.showArtist.findUnique({
        where: {
          showId_artistId: {
            showId: prep.showId,
            artistId: prep.artistId,
          },
        },
        select: { showId: true },
      }),
    ]);
    if (!show) {
      return { kind: "complete", result: { ok: false, error: "Show not found" } };
    }
    const templatePurposeBlocked = preparedTemplatePurposeBlockingReason(
      show,
      prep,
    );
    if (templatePurposeBlocked) {
      return {
        kind: "complete",
        result: { ok: false, error: templatePurposeBlocked },
      };
    }
    if (show.syncStatus !== "active") {
      return {
        kind: "complete",
        result: { ok: false, error: showInactiveError(show.syncStatus) },
      };
    }
    const festivalBlocked = festivalOutreachBlockingReason(show, prep.kind);
    if (festivalBlocked) {
      return {
        kind: "complete",
        result: { ok: false, error: festivalBlocked },
      };
    }
    if (!association) {
      return {
        kind: "complete",
        result: { ok: false, error: artistNotOnShowError() },
      };
    }
    const followUpBlocked = await preparedFollowUpBlockingReason(tx, prep);
    if (followUpBlocked) {
      return {
        kind: "complete",
        result: { ok: false, error: followUpBlocked },
      };
    }
    const trajectoryBlocked = await preparedTrajectoryBlockingReason(
      tx,
      prep,
      now,
    );
    if (trajectoryBlocked) {
      return {
        kind: "complete",
        result: { ok: false, ...trajectoryBlocked },
      };
    }
    const policyBlocked = await preparedDeliveryPolicyBlockingReason(tx, prep);
    if (policyBlocked) {
      return {
        kind: "complete",
        result: { ok: false, error: policyBlocked },
      };
    }

    const active = await tx.outreach.findMany({
      where: {
        ...preparedOutreachScopeWhere(prep),
        status: {
          in: [
            "sent",
            "scheduled",
            "retry_scheduled",
            "queued",
            "failed",
            "manual_review",
          ],
        },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const currentAttempts = new Map(
      (
        await tx.outreachSendAttempt.findMany({
          where: {
            idempotencyKey: {
              in: active.map((row) => row.idempotencyKey),
            },
          },
        })
      ).map((attempt) => [attempt.idempotencyKey, attempt]),
    );
    const sent = active.find((row) => row.status === "sent");
    if (sent) {
      return {
        kind: "complete",
        result: {
          ok: false,
          error: `${preparedOutreachName(prep.kind)} already sent`,
          outreachId: sent.id,
        },
      };
    }
    const scheduled = active.find((row) => row.status === "scheduled");
    if (scheduled) {
      return {
        kind: "complete",
        result: {
          ok: false,
          error: `${preparedOutreachName(prep.kind)} already scheduled`,
          outreachId: scheduled.id,
        },
      };
    }
    const retryScheduled = active.find(
      (row) => row.status === "retry_scheduled",
    );
    if (retryScheduled) {
      return {
        kind: "complete",
        result: {
          ok: false,
          error: "Automatic retry is already scheduled",
          outreachId: retryScheduled.id,
        },
      };
    }
    const manualReview = active.find(
      (row) =>
        row.status === "manual_review" &&
        !isNonBlockingLegacyUnknownAttempt(
          currentAttempts.get(row.idempotencyKey),
        ) &&
        !isDefinitiveConfigurationRejection(
          currentAttempts.get(row.idempotencyKey),
        ),
    );
    if (manualReview) {
      return {
        kind: "complete",
        result: {
          ok: false,
          error: manualReview.error ?? "A previous send requires manual review",
          outreachId: manualReview.id,
        },
      };
    }
    const queued = active.find((row) => row.status === "queued");
    if (queued) {
      if (!isStaleOutreachClaim(queued.claimedAt, now)) {
        return {
          kind: "complete",
          result: {
            ok: false,
            error: "Send already in progress",
            outreachId: queued.id,
          },
        };
      }
      if (queued.contactId !== prep.contactId) {
        return {
          kind: "complete",
          result: {
            ok: false,
            error:
              "A previous queued send must be recovered with its original contact",
            outreachId: queued.id,
          },
        };
      }

      const attempt = await currentAttempt(tx, queued.idempotencyKey);
      if (attempt?.providerMessageId) {
        return finishAlreadyAccepted(tx, queued, attempt);
      }
      if (attempt) {
        const snapshotConflict = recipientSnapshotConflict(
          queued,
          prep.recipients,
          prep.fullTeamSend,
        );
        if (snapshotConflict) {
          if (
            attempt.status === "sending" ||
            attempt.failureDisposition === "uncertain" ||
            attempt.failureDisposition === "in_flight"
          ) {
            return markProviderAcceptanceUncertain(
              tx,
              queued.id,
              attempt.id,
              `${MANUAL_REVIEW_UNCERTAIN}: ${snapshotConflict}`,
              attempt.failureDisposition === "in_flight"
                ? "in_flight"
                : "uncertain",
            );
          }
          return markManualReview(
            tx,
            queued.id,
            snapshotConflict,
            attempt.id,
          );
        }
        const blocked = await applyRetryDecision(tx, queued.id, attempt, now);
        if (blocked) return blocked;
      } else if (!canReplaceUnattemptedOutreachSnapshot(queued, false)) {
        return markManualReview(tx, queued.id, MANUAL_REVIEW_LEGACY);
      }

      const claimToken = randomUUID();
      let idempotencyKey = queued.idempotencyKey;
      if (!attempt && !attemptIdFromKey(queued.id, idempotencyKey)) {
        idempotencyKey = newAttemptIdentity(queued.id).idempotencyKey;
      }
      const recovered = await tx.outreach.update({
        where: { id: queued.id },
        data: {
          claimToken,
          claimedAt: now,
          lastAttemptAt: now,
          error: null,
          idempotencyKey,
          ...trajectoryAttributionData(
            prep,
            queued.trajectoryRecommendationId,
          ),
          ...(!attempt
            ? {
                finalSubject: prep.subject,
                finalHtml: prep.html,
                recipientEmails: prep.recipients,
                recipientSnapshotState: "verified",
                fullTeamSend: prep.fullTeamSend,
                templateId: prep.templateId,
                ...expectedRecipientIdentityData(
                  prep.expectedRecipientIdentity,
                ),
              }
            : {}),
        },
      });
      return {
        kind: "claimed",
        outreach: claimedOutreach(
          recovered,
          attempt,
          false,
          outreachClaimRecoveryState(queued),
        ),
      };
    }
    const failedForAnotherContact = active.find(
      (row) =>
        row.status === "failed" &&
        row.contactId !== prep.contactId &&
        !isNonBlockingLegacyUnknownAttempt(
          currentAttempts.get(row.idempotencyKey),
        ) &&
        !isDefinitiveConfigurationRejection(
          currentAttempts.get(row.idempotencyKey),
        ) &&
        hasProtectedCurrentSendState(
          row,
          currentAttempts.has(row.idempotencyKey),
        ),
    );
    if (failedForAnotherContact) {
      return {
        kind: "complete",
        result: {
          ok: false,
          error:
            "A previous failed send for this artist must be recovered with its original recipient snapshot",
          outreachId: failedForAnotherContact.id,
        },
      };
    }

    const existing = await tx.outreach.findUnique({
      where: preparedOutreachUniqueWhere(prep),
    });
    const claimToken = randomUUID();
    const existingAttempt = existing
      ? await currentAttempt(tx, existing.idempotencyKey)
      : null;
    if (
      existing &&
      existingAttempt?.providerMessageId &&
      existingAttempt.testSend !== true
    ) {
      return finishAlreadyAccepted(tx, existing, existingAttempt);
    }

    if (
      existing &&
      existingAttempt &&
      isDefinitiveConfigurationRejection(existingAttempt)
    ) {
      const retired = await retireDefinitiveConfigurationAttempt(
        tx,
        existingAttempt,
      );
      if (!retired) {
        const refreshed = await currentAttempt(tx, existing.idempotencyKey);
        if (refreshed?.providerMessageId) {
          return finishAlreadyAccepted(tx, existing, refreshed);
        }
        return markManualReview(
          tx,
          existing.id,
          "Definitive configuration rejection changed before a fresh provider attempt could be created",
          existingAttempt.id,
        );
      }
      const identity = newAttemptIdentity(existing.id);
      const updated = await tx.outreach.update({
        where: { id: existing.id },
        data: {
          status: "queued",
          error: null,
          finalSubject: prep.subject,
          finalHtml: prep.html,
          recipientEmails: prep.recipients,
          recipientSnapshotState: "verified",
          fullTeamSend: prep.fullTeamSend,
          templateId: prep.templateId,
          ...expectedRecipientIdentityData(prep.expectedRecipientIdentity),
          ...trajectoryAttributionData(
            prep,
            existing.trajectoryRecommendationId,
          ),
          scheduledFor: null,
          nextAttemptAt: null,
          claimToken,
          claimedAt: now,
          lastAttemptAt: now,
          attemptCount: 0,
          idempotencyKey: identity.idempotencyKey,
          ...resetDeliveryState(),
        },
      });
      return {
        kind: "claimed",
        outreach: claimedOutreach(
          updated,
          null,
          false,
          freshImmediateClaimRecoveryState(),
        ),
      };
    }

    if (existing && isNonBlockingLegacyUnknownAttempt(existingAttempt)) {
      const identity = newAttemptIdentity(existing.id);
      const updated = await tx.outreach.update({
        where: { id: existing.id },
        data: {
          status: "queued",
          error: null,
          finalSubject: prep.subject,
          finalHtml: prep.html,
          recipientEmails: prep.recipients,
          recipientSnapshotState: "verified",
          fullTeamSend: prep.fullTeamSend,
          templateId: prep.templateId,
          ...expectedRecipientIdentityData(prep.expectedRecipientIdentity),
          ...trajectoryAttributionData(
            prep,
            existing.trajectoryRecommendationId,
          ),
          scheduledFor: null,
          nextAttemptAt: null,
          claimToken,
          claimedAt: now,
          lastAttemptAt: now,
          attemptCount: 0,
          idempotencyKey: identity.idempotencyKey,
          ...resetDeliveryState(),
        },
      });
      return {
        kind: "claimed",
        outreach: claimedOutreach(
          updated,
          null,
          false,
          freshImmediateClaimRecoveryState(),
        ),
      };
    }

    if (existing?.status === "failed") {
      const attempt = existingAttempt;
      if (attempt) {
        const snapshotConflict = recipientSnapshotConflict(
          existing,
          prep.recipients,
          prep.fullTeamSend,
        );
        if (snapshotConflict) {
          if (
            attempt.status === "sending" ||
            attempt.failureDisposition === "uncertain" ||
            attempt.failureDisposition === "in_flight"
          ) {
            return markProviderAcceptanceUncertain(
              tx,
              existing.id,
              attempt.id,
              `${MANUAL_REVIEW_UNCERTAIN}: ${snapshotConflict}`,
              attempt.failureDisposition === "in_flight"
                ? "in_flight"
                : "uncertain",
            );
          }
          return markManualReview(
            tx,
            existing.id,
            snapshotConflict,
            attempt.id,
          );
        }
        const blocked = await applyRetryDecision(tx, existing.id, attempt, now);
        if (blocked) return blocked;
        const updated = await tx.outreach.update({
          where: { id: existing.id },
          data: {
            status: "queued",
            error: null,
            scheduledFor: null,
            nextAttemptAt: null,
            claimToken,
            claimedAt: now,
            lastAttemptAt: now,
            ...trajectoryAttributionData(
              prep,
              existing.trajectoryRecommendationId,
            ),
          },
        });
        return {
          kind: "claimed",
          outreach: claimedOutreach(
            updated,
            attempt,
            false,
            outreachClaimRecoveryState(existing),
          ),
        };
      }
      if (!canReplaceUnattemptedOutreachSnapshot(existing, false)) {
        return markManualReview(tx, existing.id, MANUAL_REVIEW_LEGACY);
      }

      const identity = attemptIdFromKey(existing.id, existing.idempotencyKey)
        ? { idempotencyKey: existing.idempotencyKey }
        : newAttemptIdentity(existing.id);
      const updated = await tx.outreach.update({
        where: { id: existing.id },
        data: {
          status: "queued",
          error: null,
          finalSubject: prep.subject,
          finalHtml: prep.html,
          recipientEmails: prep.recipients,
          recipientSnapshotState: "verified",
          fullTeamSend: prep.fullTeamSend,
          templateId: prep.templateId,
          ...expectedRecipientIdentityData(prep.expectedRecipientIdentity),
          ...trajectoryAttributionData(
            prep,
            existing.trajectoryRecommendationId,
          ),
          scheduledFor: null,
          nextAttemptAt: null,
          claimToken,
          claimedAt: now,
          lastAttemptAt: now,
          idempotencyKey: identity.idempotencyKey,
        },
      });
      return {
        kind: "claimed",
        outreach: claimedOutreach(
          updated,
          null,
          false,
          outreachClaimRecoveryState(existing),
        ),
      };
    }

    if (existing) {
      if (existing.status !== "test" && existing.status !== "cancelled") {
        return {
          kind: "complete",
          result: {
            ok: false,
            outreachId: existing.id,
            error: `Outreach cannot be sent from state ${existing.status}`,
          },
        };
      }
      if (existing.status === "cancelled" && existingAttempt?.providerMessageId) {
        return finishAlreadyAccepted(tx, existing, existingAttempt);
      }
      if (
        existing.status === "cancelled" &&
        existingAttempt &&
        !isDefinitivelyUnsentOutreachAttempt(existingAttempt)
      ) {
        return markProviderAcceptanceUncertain(
          tx,
          existing.id,
          existingAttempt.id,
          MANUAL_REVIEW_UNCERTAIN,
          existingAttempt.failureDisposition === "in_flight"
            ? "in_flight"
            : "uncertain",
        );
      }
      if (
        existing.status === "cancelled" &&
        !existingAttempt &&
        hasProtectedCurrentSendState(existing, false)
      ) {
        return markManualReview(tx, existing.id, MANUAL_REVIEW_LEGACY);
      }
      const identity = newAttemptIdentity(existing.id);
      const updated = await tx.outreach.update({
        where: { id: existing.id },
        data: {
          status: "queued",
          error: null,
          finalSubject: prep.subject,
          finalHtml: prep.html,
          recipientEmails: prep.recipients,
          recipientSnapshotState: "verified",
          fullTeamSend: prep.fullTeamSend,
          templateId: prep.templateId,
          ...expectedRecipientIdentityData(prep.expectedRecipientIdentity),
          ...trajectoryAttributionData(
            prep,
            existing.trajectoryRecommendationId,
          ),
          scheduledFor: null,
          nextAttemptAt: null,
          claimToken,
          claimedAt: now,
          lastAttemptAt: now,
          attemptCount: 0,
          idempotencyKey: identity.idempotencyKey,
          ...resetDeliveryState(),
        },
      });
      return {
        kind: "claimed",
        outreach: claimedOutreach(
          updated,
          null,
          false,
          freshImmediateClaimRecoveryState(),
        ),
      };
    }

    const id = randomUUID();
    const identity = newAttemptIdentity(id);
    const created = await tx.outreach.create({
      data: {
        id,
        kind: prep.kind,
        parentOutreachId: prep.parentOutreachId,
        showId: prep.showId,
        artistId: prep.artistId,
        contactId: prep.contactId,
        templateId: prep.templateId,
        finalSubject: prep.subject,
        finalHtml: prep.html,
        recipientEmails: prep.recipients,
        recipientSnapshotState: "verified",
        fullTeamSend: prep.fullTeamSend,
        ...expectedRecipientIdentityData(prep.expectedRecipientIdentity),
        ...trajectoryAttributionData(prep),
        status: "queued",
        idempotencyKey: identity.idempotencyKey,
        claimToken,
        claimedAt: now,
        lastAttemptAt: now,
        nextAttemptAt: null,
      },
    });
    return {
      kind: "claimed",
      outreach: claimedOutreach(
        created,
        null,
        false,
        freshImmediateClaimRecoveryState(),
      ),
    };
  });
}

async function releasePreparationFailure(
  outreach: ClaimedOutreach,
  error: string,
  disposition: ResendPreparationDisposition = "permanent",
): Promise<AttemptResult> {
  const failure = getOutreachPreparationFailureState(
    outreach.automaticRetry,
    outreach.preparationRetryCount,
    disposition,
    error,
  );
  const released = await db.outreach.updateMany({
    where: {
      id: outreach.id,
      status: "queued",
      claimToken: outreach.claimToken,
      idempotencyKey: outreach.idempotencyKey,
    },
    data: {
      status: failure.status,
      error: failure.storedError,
      nextAttemptAt: failure.nextAttemptAt,
      claimedAt: null,
      claimToken: null,
    },
  });
  if (released.count === 0) {
    return {
      kind: "complete",
      result: {
        ok: false,
        outreachId: outreach.id,
        error: "Outreach claim changed during attachment preparation",
      },
    };
  }
  return {
    kind: "complete",
    result: {
      ok: false,
      outreachId: outreach.id,
      error,
      ...(failure.retryScheduled
        ? {
            retryScheduled: true,
            nextAttemptAt: failure.nextAttemptAt,
          }
        : {}),
    },
  };
}

async function releaseConfigurationOutage(
  outreach: ClaimedOutreach,
  error: string,
): Promise<CompletedResult> {
  const attempt = outreach.attempt;
  if (attempt && isProviderAcceptanceUnresolvedAttempt(attempt)) {
    return withSerializableRetry((tx) =>
      markProviderAcceptanceUncertain(
        tx,
        outreach.id,
        attempt.id,
        `${MANUAL_REVIEW_UNCERTAIN}: current delivery configuration blocks automatic retry (${error})`,
        attempt.failureDisposition === "in_flight" ? "in_flight" : "uncertain",
      ),
    );
  }
  const outage = getOutreachConfigurationOutageState(
    outreach.automaticRetry,
    outreach.attemptCount,
    error,
  );
  const released = await db.outreach.updateMany({
    where: {
      id: outreach.id,
      status: "queued",
      claimToken: outreach.claimToken,
      idempotencyKey: outreach.idempotencyKey,
    },
    data: {
      status: outage.status,
      error: outage.error,
      nextAttemptAt: outage.nextAttemptAt,
      claimedAt: null,
      claimToken: null,
    },
  });
  if (released.count === 0) {
    return {
      kind: "complete",
      result: {
        ok: false,
        outreachId: outreach.id,
        error: "Outreach claim changed during Resend configuration preflight",
      },
    };
  }
  return {
    kind: "complete",
    result: {
      ok: false,
      outreachId: outreach.id,
      error: outage.error,
      ...(outage.retryScheduled
        ? {
            retryScheduled: true,
            nextAttemptAt: outage.nextAttemptAt,
          }
        : {}),
    },
  };
}

async function releaseManualReview(
  outreach: ClaimedOutreach,
  error: string,
  attemptId?: string,
): Promise<AttemptResult> {
  return withSerializableRetry((tx) =>
    markManualReview(tx, outreach.id, error, attemptId),
  );
}

async function ensureAttempt(outreachInput: ClaimedOutreach): Promise<AttemptResult> {
  if (outreachInput.attempt) {
    return {
      kind: "ready",
      outreach: outreachInput,
      attempt: outreachInput.attempt,
      warnings: [],
      rateCardAttachmentOmitted: false,
    };
  }
  if (outreachInput.attemptCount > 0 || outreachInput.providerMessageId) {
    return releaseManualReview(outreachInput, MANUAL_REVIEW_LEGACY);
  }
  if (outreachInput.recipientEmails.length === 0) {
    return releasePreparationFailure(
      outreachInput,
      "No unsuppressed valid recipient snapshot is available",
    );
  }
  const outreach = outreachInput;

  const attemptId = attemptIdFromKey(outreach.id, outreach.idempotencyKey);
  if (!attemptId) {
    return releasePreparationFailure(
      outreach,
      "Outreach idempotency key does not identify an immutable attempt",
    );
  }

  const prepared = await prepareResendRequest({
    to: outreach.recipientEmails,
    subject: outreach.finalSubject,
    html: outreach.finalHtml,
    outreachId: outreach.id,
    attemptId,
    idempotencyKey: outreach.idempotencyKey,
  });
  if (!prepared.ok) {
    return releasePreparationFailure(
      outreach,
      prepared.error,
      prepared.preparationDisposition,
    );
  }

  return withSerializableRetry(async (tx) => {
    const current = await tx.outreach.findUnique({
      where: { id: outreach.id },
      include: { show: { select: { syncStatus: true } } },
    });
    if (
      !current ||
      current.status !== "queued" ||
      current.claimToken !== outreach.claimToken ||
      current.idempotencyKey !== outreach.idempotencyKey
    ) {
      return {
        kind: "complete",
        result: {
          ok: false,
          outreachId: outreach.id,
          error: "Outreach claim changed before the provider request was persisted",
        },
      };
    }
    if (current.show.syncStatus !== "active") {
      const error = showInactiveError(current.show.syncStatus);
      await tx.outreach.update({
        where: { id: current.id },
        data: {
          status: "cancelled",
          error,
          scheduledFor: null,
          nextAttemptAt: null,
          claimedAt: null,
          claimToken: null,
        },
      });
      return {
        kind: "complete",
        result: { ok: false, outreachId: current.id, error },
      };
    }
    const association = await tx.showArtist.findUnique({
      where: {
        showId_artistId: {
          showId: current.showId,
          artistId: current.artistId,
        },
      },
      select: { showId: true },
    });
    if (!association) {
      const error = artistNotOnShowError();
      await tx.outreach.update({
        where: { id: current.id },
        data: {
          status: "cancelled",
          error,
          scheduledFor: null,
          nextAttemptAt: null,
          claimedAt: null,
          claimToken: null,
        },
      });
      return {
        kind: "complete",
        result: { ok: false, outreachId: current.id, error },
      };
    }

    for (const blob of prepared.attachmentBlobs) {
      const existingBlob = await tx.outreachAttachmentBlob.findUnique({
        where: { sha256: blob.sha256 },
      });
      if (existingBlob) {
        if (
          existingBlob.byteLength !== blob.byteLength ||
          existingBlob.content.byteLength !== blob.byteLength ||
          hashAttachmentContent(existingBlob.content) !== blob.sha256
        ) {
          const error =
            "Stored attachment blob contradicts its content-addressed identity";
          await tx.outreach.update({
            where: { id: current.id },
            data: {
              status: "manual_review",
              error,
              nextAttemptAt: null,
              claimedAt: null,
              claimToken: null,
            },
          });
          return {
            kind: "complete",
            result: { ok: false, outreachId: current.id, error },
          };
        }
      } else {
        await tx.outreachAttachmentBlob.create({
          data: {
            sha256: blob.sha256,
            content: blob.content,
            byteLength: blob.byteLength,
          },
        });
      }
    }

    const existing = await currentAttempt(tx, outreach.idempotencyKey);
    const attempt =
      existing ??
      (await tx.outreachSendAttempt.create({
        data: {
          id: attemptId,
          outreachId: outreach.id,
          status: "prepared",
          idempotencyKey: outreach.idempotencyKey,
          providerRequest: prepared.request as unknown as Prisma.InputJsonValue,
          requestHash: prepared.requestHash,
          testSend: prepared.testSend,
        },
      }));
    return {
      kind: "ready",
      outreach: { ...outreach, attempt },
      attempt,
      warnings: prepared.warnings,
      rateCardAttachmentOmitted: prepared.rateCardAttachmentOmitted,
    };
  });
}

async function recoverUncertainProviderTransaction(
  outreach: ClaimedOutreach,
  attemptId: string,
  error: unknown,
): Promise<StartedAttempt> {
  const detail = error instanceof Error ? error.message : String(error);
  const reviewError = `${MANUAL_REVIEW_UNCERTAIN}: provider submission transaction did not complete cleanly (${detail})`;
  return withSerializableRetry(async (tx) => {
    const attempt = await tx.outreachSendAttempt.findUnique({
      where: { id: attemptId },
    });
    if (!attempt) {
      return {
        kind: "complete",
        result: {
          ok: false,
          outreachId: outreach.id,
          error: reviewError,
        },
      };
    }
    if (attempt.providerMessageId) {
      return finishAlreadyAccepted(tx, outreach, attempt);
    }
    return markProviderAcceptanceUncertain(
      tx,
      outreach.id,
      attempt.id,
      reviewError,
      attempt.failureDisposition === "in_flight" ? "in_flight" : "uncertain",
    );
  });
}

async function claimAttemptForSending(
  outreach: ClaimedOutreach,
  attemptInput: StoredAttempt,
): Promise<SendingClaimResult> {
  for (let transactionAttempt = 0; transactionAttempt < 4; transactionAttempt += 1) {
    try {
      return await db.$transaction(
        async (tx): Promise<SendingClaimResult> => {
          const now = new Date();
          await tx.$queryRaw<Array<{ id: string }>>(
            Prisma.sql`
              SELECT "id"
              FROM "Outreach"
              WHERE "id" = ${outreach.id}
              FOR UPDATE
            `,
          );
          await tx.$queryRaw<Array<{ id: string }>>(
            Prisma.sql`
              SELECT "id"
              FROM "OutreachSendAttempt"
              WHERE "id" = ${attemptInput.id}
              FOR UPDATE
            `,
          );
          const current = await tx.outreach.findUnique({
            where: { id: outreach.id },
          });
          const attempt = await tx.outreachSendAttempt.findUnique({
            where: { id: attemptInput.id },
          });
          if (
            !current ||
            !attempt ||
            current.status !== "queued" ||
            current.claimToken !== outreach.claimToken ||
            current.idempotencyKey !== attempt.idempotencyKey
          ) {
            return {
              kind: "complete",
              result: {
                ok: false,
                outreachId: outreach.id,
                error:
                  "Outreach claim changed before the provider request started",
              },
            };
          }
          if (attempt.providerMessageId) {
            return finishAlreadyAccepted(tx, current, attempt);
          }
          const retryBlocked = await applyRetryDecision(
            tx,
            current.id,
            attempt,
            now,
          );
          if (retryBlocked) return retryBlocked;

          const lockedPolicy = await evaluateLockedOutreachDeliveryPolicy(
            tx,
            {
              ...current,
              expectedRecipientIdentity: outreach.expectedRecipientIdentity,
            },
            attempt,
          );
          const policy = lockedPolicy.decision;
          if (!policy.ok) {
            return applyDeliveryPolicyDecision(
              tx,
              {
                id: current.id,
                attemptCount: current.attemptCount,
                automaticRetry: outreach.automaticRetry,
              },
              attempt,
              policy,
              now,
            );
          }
          const submissionCredential = lockedPolicy.submissionCredential;
          if (!submissionCredential) {
            return applyDeliveryPolicyDecision(
              tx,
              {
                id: current.id,
                attemptCount: current.attemptCount,
                automaticRetry: outreach.automaticRetry,
              },
              attempt,
              {
                ok: false,
                state: "configuration",
                error: RESEND_CONFIGURATION_ERROR,
              },
              now,
            );
          }
          const credentialScopeConflict = getResendCredentialScopeConflict(
            attempt,
            submissionCredential.scope,
          );
          if (credentialScopeConflict) {
            return isProviderAcceptanceUnresolvedAttempt(attempt)
              ? markProviderAcceptanceUncertain(
                  tx,
                  current.id,
                  attempt.id,
                  credentialScopeConflict,
                  attempt.failureDisposition === "in_flight"
                    ? "in_flight"
                    : "uncertain",
                )
              : markManualReview(
                  tx,
                  current.id,
                  credentialScopeConflict,
                  attempt.id,
                );
          }
          if (!policy.request || !attempt.requestHash) {
            return markManualReview(
              tx,
              current.id,
              "Stored Resend request failed its identity or integrity check",
              attempt.id,
            );
          }

          const configurationRecovery = attemptRecoveryState(attempt);
          // This transaction commits the credential binding before the
          // separate submission transaction can call Resend.
          const claimedAttempt = await tx.outreachSendAttempt.update({
            where: { id: attempt.id },
            data: {
              status: "sending",
              nextAttemptAt: null,
              lastAttemptAt: now,
              providerCredentialScope:
                attempt.providerCredentialScope ?? submissionCredential.scope,
            },
          });
          await tx.outreach.update({
            where: { id: current.id },
            data: {
              error: null,
              lastAttemptAt: now,
            },
          });
          return {
            kind: "ready",
            attempt: claimedAttempt,
            configurationRecovery,
          };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          maxWait: 10_000,
          timeout: OUTREACH_PROVIDER_TRANSACTION_TIMEOUT_MS,
        },
      );
    } catch (error) {
      if (
        transactionAttempt < 3 &&
        isRetryableOutreachTransactionError(error)
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("Unable to claim outreach provider attempt");
}

async function restoreUnsubmittedClaimFailure(
  outreach: ClaimedOutreach,
  attemptId: string,
  attemptRecovery: OutreachAttemptRecoveryState,
  error: unknown,
): Promise<StartedAttempt> {
  const detail = error instanceof Error ? error.message : String(error);
  const recoveryError = `Provider submission did not start after the sending claim: ${detail}`;
  return withSerializableRetry(async (tx) => {
    await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`
        SELECT "id"
        FROM "Outreach"
        WHERE "id" = ${outreach.id}
        FOR UPDATE
      `,
    );
    await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`
        SELECT "id"
        FROM "OutreachSendAttempt"
        WHERE "id" = ${attemptId}
        FOR UPDATE
      `,
    );
    const current = await tx.outreach.findUnique({
      where: { id: outreach.id },
    });
    const attempt = await tx.outreachSendAttempt.findUnique({
      where: { id: attemptId },
    });
    if (
      !current ||
      current.status !== "queued" ||
      current.claimToken !== outreach.claimToken ||
      current.idempotencyKey !== outreach.idempotencyKey ||
      (attempt !== null &&
        attempt.idempotencyKey !== outreach.idempotencyKey)
    ) {
      return {
        kind: "complete",
        result: {
          ok: false,
          outreachId: outreach.id,
          error:
            "Outreach claim changed before the unsubmitted provider attempt could be restored",
        },
      };
    }
    if (attempt?.providerMessageId) {
      return finishAlreadyAccepted(tx, current, attempt);
    }

    if (attempt) {
      await tx.outreachSendAttempt.update({
        where: { id: attempt.id },
        data: getOutreachConfigurationAttemptRecoveryData(attemptRecovery),
      });
    }
    await tx.outreach.update({
      where: { id: current.id },
      data: getOutreachClaimRecoveryData(outreach.claimRecovery),
    });
    return {
      kind: "complete",
      result: {
        ok: false,
        outreachId: outreach.id,
        error: recoveryError,
        ...(outreach.automaticRetry
          ? {
              retryScheduled: true,
              ...(outreach.claimRecovery.nextAttemptAt
                ? { nextAttemptAt: outreach.claimRecovery.nextAttemptAt }
                : {}),
            }
          : {}),
      },
    };
  });
}

async function submitClaimedAttempt(
  outreach: ClaimedOutreach,
  attemptInput: StoredAttempt,
  configurationRecovery: OutreachAttemptRecoveryState,
): Promise<StartedAttempt> {
  for (let transactionAttempt = 0; transactionAttempt < 4; transactionAttempt += 1) {
    let providerSubmissionStarted = false;
    try {
      return await db.$transaction(
        async (tx): Promise<StartedAttempt> => {
          const now = new Date();
          await tx.$queryRaw<Array<{ id: string }>>(
            Prisma.sql`
              SELECT "id"
              FROM "Outreach"
              WHERE "id" = ${outreach.id}
              FOR UPDATE
            `,
          );
          await tx.$queryRaw<Array<{ id: string }>>(
            Prisma.sql`
              SELECT "id"
              FROM "OutreachSendAttempt"
              WHERE "id" = ${attemptInput.id}
              FOR UPDATE
            `,
          );
          const current = await tx.outreach.findUnique({
            where: { id: outreach.id },
          });
          const attempt = await tx.outreachSendAttempt.findUnique({
            where: { id: attemptInput.id },
          });
          if (
            !current ||
            !attempt ||
            current.status !== "queued" ||
            current.claimToken !== outreach.claimToken ||
            current.idempotencyKey !== attempt.idempotencyKey ||
            attempt.status !== "sending"
          ) {
            return {
              kind: "complete",
              result: {
                ok: false,
                outreachId: outreach.id,
                error:
                  "Outreach claim changed before the provider request started",
              },
            };
          }
          if (attempt.providerMessageId) {
            return finishAlreadyAccepted(tx, current, attempt);
          }

          const lockedPolicy = await evaluateLockedOutreachDeliveryPolicy(
            tx,
            {
              ...current,
              expectedRecipientIdentity: outreach.expectedRecipientIdentity,
            },
            attempt,
          );
          const policy = lockedPolicy.decision;
          if (!policy.ok) {
            return applyDeliveryPolicyDecision(
              tx,
              {
                id: current.id,
                attemptCount: current.attemptCount,
                automaticRetry: outreach.automaticRetry,
              },
              attempt,
              policy,
              now,
              configurationRecovery,
            );
          }
          const submissionCredential = lockedPolicy.submissionCredential;
          if (!submissionCredential) {
            return applyDeliveryPolicyDecision(
              tx,
              {
                id: current.id,
                attemptCount: current.attemptCount,
                automaticRetry: outreach.automaticRetry,
              },
              attempt,
              {
                ok: false,
                state: "configuration",
                error: RESEND_CONFIGURATION_ERROR,
              },
              now,
              configurationRecovery,
            );
          }
          const credentialScopeConflict = getResendCredentialScopeConflict(
            attempt,
            submissionCredential.scope,
          );
          if (credentialScopeConflict) {
            return markProviderAcceptanceUncertain(
              tx,
              current.id,
              attempt.id,
              credentialScopeConflict,
              attempt.failureDisposition === "in_flight"
                ? "in_flight"
                : "uncertain",
            );
          }
          if (!policy.request || !attempt.requestHash) {
            return markManualReview(
              tx,
              current.id,
              "Stored Resend request failed its identity or integrity check",
              attempt.id,
            );
          }
          if (attempt.testSend === null) {
            return markManualReview(
              tx,
              current.id,
              "Legacy provider attempt has no verified real/test classification",
              attempt.id,
            );
          }

          const attachmentRows =
            policy.request.attachments.length === 0
              ? []
              : await tx.outreachAttachmentBlob.findMany({
                  where: {
                    sha256: {
                      in: policy.request.attachments.map(
                        (attachment) => attachment.contentSha256,
                      ),
                    },
                  },
                });
          const blobsByHash = new Map(
            attachmentRows.map((blob) => [blob.sha256, blob]),
          );
          const attachmentBlobs: ResendAttachmentBlob[] = [];
          for (const attachment of policy.request.attachments) {
            const blob = blobsByHash.get(attachment.contentSha256);
            if (
              !blob ||
              blob.byteLength !== attachment.byteLength ||
              blob.content.byteLength !== attachment.byteLength ||
              hashAttachmentContent(blob.content) !== attachment.contentSha256
            ) {
              const error =
                "Stored Resend attachment failed its identity or integrity check";
              return markManualReview(tx, current.id, error, attempt.id);
            }
            attachmentBlobs.push(blob);
          }

          await tx.outreachSendAttempt.update({
            where: { id: attempt.id },
            data: {
              status: "sending",
              error: null,
              failureDisposition: null,
              nextAttemptAt: null,
              firstAttemptAt: attempt.firstAttemptAt ?? now,
              lastAttemptAt: now,
              attemptCount: { increment: 1 },
            },
          });
          await tx.outreach.update({
            where: { id: current.id },
            data: {
              error: null,
              lastAttemptAt: now,
              attemptCount: { increment: 1 },
            },
          });

          // Policy row/advisory locks remain held until the provider call
          // returns, so a suppression cannot commit and be acknowledged first.
          providerSubmissionStarted = true;
          const result = await sendPreparedEmailViaResend(
            policy.request,
            attempt.requestHash,
            attachmentBlobs,
            submissionCredential,
          );
          return {
            kind: "ready",
            request: policy.request,
            requestHash: attempt.requestHash,
            testSend: attempt.testSend,
            attachmentBlobs,
            result,
          };
        },
        {
          // A mutation that wins a policy lock first must be visible after
          // this transaction waits; transaction-wide snapshots would be stale.
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          maxWait: 10_000,
          timeout: OUTREACH_PROVIDER_TRANSACTION_TIMEOUT_MS,
        },
      );
    } catch (error) {
      if (
        !providerSubmissionStarted &&
        transactionAttempt < 3 &&
        isRetryableOutreachTransactionError(error)
      ) {
        continue;
      }
      if (providerSubmissionStarted) {
        return recoverUncertainProviderTransaction(
          outreach,
          attemptInput.id,
          error,
        );
      }
      return restoreUnsubmittedClaimFailure(
        outreach,
        attemptInput.id,
        configurationRecovery,
        error,
      );
    }
  }
  return restoreUnsubmittedClaimFailure(
    outreach,
    attemptInput.id,
    configurationRecovery,
    new Error("Unable to submit claimed outreach provider attempt"),
  );
}

async function startAttempt(
  outreach: ClaimedOutreach,
  attemptInput: StoredAttempt,
): Promise<StartedAttempt> {
  let claimed: SendingClaimResult;
  try {
    claimed = await claimAttemptForSending(outreach, attemptInput);
  } catch (error) {
    return restoreUnsubmittedClaimFailure(
      outreach,
      attemptInput.id,
      attemptRecoveryState(attemptInput),
      error,
    );
  }
  if (claimed.kind === "complete") return claimed;
  return submitClaimedAttempt(
    outreach,
    claimed.attempt,
    claimed.configurationRecovery,
  );
}

async function finishClaimedSend(
  outreach: ClaimedOutreach,
  attemptId: string,
  testSend: boolean,
  result: Awaited<ReturnType<typeof sendPreparedEmailViaResend>>,
  warnings: string[],
  rateCardAttachmentOmitted: boolean,
): Promise<SendOutreachOutput> {
  const completedAt = new Date();
  const outputMetadata = {
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(rateCardAttachmentOmitted ? { rateCardAttachmentOmitted: true } : {}),
  };
  return withSerializableRetry(async (tx) => {
    const [current, attempt] = await Promise.all([
      tx.outreach.findUnique({ where: { id: outreach.id } }),
      tx.outreachSendAttempt.findUnique({ where: { id: attemptId } }),
    ]);
    if (!current || !attempt) {
      return {
        ok: false,
        outreachId: outreach.id,
        error: "Provider attempt disappeared before completion",
        ...outputMetadata,
      };
    }

    const providerOwner = result.providerMessageId
      ? await tx.outreachSendAttempt.findUnique({
          where: { providerMessageId: result.providerMessageId },
          select: { id: true },
        })
      : null;
    if (
      (providerOwner && providerOwner.id !== attempt.id) ||
      (result.providerMessageId &&
        attempt.providerMessageId &&
        result.providerMessageId !== attempt.providerMessageId)
    ) {
      const error =
        "Resend returned a provider message ID that contradicts the immutable attempt";
      await tx.outreachSendAttempt.update({
        where: { id: attempt.id },
        data: {
          status: "manual_review",
          error,
          failureDisposition: "policy",
          nextAttemptAt: null,
        },
      });
      await tx.outreach.updateMany({
        where: { id: current.id, idempotencyKey: attempt.idempotencyKey },
        data: {
          status: "manual_review",
          error,
          nextAttemptAt: null,
          claimedAt: null,
          claimToken: null,
        },
      });
      return { ok: false, outreachId: current.id, error, ...outputMetadata };
    }

    const providerMessageId =
      attempt.providerMessageId ?? result.providerMessageId;
    if (providerMessageId) {
      if (attempt.status === "delivery_failed") {
        const error =
          attempt.error ??
          "Resend accepted the request but later reported delivery failure";
        await tx.outreachSendAttempt.update({
          where: { id: attempt.id },
          data: {
            status: "delivery_failed",
            error,
            failureDisposition: null,
            nextAttemptAt: null,
            providerMessageId,
            acceptedAt: attempt.acceptedAt ?? completedAt,
          },
        });
        await tx.outreach.updateMany({
          where: { id: current.id, idempotencyKey: attempt.idempotencyKey },
          data: getAcceptedDeliveryFailureOutreachState(
            testSend,
            error,
            providerMessageId,
            attempt.acceptedAt ?? completedAt,
          ),
        });
        return { ok: false, outreachId: current.id, error, ...outputMetadata };
      }
      await tx.outreachSendAttempt.update({
        where: { id: attempt.id },
        data: {
          status: "accepted",
          error: null,
          failureDisposition: null,
          nextAttemptAt: null,
          providerMessageId,
          acceptedAt: attempt.acceptedAt ?? completedAt,
        },
      });
      await tx.outreach.updateMany({
        where: { id: current.id, idempotencyKey: attempt.idempotencyKey },
        data: {
          status: testSend ? "test" : "sent",
          error: null,
          providerMessageId,
          sentAt: attempt.acceptedAt ?? completedAt,
          scheduledFor: null,
          nextAttemptAt: null,
          claimedAt: null,
          claimToken: null,
        },
      });
      return { ok: true, outreachId: current.id, ...outputMetadata };
    }

    const error = result.error ?? "Resend request failed without an error";
    const disposition: ResendFailureDisposition =
      result.failureDisposition ?? "uncertain";
    if (disposition === "configuration") {
      const outage = getOutreachConfigurationOutageState(
        outreach.automaticRetry,
        attempt.attemptCount,
        error,
        completedAt,
      );
      const released = await tx.outreach.updateMany({
        where: {
          id: current.id,
          idempotencyKey: attempt.idempotencyKey,
          status: "queued",
          claimToken: outreach.claimToken,
        },
        data: {
          status: outage.status,
          error: outage.error,
          nextAttemptAt: outage.nextAttemptAt,
          claimedAt: null,
          claimToken: null,
        },
      });
      if (released.count === 0) {
        return {
          ok: false,
          outreachId: current.id,
          error: "Outreach claim changed while Resend configuration was unavailable",
          ...outputMetadata,
        };
      }
      await tx.outreachSendAttempt.update({
        where: { id: attempt.id },
        data: {
          status: "request_failed",
          error,
          failureDisposition: "configuration",
          nextAttemptAt: outage.nextAttemptAt,
        },
      });
      return {
        ok: false,
        outreachId: current.id,
        error: outage.error,
        ...(outage.retryScheduled
          ? {
              retryScheduled: true,
              nextAttemptAt: outage.nextAttemptAt,
            }
          : {}),
        ...outputMetadata,
      };
    }
    if (disposition === "in_flight") {
      const reachedAttemptCap =
        attempt.attemptCount >= OUTREACH_MAX_SEND_ATTEMPTS;
      const nextAttemptAt = new Date(
        completedAt.getTime() + getOutreachRetryDelayMs(attempt.attemptCount),
      );
      const retryWithinRetention = canRetryResendRequest(
        attempt.firstAttemptAt,
        nextAttemptAt,
      );
      const canScheduleRetry =
        outreach.automaticRetry &&
        !reachedAttemptCap &&
        retryWithinRetention;
      const inFlightError = reachedAttemptCap
        ? `${MANUAL_REVIEW_IN_FLIGHT}: automatic retry attempt cap reached (${OUTREACH_MAX_SEND_ATTEMPTS})`
        : !retryWithinRetention
          ? MANUAL_REVIEW_IN_FLIGHT_EXPIRED
          : `${MANUAL_REVIEW_IN_FLIGHT}: ${error}`;
      await tx.outreachSendAttempt.update({
        where: { id: attempt.id },
        data: {
          status: "request_failed",
          error: inFlightError,
          failureDisposition: "in_flight",
          nextAttemptAt: canScheduleRetry ? nextAttemptAt : null,
        },
      });
      const released = await tx.outreach.updateMany({
        where: {
          id: current.id,
          idempotencyKey: attempt.idempotencyKey,
          status: "queued",
          claimToken: outreach.claimToken,
        },
        data: {
          status: canScheduleRetry ? "retry_scheduled" : "manual_review",
          error: inFlightError,
          nextAttemptAt: canScheduleRetry ? nextAttemptAt : null,
          claimedAt: null,
          claimToken: null,
        },
      });
      if (released.count === 0) {
        return {
          ok: false,
          outreachId: current.id,
          error: "Outreach claim changed while provider acceptance was in flight",
          ...outputMetadata,
        };
      }
      return {
        ok: false,
        error: inFlightError,
        outreachId: current.id,
        ...(canScheduleRetry
          ? { retryScheduled: true, nextAttemptAt }
          : {}),
        ...outputMetadata,
      };
    }
    if (disposition === "uncertain" || disposition === "policy") {
      const reviewError =
        disposition === "uncertain"
          ? `${MANUAL_REVIEW_UNCERTAIN}: ${error}`
          : error;
      if (disposition === "uncertain") {
        const completed = await markProviderAcceptanceUncertain(
          tx,
          current.id,
          attempt.id,
          reviewError,
        );
        return { ...completed.result, ...outputMetadata };
      }
      await tx.outreachSendAttempt.update({
        where: { id: attempt.id },
        data: {
          status: "manual_review",
          error: reviewError,
          failureDisposition: disposition,
          nextAttemptAt: null,
        },
      });
      await tx.outreach.update({
        where: { id: current.id },
        data: {
          status: "manual_review",
          error: reviewError,
          nextAttemptAt: null,
          claimedAt: null,
          claimToken: null,
        },
      });
      return {
        ok: false,
        outreachId: current.id,
        error: reviewError,
        ...outputMetadata,
      };
    }

    const reachedAttemptCap =
      disposition === "retryable" &&
      attempt.attemptCount >= OUTREACH_MAX_SEND_ATTEMPTS;
    const nextAttemptAt = new Date(
      completedAt.getTime() + getOutreachRetryDelayMs(attempt.attemptCount),
    );
    const canScheduleRetry =
      disposition === "retryable" &&
      outreach.automaticRetry &&
      !reachedAttemptCap &&
      canRetryResendRequest(attempt.firstAttemptAt, nextAttemptAt);
    if (
      disposition === "retryable" &&
      outreach.automaticRetry &&
      !reachedAttemptCap &&
      !canScheduleRetry
    ) {
      await tx.outreachSendAttempt.update({
        where: { id: attempt.id },
        data: {
          status: "manual_review",
          error: MANUAL_REVIEW_EXPIRED,
          failureDisposition: "retryable",
          nextAttemptAt: null,
        },
      });
      await tx.outreach.updateMany({
        where: { id: current.id, idempotencyKey: attempt.idempotencyKey },
        data: {
          status: "manual_review",
          error: MANUAL_REVIEW_EXPIRED,
          nextAttemptAt: null,
          claimedAt: null,
          claimToken: null,
        },
      });
      return {
        ok: false,
        outreachId: current.id,
        error: MANUAL_REVIEW_EXPIRED,
        ...outputMetadata,
      };
    }

    const terminalError = reachedAttemptCap
      ? `Automatic retry attempt cap reached (${OUTREACH_MAX_SEND_ATTEMPTS}): ${error}`
      : error;
    await tx.outreachSendAttempt.update({
      where: { id: attempt.id },
      data: {
        status: "request_failed",
        error: terminalError,
        failureDisposition: disposition,
        nextAttemptAt: canScheduleRetry ? nextAttemptAt : null,
      },
    });
    const released = await tx.outreach.updateMany({
      where: {
        id: current.id,
        idempotencyKey: attempt.idempotencyKey,
        status: "queued",
        claimToken: outreach.claimToken,
      },
      data: {
        status: canScheduleRetry ? "retry_scheduled" : "failed",
        error: terminalError,
        nextAttemptAt: canScheduleRetry ? nextAttemptAt : null,
        claimedAt: null,
        claimToken: null,
      },
    });
    if (released.count === 0) {
      return {
        ok: false,
        outreachId: current.id,
        error: "Outreach claim changed while the provider request was running",
        ...outputMetadata,
      };
    }
    return {
      ok: false,
      error: terminalError,
      outreachId: current.id,
      ...(canScheduleRetry
        ? { retryScheduled: true, nextAttemptAt }
        : {}),
      ...outputMetadata,
    };
  });
}

async function executeClaimedSend(
  outreach: ClaimedOutreach,
): Promise<SendOutreachOutput> {
  const configurationError = getResendConfigurationError(
    process.env.RESEND_API_KEY,
    process.env.RESEND_FROM_EMAIL,
  );
  if (configurationError) {
    const released = await releaseConfigurationOutage(outreach, configurationError);
    return released.result;
  }

  const ensured = await ensureAttempt(outreach);
  if (ensured.kind === "complete") return ensured.result;

  const postPreparationConfigurationError = getResendConfigurationError(
    process.env.RESEND_API_KEY,
    process.env.RESEND_FROM_EMAIL,
  );
  if (postPreparationConfigurationError) {
    const released = await releaseConfigurationOutage(
      ensured.outreach,
      postPreparationConfigurationError,
    );
    return released.result;
  }

  const started = await startAttempt(ensured.outreach, ensured.attempt);
  if (started.kind === "complete") return started.result;

  return finishClaimedSend(
    ensured.outreach,
    ensured.attempt.id,
    started.testSend,
    started.result,
    ensured.warnings,
    ensured.rateCardAttachmentOmitted,
  );
}

export async function sendOutreach(
  input: SendOutreachInput,
): Promise<SendOutreachOutput> {
  const configurationError = getResendConfigurationError(
    process.env.RESEND_API_KEY,
    process.env.RESEND_FROM_EMAIL,
  );
  if (configurationError) return { ok: false, error: configurationError };

  const prep = await prepareOriginalOutreach(input);
  if ("error" in prep) return { ok: false, ...prep };
  const claim = await claimImmediateOutreach(prep);
  if (claim.kind === "complete") return claim.result;
  return executeClaimedSend(claim.outreach);
}

export async function sendFollowUp(
  parentOutreachId: string,
  trajectoryContext?: TrajectoryActionContext,
): Promise<SendOutreachOutput> {
  const configurationError = getResendConfigurationError(
    process.env.RESEND_API_KEY,
    process.env.RESEND_FROM_EMAIL,
  );
  if (configurationError) return { ok: false, error: configurationError };

  const prep = await prepareFollowUpOutreach(
    parentOutreachId,
    trajectoryContext,
  );
  if ("error" in prep) return { ok: false, ...prep };
  const claim = await claimImmediateOutreach(prep);
  if (claim.kind === "complete") return claim.result;
  return executeClaimedSend(claim.outreach);
}

async function schedulePreparedOutreach(
  prep: PreparedOutreach,
  scheduledFor: Date,
): Promise<SendOutreachOutput> {
  const now = new Date();

  return withSerializableRetry(async (tx): Promise<SendOutreachOutput> => {
    const [show, association] = await Promise.all([
      tx.show.findUnique({
        where: { id: prep.showId },
        select: {
          syncStatus: true,
          isFestival: true,
          date: true,
          festivalNycStatus: true,
          dismissedAt: true,
        },
      }),
      tx.showArtist.findUnique({
        where: {
          showId_artistId: {
            showId: prep.showId,
            artistId: prep.artistId,
          },
        },
        select: { showId: true },
      }),
    ]);
    if (!show) return { ok: false, error: "Show not found" };
    const templatePurposeBlocked = preparedTemplatePurposeBlockingReason(
      show,
      prep,
    );
    if (templatePurposeBlocked) {
      return { ok: false, error: templatePurposeBlocked };
    }
    if (show.syncStatus !== "active") {
      return { ok: false, error: showInactiveError(show.syncStatus) };
    }
    const festivalBlocked = festivalOutreachBlockingReason(show, prep.kind);
    if (festivalBlocked) return { ok: false, error: festivalBlocked };
    if (!association) return { ok: false, error: artistNotOnShowError() };
    const followUpBlocked = await preparedFollowUpBlockingReason(tx, prep);
    if (followUpBlocked) return { ok: false, error: followUpBlocked };
    const trajectoryBlocked = await preparedTrajectoryBlockingReason(
      tx,
      prep,
      now,
    );
    if (trajectoryBlocked) return { ok: false, ...trajectoryBlocked };
    const policyBlocked = await preparedDeliveryPolicyBlockingReason(tx, prep);
    if (policyBlocked) return { ok: false, error: policyBlocked };

    const active = await tx.outreach.findMany({
      where: {
        ...preparedOutreachScopeWhere(prep),
        status: {
          in: [
            "sent",
            "scheduled",
            "retry_scheduled",
            "queued",
            "failed",
            "manual_review",
          ],
        },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const currentAttempts = new Map(
      (
        await tx.outreachSendAttempt.findMany({
          where: {
            idempotencyKey: {
              in: active.map((row) => row.idempotencyKey),
            },
          },
        })
      ).map((attempt) => [attempt.idempotencyKey, attempt]),
    );
    const sent = active.find((row) => row.status === "sent");
    if (sent) {
      return {
        ok: false,
        error: `${preparedOutreachName(prep.kind)} already sent`,
        outreachId: sent.id,
      };
    }
    const scheduled = active.find((row) => row.status === "scheduled");
    if (scheduled) {
      if (
        scheduled.contactId === prep.contactId &&
        scheduled.templateId === prep.templateId &&
        scheduled.finalSubject === prep.subject &&
        scheduled.finalHtml === prep.html &&
        scheduled.fullTeamSend === prep.fullTeamSend &&
        scheduled.recipientSnapshotState === "verified" &&
        sameEmails(scheduled.recipientEmails, prep.recipients) &&
        sameExpectedRecipientIdentity(
          scheduled,
          prep.expectedRecipientIdentity,
        ) &&
        scheduled.scheduledFor?.getTime() === scheduledFor.getTime()
      ) {
        const recommendationId = resolveTrajectoryRecommendationAttribution(
          prep.trajectoryContext?.recommendationId ?? null,
          prep.trajectoryRecommendationId,
          scheduled.trajectoryRecommendationId,
        );
        if (
          recommendationId &&
          recommendationId !== scheduled.trajectoryRecommendationId
        ) {
          await tx.outreach.update({
            where: { id: scheduled.id },
            data: { trajectoryRecommendationId: recommendationId },
          });
        }
        return {
          ok: true,
          outreachId: scheduled.id,
          scheduled: true,
          scheduledFor,
        };
      }
      return {
        ok: false,
        error: `${preparedOutreachName(prep.kind)} already scheduled`,
        outreachId: scheduled.id,
      };
    }
    const retryScheduled = active.find(
      (row) => row.status === "retry_scheduled",
    );
    if (retryScheduled) {
      return {
        ok: false,
        error: "Automatic retry is already scheduled",
        outreachId: retryScheduled.id,
      };
    }
    const manualReview = active.find(
      (row) =>
        row.status === "manual_review" &&
        !isNonBlockingLegacyUnknownAttempt(
          currentAttempts.get(row.idempotencyKey),
        ) &&
        !isDefinitiveConfigurationRejection(
          currentAttempts.get(row.idempotencyKey),
        ),
    );
    if (manualReview) {
      return {
        ok: false,
        error: manualReview.error ?? "A previous send requires manual review",
        outreachId: manualReview.id,
      };
    }
    const queued = active.find((row) => row.status === "queued");
    if (queued) {
      if (!isStaleOutreachClaim(queued.claimedAt, now)) {
        return {
          ok: false,
          error: "Send already in progress",
          outreachId: queued.id,
        };
      }
      if (queued.contactId !== prep.contactId) {
        return {
          ok: false,
          error:
            "A previous queued send must be recovered with its original contact",
          outreachId: queued.id,
        };
      }

      const attempt = await currentAttempt(tx, queued.idempotencyKey);
      if (attempt?.providerMessageId) {
        return (await finishAlreadyAccepted(tx, queued, attempt)).result;
      }
      if (attempt) {
        const snapshotConflict = recipientSnapshotConflict(
          queued,
          prep.recipients,
          prep.fullTeamSend,
        );
        if (snapshotConflict) {
          return (
            await markManualReview(
              tx,
              queued.id,
              snapshotConflict,
              attempt.id,
            )
          ).result;
        }
        const blocked = await applyRetryDecision(
          tx,
          queued.id,
          attempt,
          scheduledFor,
        );
        if (blocked) return blocked.result;
      } else if (!canReplaceUnattemptedOutreachSnapshot(queued, false)) {
        return (
          await markManualReview(tx, queued.id, MANUAL_REVIEW_LEGACY)
        ).result;
      }

      let idempotencyKey = queued.idempotencyKey;
      if (!attempt && !attemptIdFromKey(queued.id, idempotencyKey)) {
        idempotencyKey = newAttemptIdentity(queued.id).idempotencyKey;
      }
      const outreach = await tx.outreach.update({
        where: { id: queued.id },
        data: {
          status: attempt ? "retry_scheduled" : "scheduled",
          error: null,
          scheduledFor,
          nextAttemptAt: scheduledFor,
          claimedAt: null,
          claimToken: null,
          idempotencyKey,
          ...trajectoryAttributionData(
            prep,
            queued.trajectoryRecommendationId,
          ),
          ...(!attempt
            ? {
                finalSubject: prep.subject,
                finalHtml: prep.html,
                recipientEmails: prep.recipients,
                recipientSnapshotState: "verified",
                fullTeamSend: prep.fullTeamSend,
                templateId: prep.templateId,
                ...expectedRecipientIdentityData(
                  prep.expectedRecipientIdentity,
                ),
              }
            : {}),
        },
      });
      return {
        ok: true,
        outreachId: outreach.id,
        scheduled: true,
        scheduledFor,
      };
    }
    const failedForAnotherContact = active.find(
      (row) =>
        row.status === "failed" &&
        row.contactId !== prep.contactId &&
        !isNonBlockingLegacyUnknownAttempt(
          currentAttempts.get(row.idempotencyKey),
        ) &&
        !isDefinitiveConfigurationRejection(
          currentAttempts.get(row.idempotencyKey),
        ) &&
        hasProtectedCurrentSendState(
          row,
          currentAttempts.has(row.idempotencyKey),
        ),
    );
    if (failedForAnotherContact) {
      return {
        ok: false,
        error:
          "A previous failed send for this artist must be recovered with its original recipient snapshot",
        outreachId: failedForAnotherContact.id,
      };
    }

    const existing = await tx.outreach.findUnique({
      where: preparedOutreachUniqueWhere(prep),
    });
    const existingAttempt = existing
      ? await currentAttempt(tx, existing.idempotencyKey)
      : null;
    if (
      existing &&
      existingAttempt?.providerMessageId &&
      existingAttempt.testSend !== true
    ) {
      return (await finishAlreadyAccepted(tx, existing, existingAttempt)).result;
    }
    if (
      existing &&
      existingAttempt &&
      isDefinitiveConfigurationRejection(existingAttempt)
    ) {
      const retired = await retireDefinitiveConfigurationAttempt(
        tx,
        existingAttempt,
      );
      if (!retired) {
        const refreshed = await currentAttempt(tx, existing.idempotencyKey);
        if (refreshed?.providerMessageId) {
          return (await finishAlreadyAccepted(tx, existing, refreshed)).result;
        }
        return (
          await markManualReview(
            tx,
            existing.id,
            "Definitive configuration rejection changed before a fresh provider attempt could be scheduled",
            existingAttempt.id,
          )
        ).result;
      }
      const identity = newAttemptIdentity(existing.id);
      const outreach = await tx.outreach.update({
        where: { id: existing.id },
        data: {
          status: "scheduled",
          error: null,
          finalSubject: prep.subject,
          finalHtml: prep.html,
          recipientEmails: prep.recipients,
          recipientSnapshotState: "verified",
          fullTeamSend: prep.fullTeamSend,
          templateId: prep.templateId,
          ...expectedRecipientIdentityData(prep.expectedRecipientIdentity),
          ...trajectoryAttributionData(
            prep,
            existing.trajectoryRecommendationId,
          ),
          scheduledFor,
          nextAttemptAt: scheduledFor,
          claimedAt: null,
          claimToken: null,
          attemptCount: 0,
          lastAttemptAt: null,
          idempotencyKey: identity.idempotencyKey,
          ...resetDeliveryState(),
        },
      });
      return {
        ok: true,
        outreachId: outreach.id,
        scheduled: true,
        scheduledFor,
      };
    }
    if (existing && isNonBlockingLegacyUnknownAttempt(existingAttempt)) {
      const identity = newAttemptIdentity(existing.id);
      const outreach = await tx.outreach.update({
        where: { id: existing.id },
        data: {
          status: "scheduled",
          error: null,
          finalSubject: prep.subject,
          finalHtml: prep.html,
          recipientEmails: prep.recipients,
          recipientSnapshotState: "verified",
          fullTeamSend: prep.fullTeamSend,
          templateId: prep.templateId,
          ...expectedRecipientIdentityData(prep.expectedRecipientIdentity),
          ...trajectoryAttributionData(
            prep,
            existing.trajectoryRecommendationId,
          ),
          scheduledFor,
          nextAttemptAt: scheduledFor,
          claimedAt: null,
          claimToken: null,
          attemptCount: 0,
          lastAttemptAt: null,
          idempotencyKey: identity.idempotencyKey,
          ...resetDeliveryState(),
        },
      });
      return {
        ok: true,
        outreachId: outreach.id,
        scheduled: true,
        scheduledFor,
      };
    }
    if (existing?.status === "failed") {
      const attempt = existingAttempt;
      if (attempt) {
        const snapshotConflict = recipientSnapshotConflict(
          existing,
          prep.recipients,
          prep.fullTeamSend,
        );
        if (snapshotConflict) {
          const completed = await markManualReview(
            tx,
            existing.id,
            snapshotConflict,
            attempt.id,
          );
          return completed.result;
        }
        const blocked = await applyRetryDecision(
          tx,
          existing.id,
          attempt,
          scheduledFor,
        );
        if (blocked) return blocked.result;
        const outreach = await tx.outreach.update({
          where: { id: existing.id },
          data: {
            status: "retry_scheduled",
            error: null,
            scheduledFor,
            nextAttemptAt: scheduledFor,
            claimedAt: null,
            claimToken: null,
            ...trajectoryAttributionData(
              prep,
              existing.trajectoryRecommendationId,
            ),
          },
        });
        return {
          ok: true,
          outreachId: outreach.id,
          scheduled: true,
          scheduledFor,
        };
      }
      if (!canReplaceUnattemptedOutreachSnapshot(existing, false)) {
        await markManualReview(tx, existing.id, MANUAL_REVIEW_LEGACY);
        return {
          ok: false,
          outreachId: existing.id,
          error: MANUAL_REVIEW_LEGACY,
        };
      }

      const identity = attemptIdFromKey(existing.id, existing.idempotencyKey)
        ? { idempotencyKey: existing.idempotencyKey }
        : newAttemptIdentity(existing.id);
      const outreach = await tx.outreach.update({
        where: { id: existing.id },
        data: {
          status: "scheduled",
          error: null,
          finalSubject: prep.subject,
          finalHtml: prep.html,
          recipientEmails: prep.recipients,
          recipientSnapshotState: "verified",
          fullTeamSend: prep.fullTeamSend,
          templateId: prep.templateId,
          ...expectedRecipientIdentityData(prep.expectedRecipientIdentity),
          ...trajectoryAttributionData(
            prep,
            existing.trajectoryRecommendationId,
          ),
          scheduledFor,
          nextAttemptAt: scheduledFor,
          claimedAt: null,
          claimToken: null,
          idempotencyKey: identity.idempotencyKey,
        },
      });
      return {
        ok: true,
        outreachId: outreach.id,
        scheduled: true,
        scheduledFor,
      };
    }

    if (existing) {
      if (existing.status !== "test" && existing.status !== "cancelled") {
        return {
          ok: false,
          outreachId: existing.id,
          error: `Outreach cannot be scheduled from state ${existing.status}`,
        };
      }
      if (existing.status === "cancelled" && existingAttempt?.providerMessageId) {
        return (await finishAlreadyAccepted(tx, existing, existingAttempt)).result;
      }
      if (
        existing.status === "cancelled" &&
        existingAttempt &&
        !isDefinitivelyUnsentOutreachAttempt(existingAttempt)
      ) {
        return (
          await markProviderAcceptanceUncertain(
            tx,
            existing.id,
            existingAttempt.id,
            MANUAL_REVIEW_UNCERTAIN,
            existingAttempt.failureDisposition === "in_flight"
              ? "in_flight"
              : "uncertain",
          )
        ).result;
      }
      if (
        existing.status === "cancelled" &&
        !existingAttempt &&
        hasProtectedCurrentSendState(existing, false)
      ) {
        return (
          await markManualReview(tx, existing.id, MANUAL_REVIEW_LEGACY)
        ).result;
      }
      const identity = newAttemptIdentity(existing.id);
      const outreach = await tx.outreach.update({
        where: { id: existing.id },
        data: {
          status: "scheduled",
          error: null,
          finalSubject: prep.subject,
          finalHtml: prep.html,
          recipientEmails: prep.recipients,
          recipientSnapshotState: "verified",
          fullTeamSend: prep.fullTeamSend,
          templateId: prep.templateId,
          ...expectedRecipientIdentityData(prep.expectedRecipientIdentity),
          ...trajectoryAttributionData(
            prep,
            existing.trajectoryRecommendationId,
          ),
          scheduledFor,
          nextAttemptAt: scheduledFor,
          claimedAt: null,
          claimToken: null,
          attemptCount: 0,
          lastAttemptAt: null,
          idempotencyKey: identity.idempotencyKey,
          ...resetDeliveryState(),
        },
      });
      return {
        ok: true,
        outreachId: outreach.id,
        scheduled: true,
        scheduledFor,
      };
    }

    const id = randomUUID();
    const identity = newAttemptIdentity(id);
    const outreach = await tx.outreach.create({
      data: {
        id,
        kind: prep.kind,
        parentOutreachId: prep.parentOutreachId,
        showId: prep.showId,
        artistId: prep.artistId,
        contactId: prep.contactId,
        templateId: prep.templateId,
        finalSubject: prep.subject,
        finalHtml: prep.html,
        recipientEmails: prep.recipients,
        recipientSnapshotState: "verified",
        fullTeamSend: prep.fullTeamSend,
        ...expectedRecipientIdentityData(prep.expectedRecipientIdentity),
        ...trajectoryAttributionData(prep),
        status: "scheduled",
        scheduledFor,
        nextAttemptAt: scheduledFor,
        idempotencyKey: identity.idempotencyKey,
      },
    });
    return {
      ok: true,
      outreachId: outreach.id,
      scheduled: true,
      scheduledFor,
    };
  });
}

export async function scheduleOutreach(
  input: SendOutreachInput,
  scheduledFor: Date,
): Promise<SendOutreachOutput> {
  const prep = await prepareOriginalOutreach(input);
  if ("error" in prep) return { ok: false, ...prep };
  return schedulePreparedOutreach(prep, scheduledFor);
}

export async function scheduleFollowUp(
  parentOutreachId: string,
  scheduledFor: Date,
  trajectoryContext?: TrajectoryActionContext,
): Promise<SendOutreachOutput> {
  const prep = await prepareFollowUpOutreach(
    parentOutreachId,
    trajectoryContext,
  );
  if ("error" in prep) return { ok: false, ...prep };
  return schedulePreparedOutreach(prep, scheduledFor);
}

export interface CancelScheduledOutreachResult {
  cancelled: boolean;
  showId: string | null;
}

export async function cancelScheduledOutreach(
  outreachId: string,
  trajectoryContext?: TrajectoryActionContext,
): Promise<CancelScheduledOutreachResult> {
  return withSerializableRetry(async (tx) => {
    const outreach = await tx.outreach.findUnique({
      where: { id: outreachId },
      select: {
        id: true,
        showId: true,
        artistId: true,
        status: true,
        idempotencyKey: true,
      },
    });
    if (!outreach || !isCancellableOutreachStatus(outreach.status)) {
      return {
        cancelled: false,
        showId: outreach?.showId ?? null,
      };
    }
    if (trajectoryContext) {
      if (
        trajectoryContext.showId !== outreach.showId ||
        trajectoryContext.artistId !== outreach.artistId
      ) {
        throw trajectoryActionTargetMismatch();
      }
      await requireActionableTrajectoryRecommendationInTransaction(
        tx,
        trajectoryContext,
      );
    }

    const attempt = await currentAttempt(tx, outreach.idempotencyKey);
    if (attempt?.providerMessageId) {
      await finishAlreadyAccepted(tx, outreach, attempt);
      return { cancelled: true, showId: outreach.showId };
    }
    if (attempt && !isDefinitivelyUnsentOutreachAttempt(attempt)) {
      await markProviderAcceptanceUncertain(
        tx,
        outreach.id,
        attempt.id,
        `${MANUAL_REVIEW_UNCERTAIN}: future retries were cancelled while provider acceptance remained unresolved`,
        attempt.failureDisposition === "in_flight"
          ? "in_flight"
          : "uncertain",
      );
      return { cancelled: true, showId: outreach.showId };
    }

    const cancelled = await tx.outreach.updateMany({
      where: {
        id: outreach.id,
        idempotencyKey: outreach.idempotencyKey,
        status: { in: [...CANCELLABLE_OUTREACH_STATUSES] },
      },
      data: {
        status: "cancelled",
        error: null,
        scheduledFor: null,
        nextAttemptAt: null,
        claimedAt: null,
        claimToken: null,
      },
    });
    if (cancelled.count !== 1) {
      return { cancelled: false, showId: outreach.showId };
    }

    if (attempt) {
      await tx.outreachSendAttempt.update({
        where: { id: attempt.id },
        data: {
          status: "cancelled",
          nextAttemptAt: null,
          ...(attempt.failureDisposition === "configuration"
            ? {}
            : {
                error: DEFINITIVELY_UNSENT_CANCELLATION_ERROR,
                failureDisposition: "policy",
              }),
        },
      });
    }
    return { cancelled: true, showId: outreach.showId };
  });
}

async function claimScheduledOutreach(outreachId: string): Promise<ClaimResult> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - OUTREACH_CLAIM_TIMEOUT_MS);
  return withSerializableRetry(async (tx) => {
    const outreach = await tx.outreach.findUnique({
      where: { id: outreachId },
      include: {
        show: {
          select: {
            syncStatus: true,
            isFestival: true,
            date: true,
            festivalNycStatus: true,
            dismissedAt: true,
          },
        },
        contact: {
          select: {
            id: true,
            artistId: true,
            email: true,
            state: true,
            isFullTeam: true,
          },
        },
        template: {
          select: {
            id: true,
            subject: true,
            htmlBody: true,
            updatedAt: true,
          },
        },
      },
    });
    if (!outreach) {
      return {
        kind: "complete",
        result: { ok: false, outreachId, error: "Outreach not found" },
      };
    }

    const dispatchAt = outreach.nextAttemptAt ?? outreach.scheduledFor;
    const due =
      !!dispatchAt &&
      dispatchAt <= now &&
      (outreach.status === "scheduled" ||
        outreach.status === "retry_scheduled" ||
        (outreach.status === "queued" &&
          (!outreach.claimedAt || outreach.claimedAt <= staleBefore)));
    if (!due) {
      return {
        kind: "complete",
        result: { ok: true, outreachId, skipped: true },
      };
    }

    const attempt = await currentAttempt(tx, outreach.idempotencyKey);
    if (attempt?.providerMessageId) {
      return finishAlreadyAccepted(tx, outreach, attempt);
    }
    if (outreach.show.syncStatus !== "active") {
      const error = showInactiveError(outreach.show.syncStatus);
      if (attempt) {
        return applyDeliveryPolicyDecision(
          tx,
          {
            id: outreach.id,
            attemptCount: outreach.attemptCount,
            automaticRetry: true,
          },
          attempt,
          { ok: false, state: "cancelled", error },
          now,
        );
      }
      await tx.outreach.update({
        where: { id: outreach.id },
        data: {
          status: "cancelled",
          error,
          scheduledFor: null,
          nextAttemptAt: null,
          claimedAt: null,
          claimToken: null,
        },
      });
      return {
        kind: "complete",
        result: { ok: false, outreachId: outreach.id, error },
      };
    }
    const festivalBlocked = festivalOutreachBlockingReason(
      outreach.show,
      outreach.kind,
    );
    if (festivalBlocked) {
      if (attempt) {
        return applyDeliveryPolicyDecision(
          tx,
          {
            id: outreach.id,
            attemptCount: outreach.attemptCount,
            automaticRetry: true,
          },
          attempt,
          { ok: false, state: "cancelled", error: festivalBlocked },
          now,
        );
      }
      await tx.outreach.update({
        where: { id: outreach.id },
        data: {
          status: "cancelled",
          error: festivalBlocked,
          scheduledFor: null,
          nextAttemptAt: null,
          claimedAt: null,
          claimToken: null,
        },
      });
      return {
        kind: "complete",
        result: {
          ok: false,
          outreachId: outreach.id,
          error: festivalBlocked,
        },
      };
    }
    const association = await tx.showArtist.findUnique({
      where: {
        showId_artistId: {
          showId: outreach.showId,
          artistId: outreach.artistId,
        },
      },
      select: { showId: true },
    });
    if (!association) {
      const error = artistNotOnShowError();
      if (attempt) {
        return applyDeliveryPolicyDecision(
          tx,
          {
            id: outreach.id,
            attemptCount: outreach.attemptCount,
            automaticRetry: true,
          },
          attempt,
          { ok: false, state: "cancelled", error },
          now,
        );
      }
      await tx.outreach.update({
        where: { id: outreach.id },
        data: {
          status: "cancelled",
          error,
          scheduledFor: null,
          nextAttemptAt: null,
          claimedAt: null,
          claimToken: null,
        },
      });
      return {
        kind: "complete",
        result: { ok: false, outreachId: outreach.id, error },
      };
    }
    const followUpBlocked = await preparedFollowUpBlockingReason(
      tx,
      outreach,
    );
    if (followUpBlocked) {
      if (attempt) {
        return applyDeliveryPolicyDecision(
          tx,
          {
            id: outreach.id,
            attemptCount: outreach.attemptCount,
            automaticRetry: true,
          },
          attempt,
          { ok: false, state: "cancelled", error: followUpBlocked },
          now,
        );
      }
      await tx.outreach.update({
        where: { id: outreach.id },
        data: {
          status: "cancelled",
          error: followUpBlocked,
          scheduledFor: null,
          nextAttemptAt: null,
          claimedAt: null,
          claimToken: null,
        },
      });
      return {
        kind: "complete",
        result: {
          ok: false,
          outreachId: outreach.id,
          error: followUpBlocked,
        },
      };
    }
    if (outreach.recipientSnapshotState !== "verified") {
      if (attempt) {
        return applyDeliveryPolicyDecision(
          tx,
          {
            id: outreach.id,
            attemptCount: outreach.attemptCount,
            automaticRetry: true,
          },
          attempt,
          {
            ok: false,
            state: "manual_review",
            error: "Outreach recipient snapshot is unverified",
          },
          now,
        );
      }
      return markManualReview(
        tx,
        outreach.id,
        "Outreach recipient snapshot is unverified",
      );
    }

    const immutableRequest = attempt?.providerRequest
      ? parseResendRequestSnapshot(attempt.providerRequest)
      : null;
    const trustedTemplate = schedulingTimeTemplateProvenance(
      outreach.createdAt,
      outreach.template,
    );
    const snapshotProtection = protectLegacyScheduledSnapshot({
      status: outreach.status,
      finalSubject: outreach.finalSubject,
      finalHtml: outreach.finalHtml,
      trustedTemplate,
      immutableRequest,
    });
    if (snapshotProtection.kind === "block") {
      return markManualReview(
        tx,
        outreach.id,
        snapshotProtection.error,
        attempt?.id,
      );
    }

    const preparationRetryCount =
      getOutreachPreparationRetryCount(outreach.error) ?? 0;
    if (attempt) {
      const blocked = await applyRetryDecision(tx, outreach.id, attempt, now);
      if (blocked) return blocked;
    } else if (
      outreach.attemptCount > 0 ||
      outreach.providerMessageId !== null ||
      (outreach.status === "retry_scheduled" &&
        !canRecoverConfigurationOutageWithoutAttempt(outreach) &&
        !canRecoverPreparationFailureWithoutAttempt(outreach))
    ) {
      return markManualReview(tx, outreach.id, MANUAL_REVIEW_LEGACY);
    }

    const claimToken = randomUUID();
    let idempotencyKey = outreach.idempotencyKey;
    if (!attempt && !attemptIdFromKey(outreach.id, idempotencyKey)) {
      idempotencyKey = newAttemptIdentity(outreach.id).idempotencyKey;
    }
    const claimed = await tx.outreach.update({
      where: { id: outreach.id },
      data: {
        status: "queued",
        claimToken,
        claimedAt: now,
        lastAttemptAt: now,
        error: null,
        idempotencyKey,
        ...(snapshotProtection.kind === "normalize"
          ? {
              finalSubject: snapshotProtection.subject,
              finalHtml: snapshotProtection.html,
            }
          : {}),
      },
      include: {
        contact: {
          select: {
            id: true,
            artistId: true,
            email: true,
            state: true,
            isFullTeam: true,
          },
        },
      },
    });
    return {
      kind: "claimed",
      outreach: claimedOutreach(
        claimed,
        attempt,
        true,
        outreachClaimRecoveryState(outreach),
        preparationRetryCount,
      ),
    };
  });
}

export async function dispatchScheduledOutreach(
  outreachId: string,
): Promise<SendOutreachOutput> {
  const claim = await claimScheduledOutreach(outreachId);
  if (claim.kind === "complete") return claim.result;
  return executeClaimedSend(claim.outreach);
}
