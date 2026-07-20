import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DEFINITIVELY_UNSENT_CANCELLATION_ERROR,
  LEGACY_AMBIGUOUS_BOUNCE_QUARANTINE_ERROR,
  OUTREACH_MAX_SEND_ATTEMPTS,
  OUTREACH_PROVIDER_TRANSACTION_TIMEOUT_MS,
  OUTREACH_RETRY_MAX_DELAY_MS,
  activeContactRecipientEmails,
  canReplaceUnattemptedOutreachSnapshot,
  canRecoverConfigurationOutageWithoutAttempt,
  canRecoverPreparationFailureWithoutAttempt,
  evaluateAttemptRetryEligibility,
  evaluateOutreachDeliveryPolicy,
  festivalOutreachBlockingReason,
  followUpParentBlockingReason,
  getAcceptedDeliveryFailureOutreachState,
  getResendCredentialScopeConflict,
  getOutreachConfigurationAttemptRecoveryData,
  getOutreachConfigurationOutageState,
  getOutreachClaimRecoveryData,
  getOutreachPreparationFailureState,
  getOutreachPreparationRetryCount,
  getOutreachRetryDelayMs,
  hasProtectedCurrentSendState,
  isDefinitiveConfigurationRejection,
  isDefinitivelyUnsentOutreachAttempt,
  isConclusiveRealOutreachAcceptance,
  isNonBlockingLegacyUnknownAttempt,
  isProviderAcceptanceUnresolvedAttempt,
  recipientSnapshotConflict,
  protectLegacyScheduledSnapshot,
  schedulingTimeTemplateProvenance,
  type DeliveryPolicyAttempt,
  type EvaluateOutreachDeliveryPolicyInput,
} from "./sendOutreach";
import {
  RESEND_IDEMPOTENCY_RETENTION_MS,
  RESEND_PROVIDER_REQUEST_TIMEOUT_MS,
  classifyResendProviderError,
  getResendConfigurationError,
  getResendCredentialScope,
  hashResendRequestSnapshot,
  type ResendRequestSnapshot,
} from "./resend";
import {
  CANCELLABLE_OUTREACH_STATUSES,
  isCancellableOutreachStatus,
} from "./outreachStatus";
import {
  acquireOutreachRecipientPolicyLocks,
  outreachRecipientPolicyLockEmails,
} from "./outreachPolicyLocks";

const NOW = new Date("2026-07-16T04:00:00.000Z");
const CREDENTIAL_SCOPE = getResendCredentialScope("re_original")!;

test("historical sent attempts remain untouched by legacy pricing protection", () => {
  const immutableRequest = {
    subject: "Quote $650",
    html: "<p>My standard NYC show rate is $650 for photo/video.</p>",
  };
  assert.deepEqual(
    protectLegacyScheduledSnapshot({
      status: "sent",
      finalSubject: immutableRequest.subject,
      finalHtml: immutableRequest.html,
      immutableRequest,
    }),
    { kind: "unchanged" },
  );
  assert.deepEqual(immutableRequest, {
    subject: "Quote $650",
    html: "<p>My standard NYC show rate is $650 for photo/video.</p>",
  });
});

test("immutable scheduling-time template provenance normalizes only its rate block", () => {
  const scheduledAt = new Date("2026-07-15T12:00:00.000Z");
  const trustedTemplate = schedulingTimeTemplateProvenance(scheduledAt, {
    id: "template-1",
    subject: "{{artist}} availability",
    htmlBody:
      "<p>Budget: {{rate}}</p><p>Unrelated ticket price: $650.</p>",
    updatedAt: new Date("2026-07-15T11:00:00.000Z"),
  });
  assert.deepEqual(trustedTemplate, {
    templateId: "template-1",
    subject: "{{artist}} availability",
    html: "<p>Budget: {{rate}}</p><p>Unrelated ticket price: $650.</p>",
  });
  assert.deepEqual(
    protectLegacyScheduledSnapshot({
      status: "scheduled",
      finalSubject: "Artist availability",
      finalHtml:
        "<p>Budget: $650</p><p>Unrelated ticket price: $650.</p>",
      trustedTemplate,
      immutableRequest: null,
    }),
    {
      kind: "normalize",
      subject: "Artist availability",
      html: "<p>Unrelated ticket price: $650.</p>",
    },
  );
});

test("later template and contact/default changes cannot hide rate-contextual snapshots", () => {
  const scheduledAt = new Date("2026-07-15T12:00:00.000Z");
  assert.equal(
    schedulingTimeTemplateProvenance(scheduledAt, {
      id: "template-1",
      subject: "{{artist}} availability",
      htmlBody: "<p>Current template has no pricing.</p>",
      updatedAt: new Date("2026-07-15T13:00:00.000Z"),
    }),
    null,
  );
  assert.deepEqual(
    protectLegacyScheduledSnapshot({
      status: "scheduled",
      finalSubject: "Artist availability",
      finalHtml:
        "<p>My standard NYC show rate is $650 for photo/video.</p><p>Keep me.</p>",
    }),
    {
      kind: "normalize",
      subject: "Artist availability",
      html: "<p>Keep me.</p>",
    },
  );
  const ambiguous = protectLegacyScheduledSnapshot({
    status: "scheduled",
    finalSubject: "Artist availability",
    finalHtml: "<p>Budget: $650</p><p>Keep me.</p>",
  });
  assert.equal(ambiguous.kind, "block");
  if (ambiguous.kind === "block") {
    assert.match(ambiguous.error, /could not be normalized safely/);
  }
});

test("immutable retry attempts containing legacy pricing fail closed", () => {
  const immutableRequest = {
    subject: "Artist availability",
    html: "<p>Rate: $650</p><p>Keep me.</p>",
  };
  const decision = protectLegacyScheduledSnapshot({
    status: "retry_scheduled",
    finalSubject: immutableRequest.subject,
    finalHtml: immutableRequest.html,
    immutableRequest,
  });
  assert.equal(decision.kind, "block");
  if (decision.kind === "block") {
    assert.match(decision.error, /Immutable provider request/);
    assert.match(decision.error, /do not resend/);
  }
  assert.deepEqual(immutableRequest, {
    subject: "Artist availability",
    html: "<p>Rate: $650</p><p>Keep me.</p>",
  });
});

test("ordinary unpriced scheduled and retry snapshots are unaffected", () => {
  const unpriced = {
    subject: "Artist availability",
    html: "<p>Deliverables include 25 photos and 3 clips.</p>",
  };
  assert.deepEqual(
    protectLegacyScheduledSnapshot({
      status: "scheduled",
      finalSubject: unpriced.subject,
      finalHtml: unpriced.html,
    }),
    { kind: "unchanged" },
  );
  assert.deepEqual(
    protectLegacyScheduledSnapshot({
      status: "scheduled",
      finalSubject: unpriced.subject,
      finalHtml:
        "<p>Keep this unrelated ticket price: $650.</p><p>Email response rate is 50%.</p>",
    }),
    { kind: "unchanged" },
  );
  assert.deepEqual(
    protectLegacyScheduledSnapshot({
      status: "retry_scheduled",
      finalSubject: unpriced.subject,
      finalHtml: "<p>Keep this unrelated ticket price: $650.</p>",
      immutableRequest: {
        subject: unpriced.subject,
        html: "<p>Keep this unrelated ticket price: $650.</p>",
      },
    }),
    { kind: "unchanged" },
  );
});

function retryableAttempt(
  overrides: Record<string, unknown> = {},
) {
  return {
    status: "request_failed",
    providerMessageId: null,
    providerRequest: { version: 1 },
    requestHash: "a".repeat(64),
    providerCredentialScope: CREDENTIAL_SCOPE,
    firstAttemptAt: NOW,
    lastAttemptAt: NOW,
    attemptCount: 1,
    failureDisposition: "retryable",
    nextAttemptAt: new Date(NOW.getTime() + getOutreachRetryDelayMs(1)),
    error: "Resend rate_limit_exceeded (429)",
    bouncedAt: null,
    complainedAt: null,
    ...overrides,
  };
}

function deliveryPolicyFixture(
  overrides: Partial<EvaluateOutreachDeliveryPolicyInput> = {},
): EvaluateOutreachDeliveryPolicyInput {
  const request: ResendRequestSnapshot = {
    version: 1,
    idempotencyKey: "outreach/outreach-1/attempt-1",
    from: "sender@example.com",
    to: ["manager@example.com"],
    cc: [],
    bcc: ["audit@example.com"],
    replyTo: [],
    subject: "Booking request",
    html: "<p>Hello</p>",
    headers: {
      "X-Outreach-Id": "outreach-1",
      "X-Outreach-Attempt-Id": "attempt-1",
    },
    tags: [
      { name: "outreach_id", value: "outreach-1" },
      { name: "outreach_attempt_id", value: "attempt-1" },
    ],
    attachments: [],
  };
  const contact = {
    id: "contact-1",
    artistId: "artist-1",
    email: "manager@example.com",
    state: "active" as const,
    isFullTeam: false,
  };
  return {
    showSyncStatus: "active",
    associationExists: true,
    artistId: "artist-1",
    contactId: contact.id,
    subject: "Booking request",
    contact,
    artistContacts: [contact],
    stored: {
      id: "outreach-1",
      idempotencyKey: request.idempotencyKey,
      recipientEmails: ["manager@example.com"],
      recipientSnapshotState: "verified",
      fullTeamSend: false,
      finalHtml: request.html,
    },
    attempt: {
      id: "attempt-1",
      idempotencyKey: request.idempotencyKey,
      providerRequest:
        request as unknown as DeliveryPolicyAttempt["providerRequest"],
      requestHash: hashResendRequestSnapshot(request),
      testSend: false,
    },
    from: request.from,
    testOverride: null,
    bccEmails: request.bcc,
    suppressedEmails: [],
    ...overrides,
  };
}

test("retry scheduling uses bounded exponential backoff", () => {
  assert.equal(getOutreachRetryDelayMs(1), 60_000);
  assert.equal(getOutreachRetryDelayMs(2), 120_000);
  assert.equal(getOutreachRetryDelayMs(3), 240_000);
  assert.equal(getOutreachRetryDelayMs(20), OUTREACH_RETRY_MAX_DELAY_MS);
});

test("only the current conclusively accepted real original qualifies for follow-up", () => {
  const parent = {
    id: "original-1",
    kind: "original" as const,
    parentOutreachId: null,
    idempotencyKey: "outreach/original-1/attempt-1",
    providerMessageId: "message-1",
  };
  const attempt = {
    outreachId: parent.id,
    status: "accepted",
    idempotencyKey: parent.idempotencyKey,
    testSend: false,
    providerMessageId: parent.providerMessageId,
    acceptedAt: NOW,
  };

  assert.equal(followUpParentBlockingReason(parent, attempt), null);
  assert.equal(isConclusiveRealOutreachAcceptance(parent, attempt), true);
  assert.equal(
    followUpParentBlockingReason(parent, {
      ...attempt,
      status: "delivery_failed",
    }),
    null,
  );

  const blockedCases = [
    [{ ...parent, kind: "follow_up" as const }, attempt],
    [{ ...parent, parentOutreachId: "older" }, attempt],
    [parent, null],
    [parent, { ...attempt, outreachId: "other" }],
    [parent, { ...attempt, idempotencyKey: "stale-key" }],
    [parent, { ...attempt, testSend: true }],
    [parent, { ...attempt, testSend: null }],
    [parent, { ...attempt, providerMessageId: null }],
    [parent, { ...attempt, providerMessageId: "different" }],
    [parent, { ...attempt, acceptedAt: null }],
    [parent, { ...attempt, status: "sending" }],
    [parent, { ...attempt, status: "request_failed" }],
    [parent, { ...attempt, status: "manual_review" }],
    [parent, { ...attempt, status: "legacy_unknown" }],
  ] as const;
  for (const [candidateParent, candidateAttempt] of blockedCases) {
    assert.notEqual(
      followUpParentBlockingReason(candidateParent, candidateAttempt),
      null,
    );
  }
});

test("dismissed festivals block original and follow-up delivery", () => {
  const dismissedFestival = {
    isFestival: true,
    dismissedAt: NOW,
    date: new Date("2026-08-01T00:00:00.000Z"),
    festivalNycStatus: "outside_nyc",
  };

  assert.equal(
    festivalOutreachBlockingReason(dismissedFestival, "original", NOW),
    "Restore this festival before sending outreach",
  );
  assert.equal(
    festivalOutreachBlockingReason(dismissedFestival, "follow_up", NOW),
    "Restore this festival before sending follow-up",
  );
  assert.equal(
    festivalOutreachBlockingReason(
      {
        isFestival: false,
        dismissedAt: NOW,
        date: NOW,
        festivalNycStatus: null,
      },
      "original",
      NOW,
    ),
    null,
  );
  assert.equal(
    festivalOutreachBlockingReason(
      {
        isFestival: true,
        dismissedAt: null,
        date: new Date("2026-08-01T00:00:00.000Z"),
        festivalNycStatus: "outside_nyc",
      },
      "original",
      NOW,
    ),
    null,
  );
});

test("follow-up availability shares festival boundaries without changing regular shows", () => {
  const date = new Date("2026-07-22T00:00:00.000Z");
  assert.equal(
    festivalOutreachBlockingReason(
      {
        isFestival: true,
        dismissedAt: null,
        date,
        festivalNycStatus: "outside_nyc",
      },
      "follow_up",
      NOW,
    ),
    "Non-NYC festivals fewer than 7 calendar days away are not actionable.",
  );
  assert.equal(
    festivalOutreachBlockingReason(
      {
        isFestival: true,
        dismissedAt: null,
        date,
        festivalNycStatus: "inside_nyc",
      },
      "follow_up",
      NOW,
    ),
    null,
  );
  assert.equal(
    festivalOutreachBlockingReason(
      {
        isFestival: true,
        dismissedAt: null,
        date: new Date("2026-07-23T00:00:00.000Z"),
        festivalNycStatus: "outside_nyc",
      },
      "follow_up",
      NOW,
    ),
    null,
  );
  assert.equal(
    festivalOutreachBlockingReason(
      {
        isFestival: true,
        dismissedAt: null,
        date: new Date("2026-07-15T00:00:00.000Z"),
        festivalNycStatus: "inside_nyc",
      },
      "follow_up",
      NOW,
    ),
    "Past festivals are not actionable.",
  );
  assert.equal(
    festivalOutreachBlockingReason(
      {
        isFestival: false,
        dismissedAt: null,
        date: new Date("2026-07-15T00:00:00.000Z"),
        festivalNycStatus: null,
      },
      "follow_up",
      NOW,
    ),
    null,
  );
});

test("locked delivery query is valid for regular and festival sends", () => {
  const source = readFileSync(
    new URL("./sendOutreach.ts", import.meta.url),
    "utf8",
  );
  const lockedPolicy = source.slice(
    source.indexOf("async function evaluateLockedOutreachDeliveryPolicy"),
    source.indexOf("function blockedSendability"),
  );
  assert.match(lockedPolicy, /FROM "Show" show[\s\S]*FOR UPDATE OF show/);
  assert.doesNotMatch(lockedPolicy, /LEFT JOIN "EdmtrainVenue"/);

  for (const show of [
    {
      isFestival: false,
      dismissedAt: null,
      date: new Date("2026-07-15T00:00:00.000Z"),
      festivalNycStatus: null,
    },
    {
      isFestival: true,
      dismissedAt: null,
      date: new Date("2026-07-23T00:00:00.000Z"),
      festivalNycStatus: "outside_nyc",
    },
  ]) {
    assert.equal(
      festivalOutreachBlockingReason(show, "original", NOW),
      null,
    );
  }
});

test("Resend configuration outages requeue scheduled work without consuming attempts", () => {
  const scheduled = getOutreachConfigurationOutageState(
    true,
    0,
    "Resend API key unavailable",
    NOW,
  );
  assert.equal(scheduled.status, "retry_scheduled");
  assert.equal(scheduled.retryScheduled, true);
  assert.equal(
    scheduled.nextAttemptAt.getTime(),
    NOW.getTime() + getOutreachRetryDelayMs(1),
  );
  assert.match(scheduled.error, /^configuration_unavailable:/);
  assert.equal(
    canRecoverConfigurationOutageWithoutAttempt({
      ...scheduled,
      attemptCount: 0,
      providerMessageId: null,
    }),
    true,
  );
  assert.equal(
    canRecoverConfigurationOutageWithoutAttempt({
      ...scheduled,
      attemptCount: 1,
      providerMessageId: null,
    }),
    false,
  );

  const immediate = getOutreachConfigurationOutageState(
    false,
    0,
    "Resend API key unavailable",
    NOW,
  );
  assert.deepEqual(immediate, {
    status: "failed",
    error: "configuration_unavailable: Resend API key unavailable",
    nextAttemptAt: null,
    retryScheduled: false,
  });
  assert.deepEqual(
    evaluateAttemptRetryEligibility(
      retryableAttempt({
        status: "prepared",
        attemptCount: 0,
        failureDisposition: null,
      }),
      NOW,
    ),
    { ok: true },
  );
});

test("transient preparation failures retry without creating ambiguous provider attempts", () => {
  const first = getOutreachPreparationFailureState(
    true,
    0,
    "retryable",
    "Unable to snapshot rate card attachment: fetch failed",
    NOW,
  );
  assert.equal(first.status, "retry_scheduled");
  assert.equal(first.retryScheduled, true);
  assert.equal(first.retryCount, 1);
  assert.equal(
    first.nextAttemptAt.getTime(),
    NOW.getTime() + getOutreachRetryDelayMs(1),
  );
  assert.equal(getOutreachPreparationRetryCount(first.storedError), 1);
  assert.equal(
    canRecoverPreparationFailureWithoutAttempt({
      status: first.status,
      error: first.storedError,
      attemptCount: 0,
      providerMessageId: null,
    }),
    true,
  );

  const second = getOutreachPreparationFailureState(
    true,
    first.retryCount,
    "retryable",
    "Unable to snapshot rate card attachment: timed out",
    NOW,
  );
  assert.equal(second.status, "retry_scheduled");
  assert.equal(
    second.nextAttemptAt.getTime(),
    NOW.getTime() + getOutreachRetryDelayMs(2),
  );
  const bounded = getOutreachPreparationFailureState(
    true,
    100,
    "retryable",
    "still unavailable",
    NOW,
  );
  assert.equal(bounded.status, "retry_scheduled");
  assert.equal(
    bounded.nextAttemptAt.getTime(),
    NOW.getTime() + OUTREACH_RETRY_MAX_DELAY_MS,
  );

  const immediate = getOutreachPreparationFailureState(
    false,
    0,
    "retryable",
    "fetch failed",
    NOW,
  );
  assert.equal(immediate.status, "failed");
  assert.equal(immediate.retryScheduled, false);

  const permanent = getOutreachPreparationFailureState(
    true,
    0,
    "permanent",
    "invalid rate card path",
    NOW,
  );
  assert.equal(permanent.status, "failed");
  assert.equal(permanent.retryScheduled, false);
});

test("Resend configuration is checked before attempts are created or started", () => {
  const source = readFileSync(
    new URL("./sendOutreach.ts", import.meta.url),
    "utf8",
  );
  const immediateStart = source.indexOf("export async function sendOutreach");
  const immediatePreflight = source.indexOf(
    "getResendConfigurationError(",
    immediateStart,
  );
  const immediateClaim = source.indexOf(
    "claimImmediateOutreach(prep)",
    immediateStart,
  );
  assert.ok(immediatePreflight > immediateStart);
  assert.ok(immediatePreflight < immediateClaim);
  assert.match(
    source.slice(immediatePreflight, immediateClaim),
    /RESEND_FROM_EMAIL/,
  );

  const executionStart = source.indexOf("async function executeClaimedSend");
  const executionPreflight = source.indexOf(
    "getResendConfigurationError(",
    executionStart,
  );
  const attemptCreation = source.indexOf("ensureAttempt(outreach)", executionStart);
  assert.ok(executionPreflight > executionStart);
  assert.ok(executionPreflight < attemptCreation);
  assert.match(
    source.slice(executionPreflight, attemptCreation),
    /RESEND_FROM_EMAIL/,
  );
});

test("definitive provider configuration rejections persist and can rotate", () => {
  assert.equal(
    classifyResendProviderError({
      name: "rate_limit_exceeded",
      statusCode: 429,
    }),
    "retryable",
  );
  assert.equal(
    classifyResendProviderError({
      name: "invalid_api_key",
      statusCode: 401,
    }),
    "configuration",
  );
  const rejected = retryableAttempt({
    failureDisposition: "configuration",
    error: "Resend invalid_api_key (401)",
    attemptCount: 2,
    nextAttemptAt: null,
  });
  assert.equal(isDefinitiveConfigurationRejection(rejected), true);
  assert.equal(isDefinitivelyUnsentOutreachAttempt(rejected), true);
  assert.deepEqual(
    evaluateAttemptRetryEligibility(
      rejected,
      new Date(NOW.getTime() + 2 * RESEND_IDEMPOTENCY_RETENTION_MS),
    ),
    { ok: true },
  );
  assert.equal(
    isDefinitiveConfigurationRejection({
      ...rejected,
      failureDisposition: "permanent",
    }),
    false,
  );

  const outage = getOutreachConfigurationOutageState(
    true,
    rejected.attemptCount,
    "Resend invalid_api_key (401)",
    NOW,
  );
  assert.equal(outage.retryScheduled, true);
  if (!outage.retryScheduled) return;
  assert.equal(
    outage.nextAttemptAt.getTime(),
    NOW.getTime() + getOutreachRetryDelayMs(rejected.attemptCount),
  );
  assert.equal(
    getResendConfigurationError(
      "re_corrected",
      "Sender <sender@example.com>",
    ),
    null,
  );

  const source = readFileSync(
    new URL("./sendOutreach.ts", import.meta.url),
    "utf8",
  );
  const completionStart = source.indexOf("async function finishClaimedSend");
  const configurationBranch = source.slice(
    source.indexOf(
      'if (disposition === "configuration")',
      completionStart,
    ),
    source.indexOf(
      'if (disposition === "in_flight")',
      completionStart,
    ),
  );
  assert.match(configurationBranch, /getOutreachConfigurationOutageState/);
  assert.match(configurationBranch, /status: "request_failed"/);
  assert.match(configurationBranch, /failureDisposition: "configuration"/);
  assert.doesNotMatch(
    configurationBranch,
    /getOutreachConfigurationAttemptRecoveryData/,
  );
  assert.doesNotMatch(configurationBranch, /attemptCount:\s*configurationRecovery/);
  assert.doesNotMatch(configurationBranch, /firstAttemptAt\s*:/);
  assert.match(
    source,
    /retireDefinitiveConfigurationAttempt[\s\S]*status: "cancelled"[\s\S]*nextAttemptAt: null/,
  );
  assert.equal(
    (
      source.match(
        /existingAttempt\s*&&\s*isDefinitiveConfigurationRejection\(existingAttempt\)/g,
      ) ?? []
    ).length,
    2,
  );

  const migration = readFileSync(
    new URL(
      "../prisma/migrations/20260716060000_outreach_send_attempts/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    migration,
    /IF OLD\."firstAttemptAt" IS NOT NULL\s+AND NEW\."firstAttemptAt" IS DISTINCT FROM OLD\."firstAttemptAt"\s+THEN\s+RAISE EXCEPTION 'OutreachSendAttempt firstAttemptAt is immutable once set'/,
  );
  assert.match(
    migration,
    /"failureDisposition" IN \(\s+'configuration',\s+'in_flight',\s+'retryable',\s+'permanent',\s+'uncertain',\s+'policy'/,
  );
});

test("concurrent idempotent requests stay acceptance-uncertain and same-key retryable", () => {
  const inFlight = retryableAttempt({
    failureDisposition: "in_flight",
    error: "Resend concurrent_idempotent_requests (409)",
  });
  assert.equal(
    classifyResendProviderError({
      name: "concurrent_idempotent_requests",
      statusCode: 409,
    }),
    "in_flight",
  );
  assert.equal(isDefinitivelyUnsentOutreachAttempt(inFlight), false);
  assert.equal(isDefinitiveConfigurationRejection(inFlight), false);
  assert.deepEqual(evaluateAttemptRetryEligibility(inFlight, NOW), {
    ok: true,
  });

  const expired = evaluateAttemptRetryEligibility(
    inFlight,
    new Date(NOW.getTime() + RESEND_IDEMPOTENCY_RETENTION_MS),
  );
  assert.equal(expired.ok, false);
  if (!expired.ok) {
    assert.equal(expired.state, "manual_review");
    assert.match(expired.error, /acceptance remained unresolved/);
  }

  const capped = evaluateAttemptRetryEligibility(
    { ...inFlight, attemptCount: OUTREACH_MAX_SEND_ATTEMPTS },
    NOW,
  );
  assert.equal(capped.ok, false);
  if (!capped.ok) {
    assert.equal(capped.state, "manual_review");
    assert.match(capped.error, /retry attempt cap reached/);
  }

  const source = readFileSync(
    new URL("./sendOutreach.ts", import.meta.url),
    "utf8",
  );
  const completionStart = source.indexOf("async function finishClaimedSend");
  const inFlightBranch = source.slice(
    source.indexOf('if (disposition === "in_flight")', completionStart),
    source.indexOf(
      'if (disposition === "uncertain" || disposition === "policy")',
      completionStart,
    ),
  );
  assert.match(inFlightBranch, /failureDisposition: "in_flight"/);
  assert.match(
    inFlightBranch,
    /status: canScheduleRetry \? "retry_scheduled" : "manual_review"/,
  );
  assert.doesNotMatch(inFlightBranch, /status: "failed"/);

  const cancellation = source.slice(
    source.indexOf("export async function cancelScheduledOutreach"),
    source.indexOf(
      "async function claimScheduledOutreach",
      source.indexOf("export async function cancelScheduledOutreach"),
    ),
  );
  assert.match(
    cancellation,
    /attempt\.failureDisposition === "in_flight"[\s\S]*\? "in_flight"[\s\S]*: "uncertain"/,
  );
  const recovery = source.slice(
    source.indexOf("async function recoverUncertainProviderTransaction"),
    source.indexOf("async function claimAttemptForSending"),
  );
  assert.match(
    recovery,
    /attempt\.failureDisposition === "in_flight" \? "in_flight" : "uncertain"/,
  );
});

test("submitted attempts retry only inside their original Resend credential scope", () => {
  const inFlight = retryableAttempt({
    failureDisposition: "in_flight",
    error: "Resend concurrent_idempotent_requests (409)",
  });
  assert.equal(isProviderAcceptanceUnresolvedAttempt(inFlight), true);
  assert.equal(
    getResendCredentialScopeConflict(inFlight, CREDENTIAL_SCOPE),
    null,
  );
  assert.deepEqual(
    evaluateAttemptRetryEligibility(inFlight, NOW, CREDENTIAL_SCOPE),
    { ok: true },
  );

  const rotatedScope = getResendCredentialScope("re_rotated");
  const rotated = evaluateAttemptRetryEligibility(
    inFlight,
    NOW,
    rotatedScope,
  );
  assert.equal(rotated.ok, false);
  if (!rotated.ok) {
    assert.equal(rotated.state, "manual_review");
    assert.match(rotated.error, /credential scope changed/);
    assert.match(rotated.error, /idempotency namespace/);
  }

  const legacyUnscoped = {
    ...inFlight,
    providerCredentialScope: null,
  };
  assert.equal(isProviderAcceptanceUnresolvedAttempt(legacyUnscoped), true);
  assert.equal(isDefinitivelyUnsentOutreachAttempt(legacyUnscoped), false);
  const unscoped = evaluateAttemptRetryEligibility(
    legacyUnscoped,
    NOW,
    CREDENTIAL_SCOPE,
  );
  assert.equal(unscoped.ok, false);
  if (!unscoped.ok) {
    assert.equal(unscoped.state, "manual_review");
    assert.match(unscoped.error, /no provable Resend credential scope/);
  }

  const configuration = {
    ...legacyUnscoped,
    status: "manual_review",
    failureDisposition: "configuration",
  };
  assert.equal(isProviderAcceptanceUnresolvedAttempt(configuration), false);
  assert.equal(isDefinitiveConfigurationRejection(configuration), true);

  const unsubmitted = retryableAttempt({
    status: "prepared",
    providerCredentialScope: null,
    firstAttemptAt: null,
    attemptCount: 0,
    failureDisposition: null,
    error: null,
  });
  assert.equal(
    getResendCredentialScopeConflict(unsubmitted, rotatedScope),
    null,
  );
  assert.deepEqual(
    evaluateAttemptRetryEligibility(unsubmitted, NOW, rotatedScope),
    { ok: true },
  );
});

test("policy changes quarantine unresolved provider acceptance instead of cancelling it", () => {
  const source = readFileSync(
    new URL("./sendOutreach.ts", import.meta.url),
    "utf8",
  );
  const policyDecision = source.slice(
    source.indexOf("async function applyDeliveryPolicyDecision"),
    source.indexOf("async function markProviderAcceptanceUncertain"),
  );
  assert.ok(
    policyDecision.indexOf("isProviderAcceptanceUnresolvedAttempt(attempt)") <
      policyDecision.indexOf('decision.state === "cancelled"'),
  );
  assert.match(policyDecision, /markProviderAcceptanceUncertain/);
  assert.match(
    policyDecision,
    /attempt\.failureDisposition === "in_flight" \? "in_flight" : "uncertain"/,
  );

  const scheduledClaim = source.slice(
    source.indexOf("async function claimScheduledOutreach"),
    source.indexOf("export async function dispatchScheduledOutreach"),
  );
  assert.match(
    scheduledClaim,
    /const attempt = await currentAttempt[\s\S]*show\.syncStatus !== "active"[\s\S]*applyDeliveryPolicyDecision/,
  );
  assert.match(
    scheduledClaim,
    /!association[\s\S]*applyDeliveryPolicyDecision/,
  );
  assert.match(
    scheduledClaim,
    /recipientSnapshotState !== "verified"[\s\S]*applyDeliveryPolicyDecision/,
  );
  assert.match(
    scheduledClaim,
    /protectLegacyScheduledSnapshot[\s\S]*markManualReview\([\s\S]*attempt\?\.id/,
  );
  assert.match(
    scheduledClaim,
    /snapshotProtection\.kind === "normalize"[\s\S]*finalSubject:[\s\S]*finalHtml:/,
  );
  assert.match(scheduledClaim, /schedulingTimeTemplateProvenance/);
  assert.doesNotMatch(scheduledClaim, /customPrice|key: "default_rate"/);
});

test("pre-submission transaction failures restore the exact claim and attempt state", () => {
  const scheduledFor = new Date("2026-07-16T03:00:00.000Z");
  const retryAt = new Date("2026-07-16T04:01:00.000Z");
  const lastAttemptAt = new Date("2026-07-16T03:59:00.000Z");
  assert.deepEqual(
    getOutreachConfigurationAttemptRecoveryData({
      status: "request_failed",
      error: "Resend rate_limit_exceeded (429)",
      failureDisposition: "retryable",
      nextAttemptAt: retryAt,
      lastAttemptAt,
      attemptCount: 2,
    }),
    {
      status: "request_failed",
      error: "Resend rate_limit_exceeded (429)",
      failureDisposition: "retryable",
      nextAttemptAt: retryAt,
      lastAttemptAt,
      attemptCount: 2,
    },
  );
  assert.deepEqual(
    getOutreachClaimRecoveryData({
      status: "retry_scheduled",
      error: "Resend rate_limit_exceeded (429)",
      scheduledFor,
      nextAttemptAt: retryAt,
      lastAttemptAt,
      attemptCount: 2,
    }),
    {
      status: "retry_scheduled",
      error: "Resend rate_limit_exceeded (429)",
      scheduledFor,
      nextAttemptAt: retryAt,
      lastAttemptAt,
      attemptCount: 2,
      claimedAt: null,
      claimToken: null,
    },
  );

  const source = readFileSync(
    new URL("./sendOutreach.ts", import.meta.url),
    "utf8",
  );
  const restore = source.slice(
    source.indexOf("async function restoreUnsubmittedClaimFailure"),
    source.indexOf("async function submitClaimedAttempt"),
  );
  assert.match(
    restore,
    /getOutreachConfigurationAttemptRecoveryData\(attemptRecovery\)/,
  );
  assert.match(
    restore,
    /getOutreachClaimRecoveryData\(outreach\.claimRecovery\)/,
  );
  assert.doesNotMatch(restore, /markManualReview/);
  assert.match(
    source.slice(
      source.indexOf("async function startAttempt"),
      source.indexOf("async function finishClaimedSend"),
    ),
    /catch \(error\)[\s\S]*restoreUnsubmittedClaimFailure/,
  );
});

test("only provably unattempted legacy markers are replaceable", () => {
  assert.equal(
    isNonBlockingLegacyUnknownAttempt({
      status: "legacy_unknown",
      providerRequest: null,
      requestHash: null,
      providerMessageId: null,
      attemptCount: 0,
      bouncedAt: null,
      complainedAt: null,
    }),
    true,
  );
  assert.equal(
    isNonBlockingLegacyUnknownAttempt({
      status: "manual_review",
      providerRequest: null,
      requestHash: null,
      providerMessageId: null,
      attemptCount: 0,
      bouncedAt: null,
      complainedAt: null,
    }),
    false,
  );
  assert.equal(
    isNonBlockingLegacyUnknownAttempt({
      status: "legacy_unknown",
      providerRequest: { version: 1 },
      requestHash: "a".repeat(64),
      providerMessageId: null,
      attemptCount: 0,
      bouncedAt: null,
      complainedAt: null,
    }),
    false,
  );
  assert.equal(
    isNonBlockingLegacyUnknownAttempt({
      status: "legacy_unknown",
      providerRequest: null,
      requestHash: null,
      providerMessageId: "message-accepted",
      attemptCount: 1,
      bouncedAt: null,
      complainedAt: NOW,
    }),
    false,
  );
  assert.equal(
    isNonBlockingLegacyUnknownAttempt({
      status: "legacy_unknown",
      providerRequest: null,
      requestHash: null,
      providerMessageId: "message-ambiguous",
      attemptCount: 1,
      bouncedAt: NOW,
      complainedAt: null,
      testSend: null,
      error: LEGACY_AMBIGUOUS_BOUNCE_QUARANTINE_ERROR,
    }),
    true,
  );

  const source = readFileSync(
    new URL("./sendOutreach.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /row\.status === "manual_review" &&\s+!isNonBlockingLegacyUnknownAttempt/,
  );
  assert.match(
    source,
    /if \(existing && isNonBlockingLegacyUnknownAttempt\(existingAttempt\)\) \{[\s\S]*?const identity = newAttemptIdentity\(existing\.id\);[\s\S]*?recipientSnapshotState: "verified"/,
  );
});

test("accepted test-delivery failures stay reusable while real failures remain failed", () => {
  const acceptedAt = new Date("2026-07-16T04:01:00.000Z");
  assert.deepEqual(
    getAcceptedDeliveryFailureOutreachState(
      true,
      "bounce:permanent",
      "message-test",
      acceptedAt,
    ),
    {
      status: "test",
      error: null,
      providerMessageId: "message-test",
      sentAt: acceptedAt,
      scheduledFor: null,
      nextAttemptAt: null,
      claimedAt: null,
      claimToken: null,
    },
  );
  assert.equal(
    getAcceptedDeliveryFailureOutreachState(
      false,
      "bounce:permanent",
      "message-real",
      acceptedAt,
    ).status,
    "failed",
  );
});

test("attachment preparation completes before an immutable provider attempt is persisted", () => {
  const source = readFileSync(
    new URL("./sendOutreach.ts", import.meta.url),
    "utf8",
  );
  const ensureStart = source.indexOf("async function ensureAttempt");
  const preparation = source.indexOf("prepareResendRequest({", ensureStart);
  const failureRelease = source.indexOf(
    "prepared.preparationDisposition",
    preparation,
  );
  const attemptCreation = source.indexOf(
    "tx.outreachSendAttempt.create({",
    preparation,
  );
  assert.ok(preparation > ensureStart);
  assert.ok(failureRelease > preparation);
  assert.ok(failureRelease < attemptCreation);
});

test("scheduled and automatic retry sends share one cancellation predicate", () => {
  assert.deepEqual(CANCELLABLE_OUTREACH_STATUSES, [
    "scheduled",
    "retry_scheduled",
  ]);
  assert.equal(isCancellableOutreachStatus("scheduled"), true);
  assert.equal(isCancellableOutreachStatus("retry_scheduled"), true);
  assert.equal(isCancellableOutreachStatus("queued"), false);

  const source = readFileSync(
    new URL("./sendOutreach.ts", import.meta.url),
    "utf8",
  );
  const cancellationStart = source.indexOf(
    "export async function cancelScheduledOutreach",
  );
  const cancellationEnd = source.indexOf(
    "async function claimScheduledOutreach",
    cancellationStart,
  );
  const cancellation = source.slice(cancellationStart, cancellationEnd);
  assert.match(cancellation, /CANCELLABLE_OUTREACH_STATUSES/);
  assert.match(cancellation, /outreachSendAttempt\.update/);
  assert.match(cancellation, /status: "cancelled"/);
  assert.match(cancellation, /isDefinitivelyUnsentOutreachAttempt/);
  assert.match(cancellation, /markProviderAcceptanceUncertain/);
  assert.match(cancellation, /finishAlreadyAccepted/);
  assert.match(
    cancellation,
    /error: DEFINITIVELY_UNSENT_CANCELLATION_ERROR/,
  );
  assert.match(
    cancellation,
    /attempt\.failureDisposition === "configuration"[\s\S]*\? \{\}[\s\S]*failureDisposition: "policy"/,
  );
  assert.match(cancellation, /nextAttemptAt: null/);

  const migration = readFileSync(
    new URL(
      "../prisma/migrations/20260716060000_outreach_send_attempts/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    migration,
    /OutreachSendAttempt_status_check"[\s\S]*'request_failed',\s+'cancelled',\s+'accepted'/,
  );
});

test("only definitively unsent cancellations can rotate to a fresh key", () => {
  assert.equal(
    isDefinitivelyUnsentOutreachAttempt(
      retryableAttempt({
        status: "prepared",
        firstAttemptAt: null,
        attemptCount: 0,
        failureDisposition: null,
        error: null,
      }),
    ),
    true,
  );
  assert.equal(isDefinitivelyUnsentOutreachAttempt(retryableAttempt()), true);
  const configurationRejected = retryableAttempt({
    failureDisposition: "configuration",
    error: "Resend invalid_api_key (401)",
  });
  assert.equal(
    isDefinitivelyUnsentOutreachAttempt(configurationRejected),
    true,
  );
  assert.equal(
    isDefinitiveConfigurationRejection(configurationRejected),
    true,
  );
  assert.equal(
    isDefinitivelyUnsentOutreachAttempt({
      ...configurationRejected,
      status: "cancelled",
    }),
    true,
  );
  assert.equal(
    isDefinitivelyUnsentOutreachAttempt(
      retryableAttempt({
        status: "request_failed",
        failureDisposition: "uncertain",
      }),
    ),
    false,
  );
  assert.equal(
    isDefinitivelyUnsentOutreachAttempt(
      retryableAttempt({
        status: "cancelled",
        failureDisposition: "policy",
        error: DEFINITIVELY_UNSENT_CANCELLATION_ERROR,
      }),
    ),
    true,
  );
  assert.equal(
    isDefinitivelyUnsentOutreachAttempt(
      retryableAttempt({
        status: "cancelled",
        failureDisposition: null,
        error: null,
      }),
    ),
    false,
  );

  const source = readFileSync(
    new URL("./sendOutreach.ts", import.meta.url),
    "utf8",
  );
  assert.equal(
    (
      source.match(
        /existing\.status === "cancelled"[\s\S]*?!isDefinitivelyUnsentOutreachAttempt\(existingAttempt\)/g,
      ) ?? []
    ).length,
    2,
  );
});

test("full-team recipient snapshots exclude quarantined and direct-only contacts", () => {
  assert.deepEqual(
    activeContactRecipientEmails([
      { email: "active@example.com", state: "active" },
      { email: "legacy@example.com", state: "quarantined" },
      { email: "ACTIVE@example.com", state: "active" },
      {
        email: null,
        state: "active",
        directOutreachNote: "Personal introduction",
      },
    ]),
    ["active@example.com"],
  );
});

test("a direct-only contact cannot trigger full-team email fanout", () => {
  const directContact = {
    id: "contact-1",
    artistId: "artist-1",
    email: null,
    state: "active" as const,
    isFullTeam: true,
  };
  assert.deepEqual(
    evaluateOutreachDeliveryPolicy(
      deliveryPolicyFixture({
        contact: directContact,
        artistContacts: [
          directContact,
          {
            id: "contact-2",
            artistId: "artist-1",
            email: "manager@example.com",
            state: "active",
            isFullTeam: false,
          },
        ],
        stored: null,
        attempt: null,
      }),
    ),
    {
      ok: false,
      state: "cancelled",
      error: "Selected contact has no valid active recipient address",
    },
  );
});

test("customized outreach selects one address even from a full-team marker", () => {
  const teamContact = {
    id: "contact-1",
    artistId: "artist-1",
    email: "manager@example.com",
    state: "active" as const,
    isFullTeam: true,
  };
  const artistContacts = [
    teamContact,
    {
      id: "contact-2",
      artistId: "artist-1",
      email: "agent@example.com",
      state: "active" as const,
      isFullTeam: false,
    },
  ];
  const customized = evaluateOutreachDeliveryPolicy(
    deliveryPolicyFixture({
      contact: teamContact,
      artistContacts,
      stored: null,
      attempt: null,
      bccEmails: [],
      requestedFullTeamSend: false,
    }),
  );
  assert.equal(customized.ok, true);
  if (customized.ok) {
    assert.deepEqual(customized.currentRecipients, ["manager@example.com"]);
    assert.equal(customized.fullTeamSend, false);
    assert.deepEqual(customized.policy.to, ["manager@example.com"]);
  }

  const ordinaryBulk = evaluateOutreachDeliveryPolicy(
    deliveryPolicyFixture({
      contact: teamContact,
      artistContacts,
      stored: null,
      attempt: null,
      bccEmails: [],
    }),
  );
  assert.equal(ordinaryBulk.ok, true);
  if (ordinaryBulk.ok) {
    assert.deepEqual(ordinaryBulk.currentRecipients, [
      "agent@example.com",
      "manager@example.com",
    ]);
    assert.equal(ordinaryBulk.fullTeamSend, true);
  }
});

test("test override changes delivery but not the selected intended-recipient snapshot", () => {
  const teamContact = {
    id: "contact-1",
    artistId: "artist-1",
    email: "manager@example.com",
    state: "active" as const,
    isFullTeam: true,
  };
  const decision = evaluateOutreachDeliveryPolicy(
    deliveryPolicyFixture({
      contact: teamContact,
      artistContacts: [
        teamContact,
        {
          id: "contact-2",
          artistId: "artist-1",
          email: "agent@example.com",
          state: "active",
          isFullTeam: false,
        },
      ],
      stored: null,
      attempt: null,
      bccEmails: [],
      requestedFullTeamSend: false,
      testOverride: "preview@example.com",
    }),
  );
  assert.equal(decision.ok, true);
  if (decision.ok) {
    assert.deepEqual(decision.currentRecipients, ["manager@example.com"]);
    assert.deepEqual(decision.policy.intendedRecipients, [
      "manager@example.com",
    ]);
    assert.deepEqual(decision.policy.to, ["preview@example.com"]);
    assert.equal(decision.policy.testSend, true);
  }
});

test("retries keep the original customized recipient when contact markers change", () => {
  const fixture = deliveryPolicyFixture();
  const decision = evaluateOutreachDeliveryPolicy({
    ...fixture,
    contact: { ...fixture.contact!, isFullTeam: true },
    artistContacts: [
      { ...fixture.contact!, isFullTeam: true },
      {
        id: "contact-2",
        artistId: "artist-1",
        email: "new@example.com",
        state: "active",
        isFullTeam: false,
      },
    ],
    requestedFullTeamSend: true,
  });
  assert.equal(decision.ok, true);
  if (decision.ok) {
    assert.deepEqual(decision.currentRecipients, ["manager@example.com"]);
    assert.equal(decision.fullTeamSend, false);
  }
});

test("delivery policy revalidation classifies contact, suppression, and configuration changes", () => {
  const quarantined = deliveryPolicyFixture({
    contact: {
      id: "contact-1",
      artistId: "artist-1",
      email: "manager@example.com",
      state: "quarantined",
      isFullTeam: false,
    },
  });
  assert.deepEqual(evaluateOutreachDeliveryPolicy(quarantined), {
    ok: false,
    state: "cancelled",
    error: "Selected contact is quarantined",
  });

  const suppressed = evaluateOutreachDeliveryPolicy(
    deliveryPolicyFixture({
      suppressedEmails: ["manager@example.com"],
    }),
  );
  assert.deepEqual(suppressed, {
    ok: false,
    state: "cancelled",
    error: "All intended recipient addresses are suppressed or invalid",
  });

  const configuration = evaluateOutreachDeliveryPolicy(
    deliveryPolicyFixture({
      configurationError: "Resend API key unavailable",
    }),
  );
  assert.deepEqual(configuration, {
    ok: false,
    state: "configuration",
    error: "Resend API key unavailable",
  });

  const malformedSender = evaluateOutreachDeliveryPolicy(
    deliveryPolicyFixture({ from: "malformed sender" }),
  );
  assert.deepEqual(malformedSender, {
    ok: false,
    state: "configuration",
    error:
      "Invalid RESEND_FROM_EMAIL; expected email@example.com or Name <email@example.com>",
  });
});

test("delivery policy revalidation detects membership and immutable request drift", () => {
  const teamContact = {
    id: "contact-1",
    artistId: "artist-1",
    email: "manager@example.com",
    state: "active" as const,
    isFullTeam: true,
  };
  const membershipChanged = evaluateOutreachDeliveryPolicy(
    deliveryPolicyFixture({
      contact: teamContact,
      artistContacts: [
        teamContact,
        {
          id: "contact-2",
          artistId: "artist-1",
          email: "new@example.com",
          state: "active",
          isFullTeam: false,
        },
      ],
      stored: {
        ...deliveryPolicyFixture().stored!,
        fullTeamSend: true,
      },
      attempt: null,
      bccEmails: [],
    }),
  );
  assert.equal(membershipChanged.ok, false);
  if (!membershipChanged.ok) {
    assert.equal(membershipChanged.state, "manual_review");
    assert.match(membershipChanged.error, /outreach snapshot/);
  }

  const bccChanged = evaluateOutreachDeliveryPolicy(
    deliveryPolicyFixture({ bccEmails: ["other@example.com"] }),
  );
  assert.equal(bccChanged.ok, false);
  if (!bccChanged.ok) {
    assert.equal(bccChanged.state, "manual_review");
    assert.match(bccChanged.error, /BCC policy changed/);
  }

  const senderChanged = evaluateOutreachDeliveryPolicy(
    deliveryPolicyFixture({ from: "corrected-sender@example.com" }),
  );
  assert.equal(senderChanged.ok, false);
  if (!senderChanged.ok) {
    assert.equal(senderChanged.state, "manual_review");
    assert.match(senderChanged.error, /configured sender changed/);
  }

  const clean = evaluateOutreachDeliveryPolicy(deliveryPolicyFixture());
  assert.equal(clean.ok, true);
  if (clean.ok) assert.equal(clean.request?.idempotencyKey, "outreach/outreach-1/attempt-1");
});

test("recipient policy advisory locks serialize send claims and suppressions", async () => {
  assert.deepEqual(
    outreachRecipientPolicyLockEmails([
      "B@example.com",
      "a@example.com",
      "A@example.com",
    ]),
    ["a@example.com", "b@example.com"],
  );

  class LockManager {
    private readonly locked = new Set<string>();
    private readonly waiters = new Map<string, Array<() => void>>();

    async acquire(key: string): Promise<() => void> {
      if (!this.locked.has(key)) {
        this.locked.add(key);
        return () => this.release(key);
      }
      await new Promise<void>((resolve) => {
        const queued = this.waiters.get(key) ?? [];
        queued.push(resolve);
        this.waiters.set(key, queued);
      });

      return () => this.release(key);
    }

    private release(key: string): void {
      const queued = this.waiters.get(key);
      const next = queued?.shift();
      if (next) {
        next();
        return;
      }
      this.waiters.delete(key);
      this.locked.delete(key);
    }
  }

  const manager = new LockManager();
  const transaction = async (
    work: (
      tx: Parameters<typeof acquireOutreachRecipientPolicyLocks>[0],
    ) => Promise<void>,
  ) => {
    const releases: Array<() => void> = [];
    const tx = {
      $queryRaw: async (query: { values: unknown[] }) => {
        const email = query.values.find(
          (value): value is string => typeof value === "string",
        );
        assert.ok(email);
        releases.push(await manager.acquire(email));
        return [{ locked: 1 }];
      },
    } as unknown as Parameters<typeof acquireOutreachRecipientPolicyLocks>[0];
    try {
      await work(tx);
    } finally {
      for (const release of releases.reverse()) release();
    }
  };

  let releaseSend!: () => void;
  const sendGate = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  let sendLocked!: () => void;
  const sendReady = new Promise<void>((resolve) => {
    sendLocked = resolve;
  });
  const send = transaction(async (tx) => {
    await acquireOutreachRecipientPolicyLocks(tx, ["manager@example.com"]);
    sendLocked();
    await sendGate;
  });
  await sendReady;

  let suppressionAcquired = false;
  const suppression = transaction(async (tx) => {
    await acquireOutreachRecipientPolicyLocks(tx, ["MANAGER@example.com"]);
    suppressionAcquired = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(suppressionAcquired, false);

  releaseSend();
  await Promise.all([send, suppression]);
  assert.equal(suppressionAcquired, true);
});

test("recipient policy lock parameters use PostgreSQL integer overloads", async () => {
  let query:
    | {
        text: string;
        values: unknown[];
      }
    | undefined;
  const tx = {
    $queryRaw: async (value: {
      text: string;
      values: unknown[];
    }) => {
      query = value;
      return [{ locked: 1 }];
    },
  } as unknown as Parameters<typeof acquireOutreachRecipientPolicyLocks>[0];

  await acquireOutreachRecipientPolicyLocks(tx, ["manager@example.com"]);

  assert.ok(query);
  assert.match(
    query.text,
    /pg_advisory_xact_lock\(\s*CAST\(\$1 AS INTEGER\),\s*CAST\(hashtext\(\$2\) AS INTEGER\)\s*\)/
  );
  assert.deepEqual(query.values, [
    1_330_072_011,
    "manager@example.com",
  ]);
});

test("sending transition revalidates and holds policy locks through provider submission", () => {
  const sendSource = readFileSync(
    new URL("./sendOutreach.ts", import.meta.url),
    "utf8",
  );
  const routeSource = readFileSync(
    new URL("../app/api/resend/webhook/route.ts", import.meta.url),
    "utf8",
  );
  const settingsSource = readFileSync(
    new URL("./generalSettings.ts", import.meta.url),
    "utf8",
  );
  const claim = sendSource.slice(
    sendSource.indexOf("async function claimAttemptForSending"),
    sendSource.indexOf("async function restoreUnsubmittedClaimFailure"),
  );
  const submission = sendSource.slice(
    sendSource.indexOf("async function submitClaimedAttempt"),
    sendSource.indexOf("async function startAttempt"),
  );
  const lockedPolicy = sendSource.slice(
    sendSource.indexOf("async function evaluateLockedOutreachDeliveryPolicy"),
    sendSource.indexOf("function blockedSendability"),
  );

  const revalidation = claim.indexOf("evaluateLockedOutreachDeliveryPolicy(");
  const sending = claim.indexOf('status: "sending"');
  const providerRevalidation = submission.indexOf(
    "evaluateLockedOutreachDeliveryPolicy(",
  );
  const provider = submission.indexOf("sendPreparedEmailViaResend(");
  assert.ok(revalidation >= 0 && revalidation < sending);
  assert.equal(claim.includes("sendPreparedEmailViaResend("), false);
  assert.ok(providerRevalidation >= 0 && providerRevalidation < provider);
  assert.match(
    claim,
    /providerCredentialScope:\s+attempt\.providerCredentialScope \?\? submissionCredential\.scope/,
  );
  assert.match(
    submission,
    /getResendCredentialScopeConflict\([\s\S]*submissionCredential\.scope/,
  );
  assert.match(
    submission,
    /sendPreparedEmailViaResend\([\s\S]*attachmentBlobs,\s+submissionCredential/,
  );
  assert.match(
    submission,
    /isolationLevel: Prisma\.TransactionIsolationLevel\.ReadCommitted/,
  );
  assert.match(
    submission,
    /timeout: OUTREACH_PROVIDER_TRANSACTION_TIMEOUT_MS/,
  );
  assert.equal(OUTREACH_PROVIDER_TRANSACTION_TIMEOUT_MS, 30_000);
  assert.ok(
    RESEND_PROVIDER_REQUEST_TIMEOUT_MS <
      OUTREACH_PROVIDER_TRANSACTION_TIMEOUT_MS,
  );
  assert.match(lockedPolicy, /FROM "Show" show[\s\S]*FOR UPDATE OF show/);
  assert.doesNotMatch(lockedPolicy, /LEFT JOIN "EdmtrainVenue"/);
  assert.match(lockedPolicy, /FROM "Artist"[\s\S]*FOR UPDATE/);
  assert.match(lockedPolicy, /FROM "Contact"[\s\S]*FOR UPDATE/);
  assert.match(
    lockedPolicy,
    /getResendDeliverySettingsSnapshot\(tx\)/,
  );
  assert.match(settingsSource, /LOCK TABLE "Setting" IN SHARE MODE/);
  assert.match(
    settingsSource,
    /LOCK TABLE "Setting" IN SHARE ROW EXCLUSIVE MODE/,
  );
  assert.ok(
    lockedPolicy.indexOf("acquireOutreachRecipientPolicyLocks(") <
      lockedPolicy.indexOf("emailSuppression.findMany"),
  );
  assert.ok(
    routeSource.indexOf("acquireOutreachRecipientPolicyLocks(") <
      routeSource.indexOf("emailSuppression.upsert"),
  );
});

test("only proven retryable attempts inside the retention window and cap can retry", () => {
  assert.deepEqual(
    evaluateAttemptRetryEligibility(
      retryableAttempt(),
      new Date(NOW.getTime() + 60_000),
    ),
    { ok: true },
  );
  assert.deepEqual(
    evaluateAttemptRetryEligibility(
      retryableAttempt({
        status: "prepared",
        attemptCount: 0,
        failureDisposition: null,
      }),
      new Date(NOW.getTime() + RESEND_IDEMPOTENCY_RETENTION_MS),
    ),
    {
      ok: false,
      state: "manual_review",
      error:
        "Resend idempotency retention expired; do not retry this immutable request without manual review",
    },
  );
  const uncertain = evaluateAttemptRetryEligibility(
    retryableAttempt({ status: "sending" }),
    NOW,
  );
  assert.equal(uncertain.ok, false);
  if (!uncertain.ok) assert.equal(uncertain.state, "manual_review");

  const permanent = evaluateAttemptRetryEligibility(
    retryableAttempt({ failureDisposition: "permanent" }),
    NOW,
  );
  assert.equal(permanent.ok, false);
  if (!permanent.ok) assert.equal(permanent.state, "failed");

  const capped = evaluateAttemptRetryEligibility(
    retryableAttempt({ attemptCount: OUTREACH_MAX_SEND_ATTEMPTS }),
    NOW,
  );
  assert.equal(capped.ok, false);
  if (!capped.ok) assert.equal(capped.state, "failed");
  assert.deepEqual(
    evaluateAttemptRetryEligibility(
      retryableAttempt(),
      new Date(NOW.getTime() + RESEND_IDEMPOTENCY_RETENTION_MS),
    ),
    {
      ok: false,
      state: "manual_review",
      error:
        "Resend idempotency retention expired; do not retry this immutable request without manual review",
    },
  );
});

test("sendability snapshot checks reject legacy and mutable-contact conflicts", () => {
  assert.equal(
    recipientSnapshotConflict(
      {
        recipientEmails: ["team@example.com"],
        recipientSnapshotState: "verified",
        fullTeamSend: false,
      },
      ["TEAM@example.com"],
      false,
    ),
    null,
  );
  assert.match(
    recipientSnapshotConflict(
      {
        recipientEmails: [],
        recipientSnapshotState: "legacy_unknown",
        fullTeamSend: false,
      },
      ["team@example.com"],
      false,
    ) ?? "",
    /unverified/,
  );
  assert.match(
    recipientSnapshotConflict(
      {
        recipientEmails: ["old@example.com"],
        recipientSnapshotState: "verified",
        fullTeamSend: false,
      },
      ["new@example.com"],
      false,
    ) ?? "",
    /conflict/,
  );
});

test("only the current immutable attempt protects a clean reusable outreach row", () => {
  const clean = {
    attemptCount: 0,
    providerMessageId: null,
    recipientSnapshotState: "verified",
  };

  assert.equal(hasProtectedCurrentSendState(clean, false), false);
  assert.equal(canReplaceUnattemptedOutreachSnapshot(clean, false), true);
  assert.equal(hasProtectedCurrentSendState(clean, true), true);
  assert.equal(canReplaceUnattemptedOutreachSnapshot(clean, true), false);
  assert.equal(
    canReplaceUnattemptedOutreachSnapshot(
      { ...clean, attemptCount: 1 },
      false,
    ),
    false,
  );
  assert.equal(
    canReplaceUnattemptedOutreachSnapshot(
      { ...clean, recipientSnapshotState: "legacy_unknown" },
      false,
    ),
    false,
  );
});

test("follow-up migration preserves original identity and enforces one child", () => {
  const migration = readFileSync(
    new URL(
      "../prisma/migrations/20260716210000_follow_up_outreach/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const schema = readFileSync(
    new URL("../prisma/schema.prisma", import.meta.url),
    "utf8",
  );

  assert.match(
    migration,
    /CREATE TYPE "OutreachKind" AS ENUM \('original', 'follow_up'\)/,
  );
  assert.match(
    migration,
    /"kind" "OutreachKind" NOT NULL DEFAULT 'original'/,
  );
  assert.match(migration, /UPDATE "Outreach" SET "kind" = 'original'/);
  assert.match(migration, /DROP INDEX "Outreach_showId_contactId_key"/);
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "Outreach_showId_contactId_kind_key"[\s\S]*"showId", "contactId", "kind"/,
  );
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "Outreach_parentOutreachId_key"/,
  );
  assert.match(
    migration,
    /"kind" = 'original'[\s\S]*"parentOutreachId" IS NULL[\s\S]*"kind" = 'follow_up'[\s\S]*"parentOutreachId" IS NOT NULL/,
  );
  assert.match(
    migration,
    /Follow-up parent must be an original outreach/,
  );
  assert.match(
    migration,
    /related\."contactId" IS DISTINCT FROM NEW\."contactId"/,
  );
  assert.match(migration, /Outreach kind and parent identity are immutable/);
  assert.match(migration, /DEFERRABLE INITIALLY IMMEDIATE/);
  assert.doesNotMatch(
    migration,
    /WHERE "contactId" IS NULL[\s\S]*CREATE UNIQUE INDEX/,
  );

  assert.match(schema, /enum OutreachKind \{\s*original\s*follow_up\s*\}/);
  assert.match(schema, /parentOutreachId\s+String\?\s+@unique/);
  assert.match(schema, /followUp\s+Outreach\?\s+@relation\("OutreachFollowUp"\)/);
  assert.match(schema, /@@unique\(\[showId, contactId, kind\]\)/);
});

test("follow-up send and schedule reuse the immutable child machinery", () => {
  const source = readFileSync(new URL("./sendOutreach.ts", import.meta.url), "utf8");
  const actions = readFileSync(
    new URL("../app/dashboard/actions.ts", import.meta.url),
    "utf8",
  );
  const festival = readFileSync(
    new URL("../app/festivals/[showId]/page.tsx", import.meta.url),
    "utf8",
  );
  const webhook = readFileSync(
    new URL("../app/api/resend/webhook/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /export async function sendFollowUp[\s\S]*prepareFollowUpOutreach[\s\S]*claimImmediateOutreach\(prep\)[\s\S]*executeClaimedSend/,
  );
  assert.match(
    source,
    /export async function scheduleFollowUp[\s\S]*prepareFollowUpOutreach[\s\S]*schedulePreparedOutreach/,
  );
  assert.match(
    source,
    /kind: prep\.kind,\s*parentOutreachId: prep\.parentOutreachId/,
  );
  assert.match(
    source,
    /preparedFollowUpBlockingReason[\s\S]*evaluateLockedOutreachDeliveryPolicy/,
  );
  assert.match(
    source,
    /where: \{\s*kind: "original",\s*showId: \{ in: showIds \}/,
  );
  assert.match(
    source,
    /isConclusiveRealOutreachAcceptance\(child, childAttempt\)/,
  );
  assert.match(
    source,
    /getFollowUpEligibilityBatch[\s\S]*getResendDeliverySettingsSnapshot[\s\S]*emailSuppression\.findMany[\s\S]*evaluateOutreachDeliveryPolicy/,
  );
  assert.match(
    source,
    /getFollowUpEligibilityBatch[\s\S]*festivalOutreachBlockingReason\(\s*show,\s*"follow_up",\s*now/,
  );
  assert.match(
    source,
    /preparedDeliveryPolicyBlockingReason[\s\S]*acquireOutreachRecipientPolicyLocks[\s\S]*testOverride: deliverySettings\.testOverride[\s\S]*bccEmails: deliverySettings\.bccEmails/,
  );
  assert.match(source, /Restore this festival before sending follow-up/);
  assert.match(
    source,
    /getOutreachSendabilityBatch[\s\S]*festivalOutreachBlockingReason\(show, "original"\)/,
  );
  assert.match(
    source,
    /claimScheduledOutreach[\s\S]*festivalOutreachBlockingReason\(\s*outreach\.show,\s*outreach\.kind/,
  );
  assert.match(
    source,
    /evaluateAttemptRetryEligibility\(\s*childAttempt,\s*now,\s*deliverySettings\.credentialScope/,
  );

  assert.match(
    actions,
    /export async function sendFollowUpAction[\s\S]*parentOutreachId[\s\S]*scheduleFollowUp[\s\S]*sendFollowUp/,
  );
  assert.match(
    source,
    /export async function cancelScheduledOutreach\(\s*outreachId: string/,
  );
  assert.match(
    source,
    /child\.status === "manual_review"[\s\S]*Follow-up requires manual review/,
  );
  assert.match(
    source,
    /child\.status === "cancelled"[\s\S]*isDefinitivelyUnsentOutreachAttempt\(childAttempt\)/,
  );
  assert.doesNotMatch(
    actions.slice(
      actions.indexOf("export async function sendFollowUpAction"),
      actions.indexOf("export async function cancelScheduledAction"),
    ),
    /formData\.get\("(showId|contactId)"\)/,
  );
  assert.match(
    actions,
    /result\.scheduled \? "followup_scheduled" : "followup_sent"/,
  );

  assert.match(
    festival,
    /kind: "original"[\s\S]*status: "test"/,
  );
  assert.doesNotMatch(
    festival.slice(
      festival.indexOf("async function bulkSend"),
      festival.indexOf("export default async function FestivalDetailPage"),
    ),
    /sendFollowUp|scheduleFollowUp/,
  );

  assert.match(
    webhook,
    /const outreach = await tx\.outreach\.findUnique\(\{\s*where: \{ id: attempt\.outreachId \}/,
  );
  assert.doesNotMatch(webhook, /parentOutreachId|parentOutreach/);
});

test("remediation migrations preserve unknown legacy recipients and quarantine attempts", () => {
  const reliability = readFileSync(
    new URL(
      "../prisma/migrations/20260716040000_outreach_reliability/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const attempts = readFileSync(
    new URL(
      "../prisma/migrations/20260716060000_outreach_send_attempts/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const credentialScope = readFileSync(
    new URL(
      "../prisma/migrations/20260716090000_resend_credential_scope/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(
    reliability,
    /"recipientSnapshotState" TEXT NOT NULL DEFAULT 'legacy_unknown'/,
  );
  assert.match(
    reliability,
    /"recipientEmails" TEXT\[\] NOT NULL DEFAULT ARRAY\[\]::TEXT\[\]/,
  );
  assert.match(
    attempts,
    /ADD COLUMN IF NOT EXISTS "recipientEmails"\s+TEXT\[\] NOT NULL DEFAULT ARRAY\[\]::TEXT\[\]/,
  );
  assert.doesNotMatch(reliability, /FROM "Contact" c/);
  assert.doesNotMatch(reliability, /'legacy_outreach'/);
  assert.match(
    attempts,
    /WHERE "attemptCount" > 0\s+AND "providerMessageId" IS NULL\s+AND NOT EXISTS/,
  );
  assert.match(
    attempts,
    /Legacy provider attempt has no immutable request snapshot; provider acceptance is uncertain/,
  );
  assert.match(
    attempts,
    /"recipientSnapshotState" = 'legacy_unknown'\s+AND "status" IN \('scheduled', 'queued', 'failed'\)/,
  );
  assert.match(
    attempts,
    /legacy_source\."effectiveProviderMessageId" IS NOT NULL\s+AND NOT legacy_source\."providerMessageIdConflict"\s+AND legacy_source\."status" = 'test'[\s\S]*legacy_source\."providerDeliveryFailureEvent"[\s\S]*\) AS "providerProvenTestSend"/,
  );
  assert.match(
    attempts,
    /legacy_source\."status" = 'failed'[\s\S]*legacy_source\."providerDeliveryFailureEvent"[\s\S]*legacy_source\."providerDeliveryEvidenceEvent"[\s\S]*\) AS "providerProvenRealFailure"/,
  );
  assert.match(
    attempts,
    /legacy_source\."status" = 'failed'[\s\S]*legacy_source\."providerBounceEvent"[\s\S]*NOT legacy_source\."providerDeliveryEvidenceEvent"[\s\S]*\) AS "ambiguousLegacyBounce"/,
  );
  assert.match(
    attempts,
    /WHEN legacy\."providerProvenRealSend" THEN 'accepted'[\s\S]*WHEN legacy\."providerProvenRealFailure" THEN 'delivery_failed'[\s\S]*WHEN legacy\."ambiguousLegacyBounce" THEN 'legacy_unknown'[\s\S]*ELSE 'legacy_unknown'/,
  );
  assert.match(
    attempts,
    /WHEN legacy\."providerProvenRealFailure"[\s\S]*OR legacy\."providerProvenRealSend"[\s\S]*THEN false/,
  );
  assert.match(
    attempts,
    /"testSend" BOOLEAN,\s+"providerMessageId"/,
  );
  assert.match(
    attempts,
    /OutreachSendAttempt_testSend_known_request_check"\s+CHECK \("providerRequest" IS NULL OR "testSend" IS NOT NULL\)/,
  );
  assert.match(
    attempts,
    /Legacy provider attempt cannot be verified as a real or test send; provider events are quarantined and replacement requires manual review/,
  );
  assert.match(
    attempts,
    /Legacy failed bounce may have been a test send; provider events are quarantined and real outreach may replace it/,
  );
  assert.match(
    attempts,
    /"providerMessageId" IS NULL[\s\S]*a\."status" = 'legacy_unknown'[\s\S]*Legacy failed bounce may have been a test send/,
  );
  assert.match(
    attempts,
    /"error" = COALESCE\(\s+a\."error",\s+'Legacy provider attempt cannot be verified/,
  );
  assert.match(
    attempts,
    /FROM "OutreachSendAttempt" a\s+WHERE a\."outreachId" = o\."id"[\s\S]*a\."status" = 'legacy_unknown';/,
  );
  assert.match(
    attempts,
    /Duplicate legacy provider message ID; review correlation manually'[\s\S]*"scheduledFor" = NULL/,
  );
  assert.match(attempts, /FROM "ResendWebhookEvent" e[\s\S]*e\."recipientEmails"/);
  assert.match(
    attempts,
    /WHERE a\."testSend" = false[\s\S]*INSERT INTO "EmailSuppression"/,
  );
  assert.doesNotMatch(attempts, /JOIN "Contact"/);
  assert.match(
    credentialScope,
    /ADD COLUMN "providerCredentialScope" TEXT/,
  );
  assert.match(
    credentialScope,
    /"providerCredentialScope" IS NULL[\s\S]*"firstAttemptAt" IS NOT NULL[\s\S]*"attemptCount" > 0[\s\S]*"status" = 'sending'[\s\S]*"failureDisposition" IN \('in_flight', 'uncertain'\)/,
  );
  assert.match(
    credentialScope,
    /SET\s+"status" = 'manual_review'[\s\S]*"failureDisposition" = COALESCE\("failureDisposition", 'uncertain'\)[\s\S]*"nextAttemptAt" = NULL/,
  );
  assert.match(
    credentialScope,
    /UPDATE "Outreach" o[\s\S]*"scheduledFor" = NULL[\s\S]*"nextAttemptAt" = NULL[\s\S]*FROM "OutreachSendAttempt" a[\s\S]*a\."idempotencyKey" = o\."idempotencyKey"/,
  );
  assert.match(
    credentialScope,
    /\^resend:key-sha256:\[0-9a-f\]\{64\}\$/,
  );
  assert.match(
    credentialScope,
    /providerCredentialScope_submission_check"[\s\S]*"status" = 'request_failed'[\s\S]*"failureDisposition" IN \('in_flight', 'uncertain'\)[\s\S]*'manual_review'[\s\S]*'legacy_unknown'/,
  );
  assert.match(
    credentialScope,
    /OLD\."providerCredentialScope" IS NOT NULL[\s\S]*NEW\."providerCredentialScope"[\s\S]*IS DISTINCT FROM OLD\."providerCredentialScope"[\s\S]*immutable once set/,
  );
});

test("legacy migration sequence preserves a later proven real send over an earlier bounce", () => {
  const reliability = readFileSync(
    new URL(
      "../prisma/migrations/20260716040000_outreach_reliability/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const attempts = readFileSync(
    new URL(
      "../prisma/migrations/20260716060000_outreach_send_attempts/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );

  const failureRewrite = reliability.slice(
    reliability.indexOf('UPDATE "Outreach"\nSET\n  "status" = \'failed\''),
    reliability.indexOf("-- Svix delivery IDs"),
  );
  assert.match(
    failureRewrite,
    /AND NOT \(\s+"status" = 'sent'\s+AND "sentAt" IS NOT NULL\s+AND "sentAt" > GREATEST\([\s\S]*"bouncedAt"[\s\S]*"complainedAt"[\s\S]*"providerMessageId" IS NOT NULL/,
  );

  const realSendDefinition = attempts.slice(
    attempts.indexOf('AS "ambiguousLegacyBounce"'),
    attempts.indexOf('AS "providerProvenRealSend"') + 28,
  );
  assert.match(
    realSendDefinition,
    /"effectiveProviderMessageId" IS NOT NULL[\s\S]*"status" = 'sent'[\s\S]*"sentAt" IS NOT NULL[\s\S]*"sentAt" > GREATEST/,
  );

  const statusCase = attempts.slice(
    attempts.indexOf('SELECT\n  legacy."id"'),
    attempts.indexOf('legacy."idempotencyKey"'),
  );
  assert.ok(
    statusCase.indexOf('WHEN legacy."providerProvenRealSend" THEN \'accepted\'') <
      statusCase.indexOf(
        'WHEN legacy."providerProvenRealFailure" THEN \'delivery_failed\'',
      ),
  );
  assert.ok(
    statusCase.indexOf(
      'WHEN legacy."providerProvenRealFailure" THEN \'delivery_failed\'',
    ) <
      statusCase.indexOf(
        'WHEN legacy."ambiguousLegacyBounce" THEN \'legacy_unknown\'',
      ),
  );

  const bouncedAt = new Date("2026-07-15T10:00:00.000Z");
  const sentAt = new Date("2026-07-15T11:00:00.000Z");
  const laterRealSend = {
    status: "sent",
    sentAt,
    bouncedAt,
    providerMessageId: "message-real",
    deliveryEvidence: false,
  };
  const preservedStatus =
    laterRealSend.status === "sent" &&
    laterRealSend.sentAt > laterRealSend.bouncedAt &&
    (laterRealSend.providerMessageId !== null ||
      laterRealSend.deliveryEvidence)
      ? "accepted"
      : "legacy_unknown";
  assert.equal(preservedStatus, "accepted");

  const ambiguousFailedBounce = {
    status: "failed",
    bouncedAt,
    deliveryEvidence: false,
  };
  assert.equal(
    ambiguousFailedBounce.status === "failed" &&
      ambiguousFailedBounce.bouncedAt !== null &&
      !ambiguousFailedBounce.deliveryEvidence
      ? "legacy_unknown"
      : "delivery_failed",
    "legacy_unknown",
  );
  assert.equal(
    {
      ...ambiguousFailedBounce,
      deliveryEvidence: true,
    }.deliveryEvidence
      ? "delivery_failed"
      : "legacy_unknown",
    "delivery_failed",
  );
});
