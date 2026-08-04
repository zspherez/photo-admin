import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  RESEND_IDEMPOTENCY_RETENTION_MS,
  RESEND_CONFIGURATION_ERROR,
  RESEND_FROM_EMAIL_CONFIGURATION_ERROR,
  RESEND_FROM_EMAIL_INVALID_CONFIGURATION_ERROR,
  RESEND_FULL_CONFIGURATION_ERROR,
  buildArbitraryResendDeliveryPolicy,
  bindProviderMessageIdAtIndex,
  buildResendRequestBatchSnapshot,
  duplicateProviderMessageIdConflict,
  buildResendDeliveryPolicy,
  canBindResendWebhookProviderMessage,
  canRetryResendRequest,
  classifyResendProviderError,
  compareResendRequestToPolicy,
  compareResendRequestBatchToPolicy,
  correlateResendWebhookAttempt,
  getResendConfigurationError,
  getResendCredentialScope,
  getResendSubmissionCredential,
  getResendWebhookFailurePolicy,
  hashAttachmentContent,
  hashResendRequestSnapshot,
  hashResendRequestBatchSnapshot,
  isValidResendSender,
  isProviderMessageIdConflictError,
  outreachWebhookRecipientImpact,
  markResendRequestDeliveryFailure,
  mergeResendRequestResults,
  resendRequestResultsAreResolved,
  parseResendRequestSnapshot,
  sendPreparedEmailViaResend,
  sendPreparedEmailBatchViaResend,
  summarizeResendRequestResults,
  validateProviderMessageIndex,
  shouldMirrorResendAttempt,
  type ResendRequestSnapshot,
} from "./resend";

const PDF_HASH = hashAttachmentContent(Buffer.from("pdf"));

const REQUEST: ResendRequestSnapshot = {
  version: 1,
  idempotencyKey: "outreach/outreach-1/attempt-1",
  from: "Sender <sender@example.com>",
  to: ["team@example.com"],
  cc: [],
  bcc: ["archive@example.com"],
  replyTo: [],
  subject: "Immutable subject",
  html: "<p>Immutable body</p>",
  headers: {
    "X-Outreach-Id": "outreach-1",
    "X-Outreach-Attempt-Id": "attempt-1",
  },
  tags: [
    { name: "outreach_id", value: "outreach-1" },
    { name: "outreach_attempt_id", value: "attempt-1" },
  ],
  attachments: [
    {
      filename: "historical-attachment.pdf",
      contentSha256: PDF_HASH,
      byteLength: 3,
      contentType: "application/pdf",
      contentId: null,
    },
  ],
};

test("immutable Resend request hashes include every provider-significant field", () => {
  const reorderedHeaders = {
    ...REQUEST,
    headers: {
      "X-Outreach-Attempt-Id": "attempt-1",
      "X-Outreach-Id": "outreach-1",
    },
  };
  assert.equal(
    hashResendRequestSnapshot(reorderedHeaders),
    hashResendRequestSnapshot(REQUEST),
  );

  const changedAttachment = {
    ...REQUEST,
    attachments: [
      {
        ...REQUEST.attachments[0],
        contentSha256: hashAttachmentContent(Buffer.from("changed")),
      },
    ],
  };
  assert.notEqual(
    hashResendRequestSnapshot(changedAttachment),
    hashResendRequestSnapshot(REQUEST),
  );
  assert.deepEqual(parseResendRequestSnapshot(REQUEST), REQUEST);
  const multipartRequest = { ...REQUEST, text: "Immutable body" };
  assert.deepEqual(
    parseResendRequestSnapshot(multipartRequest),
    multipartRequest,
  );
  assert.notEqual(
    hashResendRequestSnapshot(multipartRequest),
    hashResendRequestSnapshot(REQUEST),
  );
  assert.equal(
    parseResendRequestSnapshot({ ...REQUEST, subject: undefined }),
    null,
  );

});

test("Resend retries stop at the documented 24-hour retention boundary", () => {
  const firstAttemptAt = new Date("2026-07-16T00:00:00.000Z");
  assert.equal(
    canRetryResendRequest(
      firstAttemptAt,
      new Date(firstAttemptAt.getTime() + RESEND_IDEMPOTENCY_RETENTION_MS - 1),
    ),
    true,
  );
  assert.equal(
    canRetryResendRequest(
      firstAttemptAt,
      new Date(firstAttemptAt.getTime() + RESEND_IDEMPOTENCY_RETENTION_MS),
    ),
    false,
  );
});

test("missing and blank Resend credentials are configuration outages", () => {
  assert.equal(
    getResendConfigurationError(undefined, "Sender <sender@example.com>"),
    RESEND_CONFIGURATION_ERROR,
  );
  assert.equal(
    getResendConfigurationError("   ", "Sender <sender@example.com>"),
    RESEND_CONFIGURATION_ERROR,
  );
  assert.equal(
    getResendConfigurationError("re_configured", undefined),
    RESEND_FROM_EMAIL_CONFIGURATION_ERROR,
  );
  assert.equal(
    getResendConfigurationError("re_configured", "   "),
    RESEND_FROM_EMAIL_CONFIGURATION_ERROR,
  );
  assert.equal(
    getResendConfigurationError(undefined, undefined),
    RESEND_FULL_CONFIGURATION_ERROR,
  );
  assert.equal(
    getResendConfigurationError("re_configured", "malformed sender"),
    RESEND_FROM_EMAIL_INVALID_CONFIGURATION_ERROR,
  );
  assert.equal(isValidResendSender("sender@example.com"), true);
  assert.equal(isValidResendSender("Sender <sender@example.com>"), true);
  assert.equal(isValidResendSender("Sender <>"), false);
  assert.equal(isValidResendSender("one@example.com,two@example.com"), false);
  assert.equal(isValidResendSender("Sender <sender@example.com"), false);
});

test("Resend credential scopes are stable non-secret key fingerprints", () => {
  const scope = getResendCredentialScope("  re_original  ");
  assert.match(scope ?? "", /^resend:key-sha256:[0-9a-f]{64}$/);
  assert.equal(scope, getResendCredentialScope("re_original"));
  assert.notEqual(scope, getResendCredentialScope("re_rotated"));
  assert.equal(scope?.includes("re_original"), false);
  assert.equal(getResendCredentialScope("   "), null);
  assert.deepEqual(getResendSubmissionCredential(" re_original "), {
    apiKey: "re_original",
    scope,
  });
});

test("attachment content must match the immutable content-addressed snapshot", async () => {
  const result = await sendPreparedEmailViaResend(
    REQUEST,
    hashResendRequestSnapshot(REQUEST),
    [
      {
        sha256: PDF_HASH,
        content: Uint8Array.from(Buffer.from("bad")),
        byteLength: 3,
      },
    ],
    null,
  );
  assert.equal(result.providerMessageId, null);
  assert.equal(result.failureDisposition, "policy");
  assert.match(result.error ?? "", /attachment failed its identity or integrity check/);
});

test("Resend submission rejects a credential whose fingerprint does not match", async () => {
  const result = await sendPreparedEmailViaResend(
    REQUEST,
    hashResendRequestSnapshot(REQUEST),
    [
      {
        sha256: PDF_HASH,
        content: Uint8Array.from(Buffer.from("pdf")),
        byteLength: 3,
      },
    ],
    {
      apiKey: "re_original",
      scope: getResendCredentialScope("re_rotated")!,
    },
  );
  assert.equal(result.providerMessageId, null);
  assert.equal(result.failureDisposition, "policy");
  assert.match(result.error ?? "", /credential failed its scope integrity check/);
});

test("retry policy detects suppression, test-mode, BCC, and sender changes", () => {
  const current = buildResendDeliveryPolicy({
    from: REQUEST.from,
    intendedRecipients: REQUEST.to,
    subject: REQUEST.subject,
    testOverride: null,
    bccEmails: REQUEST.bcc,
    suppressedEmails: [],
  });

  assert.equal(current.ok, true);
  if (!current.ok) return;
  assert.equal(compareResendRequestToPolicy(REQUEST, false, current.policy), null);

  const testMode = buildResendDeliveryPolicy({
    from: REQUEST.from,
    intendedRecipients: REQUEST.to,
    subject: REQUEST.subject,
    testOverride: "test@example.com",
    bccEmails: REQUEST.bcc,
    suppressedEmails: [],
  });
  assert.equal(testMode.ok, true);
  if (testMode.ok) {
    assert.match(
      compareResendRequestToPolicy(REQUEST, false, testMode.policy) ?? "",
      /test mode is now enabled/,
    );
  }

  const changedSender = { ...current.policy, from: "new-sender@example.com" };
  assert.match(
    compareResendRequestToPolicy(REQUEST, false, changedSender) ?? "",
    /sender changed/,
  );

  const changedBcc = { ...current.policy, bcc: ["other@example.com"] };
  assert.match(
    compareResendRequestToPolicy(REQUEST, false, changedBcc) ?? "",
    /BCC policy changed/,
  );

  const suppressed = buildResendDeliveryPolicy({
    from: REQUEST.from,
    intendedRecipients: REQUEST.to,
    subject: REQUEST.subject,
    testOverride: null,
    bccEmails: REQUEST.bcc,
    suppressedEmails: REQUEST.to,
  });
  assert.deepEqual(suppressed, {
    ok: false,
    error: "All intended recipient addresses are suppressed or invalid",
  });

  assert.deepEqual(
    buildResendDeliveryPolicy({
      from: "   ",
      intendedRecipients: REQUEST.to,
      subject: REQUEST.subject,
      testOverride: null,
      bccEmails: [],
      suppressedEmails: [],
    }),
    { ok: false, error: "Missing RESEND_FROM_EMAIL" },
  );
  assert.deepEqual(
    buildResendDeliveryPolicy({
      from: "malformed sender",
      intendedRecipients: REQUEST.to,
      subject: REQUEST.subject,
      testOverride: null,
      bccEmails: [],
      suppressedEmails: [],
    }),
    {
      ok: false,
      error:
        "Invalid RESEND_FROM_EMAIL; expected email@example.com or Name <email@example.com>",
    },
  );
});

test("outreach CC mode uses one primary To recipient and snapshots CC on retries", () => {
  const result = buildResendDeliveryPolicy({
    from: REQUEST.from,
    intendedRecipients: ["other@example.com", "primary@example.com"],
    primaryRecipientEmail: "primary@example.com",
    recipientDeliveryMode: "cc_thread",
    subject: REQUEST.subject,
    testOverride: null,
    bccEmails: REQUEST.bcc,
    suppressedEmails: [],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.policy.primaryIntendedRecipient, "primary@example.com");
  assert.deepEqual(result.policy.to, ["primary@example.com"]);
  assert.deepEqual(result.policy.cc, ["other@example.com"]);

  const request = {
    ...REQUEST,
    to: result.policy.to,
    cc: result.policy.cc,
  };
  assert.equal(compareResendRequestToPolicy(request, false, result.policy), null);
  assert.match(
    compareResendRequestToPolicy(
      { ...request, cc: [] },
      false,
      result.policy,
    ) ?? "",
    /CC policy changed/,
  );
});

test("CC mode reanchors To after suppressing the preferred primary", () => {
  const result = buildResendDeliveryPolicy({
    from: REQUEST.from,
    intendedRecipients: ["other@example.com", "primary@example.com"],
    primaryRecipientEmail: "primary@example.com",
    recipientDeliveryMode: "cc_thread",
    subject: REQUEST.subject,
    testOverride: null,
    bccEmails: [],
    suppressedEmails: ["primary@example.com"],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.policy.primaryIntendedRecipient, "other@example.com");
  assert.deepEqual(result.policy.to, ["other@example.com"]);
  assert.deepEqual(result.policy.cc, []);
});

test("individual-thread outreach creates one private immutable request per recipient", async () => {
  const resolved = buildResendDeliveryPolicy({
    from: REQUEST.from,
    intendedRecipients: ["first@example.com", "second@example.com"],
    subject: REQUEST.subject,
    testOverride: null,
    bccEmails: ["audit@example.com", "second@example.com"],
    suppressedEmails: [],
    recipientDeliveryMode: "individual_threads",
  });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  const batch = buildResendRequestBatchSnapshot({
    policy: resolved.policy,
    recipientDeliveryMode: "individual_threads",
    html: REQUEST.html,
    outreachId: "outreach-private",
    attemptId: "attempt-private",
    idempotencyKey: "outreach/outreach-private/attempt-private",
  });
  assert.deepEqual(
    batch.requests.map((request) => ({
      to: request.to,
      cc: request.cc,
      bcc: request.bcc,
      idempotencyKey: request.idempotencyKey,
    })),
    [
      {
        to: ["first@example.com"],
        cc: [],
        bcc: ["audit@example.com"],
        idempotencyKey:
          "outreach/outreach-private/attempt-private/message/0",
      },
      {
        to: ["second@example.com"],
        cc: [],
        bcc: ["audit@example.com"],
        idempotencyKey:
          "outreach/outreach-private/attempt-private/message/1",
      },
    ],
  );
  assert.equal(
    batch.requests.some((request) => request.to.length !== 1),
    false,
  );

  const calls: string[] = [];
  const sent = await sendPreparedEmailBatchViaResend(
    batch,
    hashResendRequestBatchSnapshot(batch),
    [],
    null,
    [],
    async (request) => {
      calls.push(request.to[0]);
      return {
        providerMessageId: `message-${calls.length}`,
        error: null,
        failureDisposition: null,
      };
    },
  );
  assert.deepEqual(calls, ["first@example.com", "second@example.com"]);
  assert.deepEqual(
    sent.results.map((result) => result.providerMessageId),
    ["message-1", "message-2"],
  );
});

test("batch retries skip provider calls for already accepted message identities", async () => {
  const policy = buildResendDeliveryPolicy({
    from: REQUEST.from,
    intendedRecipients: ["first@example.com", "second@example.com"],
    subject: REQUEST.subject,
    testOverride: null,
    bccEmails: [],
    suppressedEmails: [],
    recipientDeliveryMode: "individual_threads",
  });

  test("individual retry policy compares requests by recipient identity, not row order", () => {
    const policy = buildResendDeliveryPolicy({
      from: REQUEST.from,
      intendedRecipients: ["first@example.com", "second@example.com"],
      subject: REQUEST.subject,
      testOverride: null,
      bccEmails: [],
      suppressedEmails: [],
      recipientDeliveryMode: "individual_threads",
    });
    assert.equal(policy.ok, true);
    if (!policy.ok) return;
    const batch = buildResendRequestBatchSnapshot({
      policy: policy.policy,
      recipientDeliveryMode: "individual_threads",
      html: REQUEST.html,
      outreachId: "outreach-reversed",
      attemptId: "attempt-reversed",
      idempotencyKey: "outreach/outreach-reversed/attempt-reversed",
    });
    assert.equal(
      compareResendRequestBatchToPolicy(
        { ...batch, requests: [...batch.requests].reverse() },
        false,
        policy.policy,
        "individual_threads",
      ),
      null,
    );
  });
  assert.equal(policy.ok, true);
  if (!policy.ok) return;
  const batch = buildResendRequestBatchSnapshot({
    policy: policy.policy,
    recipientDeliveryMode: "individual_threads",
    html: REQUEST.html,
    outreachId: "outreach-retry",
    attemptId: "attempt-retry",
    idempotencyKey: "outreach/outreach-retry/attempt-retry",
  });
  const calls: string[] = [];
  const result = await sendPreparedEmailBatchViaResend(
    batch,
    hashResendRequestBatchSnapshot(batch),
    [],
    null,
    [
      {
        providerMessageId: "message-existing",
        error: null,
        failureDisposition: null,
      },
      null,
    ],
    async (request) => {
      calls.push(request.to[0]);
      return {
        providerMessageId: "message-new",
        error: null,
        failureDisposition: null,
      };
    },
  );
  assert.deepEqual(calls, ["second@example.com"]);
  assert.deepEqual(
    result.results.map((entry) => entry.providerMessageId),
    ["message-existing", "message-new"],
  );
});

test("mixed batch outcomes preserve accepted indexes and let uncertainty dominate", async () => {
  const summary = summarizeResendRequestResults([
    {
      providerMessageId: null,
      error: "invalid recipient",
      failureDisposition: "permanent",
    },
    {
      providerMessageId: null,
      error: "connection reset",
      failureDisposition: "uncertain",
    },
    {
      providerMessageId: "message-accepted",
      error: null,
      failureDisposition: null,
    },
    {
      providerMessageId: null,
      error: "rate limited",
      failureDisposition: "retryable",
    },
  ]);
  assert.equal(summary.failureDisposition, "uncertain");
  assert.match(summary.error ?? "", /message 2: connection reset/);
  assert.equal(
    summarizeResendRequestResults([
      {
        providerMessageId: null,
        error: "invalid recipient",
        failureDisposition: "permanent",
      },
      {
        providerMessageId: null,
        error: "rate limited",
        failureDisposition: "retryable",
      },
    ]).failureDisposition,
    "retryable",
  );

  const policy = buildResendDeliveryPolicy({
    from: REQUEST.from,
    intendedRecipients: [
      "permanent@example.com",
      "uncertain@example.com",
      "accepted@example.com",
      "retryable@example.com",
    ],
    subject: REQUEST.subject,
    testOverride: null,
    bccEmails: [],
    suppressedEmails: [],
    recipientDeliveryMode: "individual_threads",
  });

  assert.equal(policy.ok, true);
  if (!policy.ok) return;
  const batch = buildResendRequestBatchSnapshot({
    policy: policy.policy,
    recipientDeliveryMode: "individual_threads",
    html: REQUEST.html,
    outreachId: "outreach-mixed",
    attemptId: "attempt-mixed",
    idempotencyKey: "outreach/outreach-mixed/attempt-mixed",
  });
  const prior = [
    {
      providerMessageId: "message-accepted",
      error: null,
      failureDisposition: null,
    },
    {
      providerMessageId: null,
      error: "invalid recipient",
      failureDisposition: "permanent" as const,
    },
    {
      providerMessageId: null,
      error: "rate limited",
      failureDisposition: "retryable" as const,
    },
    {
      providerMessageId: null,
      error: "connection reset",
      failureDisposition: "uncertain" as const,
    },
  ];
  const calls: string[] = [];
  const retried = await sendPreparedEmailBatchViaResend(
    batch,
    hashResendRequestBatchSnapshot(batch),
    [],
    null,
    prior,
    async (request) => {
      calls.push(request.to[0]);
      return {
        providerMessageId: "message-retried",
        error: null,
        failureDisposition: null,
      };
    },
  );
  assert.deepEqual(calls, ["retryable@example.com"]);
  assert.deepEqual(retried.results.slice(0, 2), prior.slice(0, 2));
  assert.equal(retried.results[2].providerMessageId, "message-retried");
  assert.deepEqual(retried.results[3], prior[3]);
});

test("accepted bounce stays per-message while pending indexes remain retryable", async () => {
  const partial = markResendRequestDeliveryFailure(
    [
      {
        providerMessageId: "message-accepted",
        error: null,
        failureDisposition: null,
      },
      null,
    ],
    0,
    "message-accepted",
    "bounce:permanent",
  );
  assert.equal(resendRequestResultsAreResolved(partial), false);
  assert.equal(partial[0]?.deliveryFailure, "bounce:permanent");

  const policy = buildResendDeliveryPolicy({
    from: REQUEST.from,
    intendedRecipients: ["accepted@example.com", "pending@example.com"],
    subject: REQUEST.subject,
    testOverride: null,
    bccEmails: [],
    suppressedEmails: [],
    recipientDeliveryMode: "individual_threads",
  });
  assert.equal(policy.ok, true);
  if (!policy.ok) return;
  const batch = buildResendRequestBatchSnapshot({
    policy: policy.policy,
    recipientDeliveryMode: "individual_threads",
    html: REQUEST.html,
    outreachId: "outreach-bounce-pending",
    attemptId: "attempt-bounce-pending",
    idempotencyKey:
      "outreach/outreach-bounce-pending/attempt-bounce-pending",
  });
  const calls: string[] = [];
  const retried = await sendPreparedEmailBatchViaResend(
    batch,
    hashResendRequestBatchSnapshot(batch),
    [],
    null,
    partial,
    async (request) => {
      calls.push(request.to[0]);
      return {
        providerMessageId: "message-pending",
        error: null,
        failureDisposition: null,
      };
    },
  );
  assert.deepEqual(calls, ["pending@example.com"]);
  const merged = mergeResendRequestResults(partial, retried.results);
  assert.equal(merged.conflict, null);
  assert.equal(resendRequestResultsAreResolved(merged.results), true);
  assert.equal(merged.results[0].deliveryFailure, "bounce:permanent");
  assert.equal(merged.results[1].providerMessageId, "message-pending");
});

test("webhook acceptance wins a race with an earlier uncertain provider return", async () => {
  const prior = [
    {
      providerMessageId: "message-webhook",
      error: null,
      failureDisposition: null,
    },
  ];
  const merged = mergeResendRequestResults(prior, [
    {
      providerMessageId: null,
      error: "connection reset",
      failureDisposition: "uncertain",
    },
  ]);
  assert.equal(merged.conflict, null);
  assert.deepEqual(merged.results, prior);
  assert.equal(
    summarizeResendRequestResults(merged.results).failureDisposition,
    null,
  );

  const policy = buildResendDeliveryPolicy({
    from: REQUEST.from,
    intendedRecipients: ["manager@example.com"],
    subject: REQUEST.subject,
    testOverride: null,
    bccEmails: [],
    suppressedEmails: [],
    recipientDeliveryMode: "individual_threads",
  });
  assert.equal(policy.ok, true);
  if (!policy.ok) return;
  const batch = buildResendRequestBatchSnapshot({
    policy: policy.policy,
    recipientDeliveryMode: "individual_threads",
    html: REQUEST.html,
    outreachId: "outreach-webhook-race",
    attemptId: "attempt-webhook-race",
    idempotencyKey:
      "outreach/outreach-webhook-race/attempt-webhook-race",
  });
  let calls = 0;
  const retry = await sendPreparedEmailBatchViaResend(
    batch,
    hashResendRequestBatchSnapshot(batch),
    [],
    null,
    merged.results,
    async () => {
      calls += 1;
      return {
        providerMessageId: "message-duplicate",
        error: null,
        failureDisposition: null,
      };
    },
  );
  assert.equal(calls, 0);
  assert.equal(retry.results[0].providerMessageId, "message-webhook");
});

test("conflicting accepted provider IDs preserve the prior acceptance and flag policy review", () => {
  const merged = mergeResendRequestResults(
    [
      {
        providerMessageId: "message-webhook",
        error: null,
        failureDisposition: null,
      },
    ],
    [
      {
        providerMessageId: "message-provider-call",
        error: null,
        failureDisposition: null,
      },
    ],
  );
  assert.match(merged.conflict ?? "", /Provider message ID conflict/);
  assert.equal(
    merged.results[0].providerMessageId,
    "message-webhook",
  );
});

test("same-index webhook provider conflicts preserve the original immutable ID", () => {
  assert.deepEqual(
    bindProviderMessageIdAtIndex(
      ["message-original", ""],
      2,
      0,
      "message-conflict",
    ),
    {
      providerMessageIds: ["message-original", ""],
      conflict:
        "Provider message ID conflict for request 1: message-original != message-conflict",
    },
  );
  assert.match(
    validateProviderMessageIndex(
      ["message-first", "message-second"],
      2,
      2,
      "message-out-of-range",
    ) ?? "",
    /outside the immutable request batch/,
  );
  assert.match(
    validateProviderMessageIndex(
      ["message-first", "message-second"],
      2,
      1,
      "message-first",
    ) ?? "",
    /already belongs to request 1/,
  );
  assert.equal(
    isProviderMessageIdConflictError(
      "Provider message ID conflict for request 1: original != conflict",
    ),
    true,
  );
  assert.deepEqual(
    bindProviderMessageIdAtIndex(["message-original", ""], 2, 0, "message-original"),
    {
      providerMessageIds: ["message-original", ""],
      conflict: null,
    },
  );
});

test("duplicate provider IDs across immutable indexes are rejected", () => {
  assert.equal(
    duplicateProviderMessageIdConflict([
      "message-duplicate",
      "message-duplicate",
    ]),
    "Provider message ID conflict for request 2: message-duplicate already belongs to request 1",
  );
  assert.equal(
    duplicateProviderMessageIdConflict([
      "message-first",
      "",
      "message-third",
    ]),
    null,
  );
});

test("test override matching an intended recipient still resolves to one provider request", () => {
  const resolved = buildResendDeliveryPolicy({
    from: REQUEST.from,
    intendedRecipients: ["first@example.com", "second@example.com"],
    subject: REQUEST.subject,
    testOverride: "first@example.com",
    bccEmails: [],
    suppressedEmails: [],
    recipientDeliveryMode: "individual_threads",
  });

  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.policy.testSend, true);
  const batch = buildResendRequestBatchSnapshot({
    policy: resolved.policy,
    recipientDeliveryMode: "individual_threads",
    html: REQUEST.html,
    outreachId: "outreach-test-collision",
    attemptId: "attempt-test-collision",
    idempotencyKey:
      "outreach/outreach-test-collision/attempt-test-collision",
  });
  assert.equal(batch.requests.length, 1);
  assert.deepEqual(batch.requests[0].to, ["first@example.com"]);
  assert.deepEqual(batch.requests[0].cc, []);
});

test("individual-thread BCC-only webhooks never affect outreach aggregates", () => {
  const request = {
    ...REQUEST,
    to: ["manager@example.com"],
    cc: [],
    bcc: ["audit@example.com"],
  };
  for (const fields of [
    { to: [], cc: [], bcc: ["audit@example.com"] },
    { bcc: ["AUDIT@example.com"] },
  ]) {
    assert.deepEqual(outreachWebhookRecipientImpact(request, fields), {
      impactedRecipients: ["audit@example.com"],
      affectsAggregate: false,
    });
  }
  assert.deepEqual(
    outreachWebhookRecipientImpact(request, {
      to: ["manager@example.com"],
      bcc: ["audit@example.com"],
    }),
    {
      impactedRecipients: ["audit@example.com", "manager@example.com"],
      affectsAggregate: true,
    },
  );
});

test("arbitrary multi-recipient delivery keeps recipients on To and audit copies on BCC", () => {
  const result = buildArbitraryResendDeliveryPolicy({
    from: "Photo Admin <sender@example.com>",
    intendedRecipients: [
      "first@example.com",
      "second@example.com",
      "FIRST@example.com",
    ],
    subject: "Private update",
    testOverride: null,
    bccEmails: ["audit@example.com", "second@example.com", "sender@example.com"],
    suppressedEmails: [],
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.policy.to, [
    "first@example.com",
    "second@example.com",
  ]);
  assert.deepEqual(result.policy.bcc, [
    "audit@example.com",
    "sender@example.com",
  ]);
  assert.deepEqual(result.policy.intendedRecipients, [
    "first@example.com",
    "second@example.com",
  ]);
});

test("arbitrary single-recipient and test-override delivery preserve expected routing", () => {
  const single = buildArbitraryResendDeliveryPolicy({
    from: "Photo Admin <sender@example.com>",
    intendedRecipients: ["person@example.com"],
    subject: "Direct update",
    testOverride: null,
    bccEmails: ["audit@example.com", "person@example.com"],
    suppressedEmails: [],
  });
  assert.equal(single.ok, true);
  if (single.ok) {
    assert.deepEqual(single.policy.to, ["person@example.com"]);
    assert.deepEqual(single.policy.bcc, ["audit@example.com"]);
  }

  const testOverride = buildArbitraryResendDeliveryPolicy({
    from: "Photo Admin <sender@example.com>",
    intendedRecipients: ["first@example.com", "second@example.com"],
    subject: "Private update",
    testOverride: "TEST@example.com",
    bccEmails: ["audit@example.com"],
    suppressedEmails: [],
  });
  assert.equal(testOverride.ok, true);
  if (testOverride.ok) {
    assert.deepEqual(testOverride.policy.to, ["test@example.com"]);
    assert.deepEqual(testOverride.policy.bcc, []);
    assert.equal(testOverride.policy.testSend, true);
    assert.equal(
      testOverride.policy.subject,
      "[TEST → first@example.com, second@example.com] Private update",
    );
  }
});

test("provider credential rejections are configuration outages without broadening content retries", () => {
  assert.equal(
    classifyResendProviderError({
      name: "invalid_api_key",
      statusCode: 401,
    }),
    "configuration",
  );
  assert.equal(
    classifyResendProviderError({
      name: "restricted_api_key",
      statusCode: 403,
    }),
    "configuration",
  );
  assert.equal(
    classifyResendProviderError({
      name: "validation_error",
      statusCode: 401,
    }),
    "configuration",
  );
  assert.equal(
    classifyResendProviderError({
      name: "validation_error",
      statusCode: 403,
      message: "A recipient field is invalid",
    }),
    "permanent",
  );
  assert.equal(
    classifyResendProviderError({
      name: "invalid_access",
      statusCode: 422,
    }),
    "configuration",
  );
  assert.equal(
    classifyResendProviderError({
      name: "rate_limit_exceeded",
      statusCode: 429,
    }),
    "retryable",
  );
  assert.equal(
    classifyResendProviderError({
      name: "validation_error",
      statusCode: 422,
    }),
    "permanent",
  );
  assert.equal(
    classifyResendProviderError({
      name: "daily_quota_exceeded",
      statusCode: 429,
    }),
    "configuration",
  );
  assert.equal(
    classifyResendProviderError({
      name: "monthly_quota_exceeded",
      statusCode: 429,
    }),
    "configuration",
  );
  assert.equal(
    classifyResendProviderError({
      name: "validation_error",
      statusCode: 403,
      message: "The example.com domain is not verified",
    }),
    "configuration",
  );
  assert.equal(
    classifyResendProviderError({
      name: "invalid_from_address",
      statusCode: 422,
    }),
    "configuration",
  );
  assert.equal(
    classifyResendProviderError({
      name: "concurrent_idempotent_requests",
      statusCode: 409,
    }),
    "in_flight",
  );
  assert.equal(
    classifyResendProviderError({
      name: "invalid_idempotent_request",
      statusCode: 409,
    }),
    "policy",
  );
  assert.equal(
    classifyResendProviderError({
      name: "internal_server_error",
      statusCode: 500,
    }),
    "uncertain",
  );
  assert.equal(
    classifyResendProviderError({
      name: "application_error",
      statusCode: null,
    }),
    "uncertain",
  );
});

test("webhook correlation rejects contradictory provider and attempt identities", () => {
  const oldAttempt = {
    id: "attempt-old",
    outreachId: "outreach-1",
    providerMessageId: "message-old",
  };
  const currentAttempt = {
    id: "attempt-current",
    outreachId: "outreach-1",
    providerMessageId: "message-current",
  };

  assert.deepEqual(
    correlateResendWebhookAttempt(
      {
        attemptId: oldAttempt.id,
        outreachId: oldAttempt.outreachId,
        providerMessageId: oldAttempt.providerMessageId,
      },
      oldAttempt,
      oldAttempt,
    ),
    { status: "matched", attempt: oldAttempt, bindProviderMessageId: false },
  );

  assert.deepEqual(
    correlateResendWebhookAttempt(
      {
        attemptId: currentAttempt.id,
        outreachId: currentAttempt.outreachId,
        providerMessageId: oldAttempt.providerMessageId,
      },
      currentAttempt,
      oldAttempt,
    ),
    {
      status: "conflict",
      reason: "attempt tag and provider message identify different attempts",
    },
  );

  assert.deepEqual(
    correlateResendWebhookAttempt(
      {
        attemptId: null,
        outreachId: "outreach-1",
        providerMessageId: "unknown-message",
      },
      null,
      null,
    ),
    {
      status: "unmatched",
      reason: "no immutable attempt matched the event",
    },
  );

  const uniqueOutreachAttempt = {
    id: "attempt-from-outreach-tag",
    outreachId: "outreach-2",
    providerMessageId: null,
    testSend: false,
  };
  assert.deepEqual(
    correlateResendWebhookAttempt(
      {
        attemptId: null,
        outreachId: uniqueOutreachAttempt.outreachId,
        providerMessageId: "message-from-webhook",
      },
      null,
      null,
      uniqueOutreachAttempt,
    ),
    {
      status: "matched",
      attempt: uniqueOutreachAttempt,
      bindProviderMessageId: true,
    },
  );

  const batchAttempt = {
    id: "attempt-batch",
    outreachId: "outreach-batch",
    providerMessageId: "message-first",
    providerMessageIds: ["message-first", "message-second"],
  };
  assert.deepEqual(
    correlateResendWebhookAttempt(
      {
        attemptId: batchAttempt.id,
        outreachId: batchAttempt.outreachId,
        providerMessageId: "message-second",
      },
      batchAttempt,
      batchAttempt,
    ),
    {
      status: "matched",
      attempt: batchAttempt,
      bindProviderMessageId: false,
    },
  );
  const completeBatchAttempt = {
    ...batchAttempt,
    providerRequest: {
      version: 1,
      requests: [
        { ...REQUEST, idempotencyKey: "batch/message/0" },
        { ...REQUEST, idempotencyKey: "batch/message/1" },
      ],
    },
  };
  assert.deepEqual(
    correlateResendWebhookAttempt(
      {
        attemptId: completeBatchAttempt.id,
        outreachId: completeBatchAttempt.outreachId,
        providerMessageId: "message-conflict",
      },
      completeBatchAttempt,
      null,
    ),
    {
      status: "matched",
      attempt: completeBatchAttempt,
      bindProviderMessageId: true,
    },
  );
  const partialBatchAttempt = {
    ...batchAttempt,
    providerMessageId: null,
    providerMessageIds: ["message-first", ""],
    providerRequest: {
      version: 1,
      requests: [
        { ...REQUEST, idempotencyKey: "batch/message/0" },
        { ...REQUEST, idempotencyKey: "batch/message/1" },
      ],
    },
  };
  assert.deepEqual(
    correlateResendWebhookAttempt(
      {
        attemptId: partialBatchAttempt.id,
        outreachId: partialBatchAttempt.outreachId,
        providerMessageId: "message-second",
      },
      partialBatchAttempt,
      null,
    ),
    {
      status: "matched",
      attempt: partialBatchAttempt,
      bindProviderMessageId: true,
    },
  );
});

test("test failures isolate while unknown legacy webhooks stay quarantined", () => {
  const testAttempt = {
    id: "attempt-test",
    outreachId: "outreach-1",
    providerMessageId: "message-test",
    testSend: true,
  };
  assert.deepEqual(
    correlateResendWebhookAttempt(
      {
        attemptId: testAttempt.id,
        outreachId: testAttempt.outreachId,
        providerMessageId: testAttempt.providerMessageId,
      },
      testAttempt,
      testAttempt,
    ),
    {
      status: "matched",
      attempt: testAttempt,
      bindProviderMessageId: false,
    },
  );
  assert.deepEqual(getResendWebhookFailurePolicy(testAttempt), {
    applySuppression: false,
    mirrorOutreachFailure: false,
    preserveTestOutreachState: true,
    processAttemptEvents: true,
  });
  assert.deepEqual(
    getResendWebhookFailurePolicy({ testSend: false }),
    {
      applySuppression: true,
      mirrorOutreachFailure: true,
      preserveTestOutreachState: false,
      processAttemptEvents: true,
    },
  );
  assert.deepEqual(getResendWebhookFailurePolicy(null), {
    applySuppression: false,
    mirrorOutreachFailure: false,
    preserveTestOutreachState: false,
    processAttemptEvents: false,
  });

  for (const attempt of [
    { status: "legacy_unknown", testSend: false },
    { status: "manual_review", testSend: null },
    { status: "accepted", testSend: null },
  ]) {
    assert.deepEqual(
      getResendWebhookFailurePolicy(attempt),
      {
        applySuppression: false,
        mirrorOutreachFailure: false,
        preserveTestOutreachState: false,
        processAttemptEvents: false,
      },
    );
  }
  assert.deepEqual(
    getResendWebhookFailurePolicy({
      status: "manual_review",
      testSend: false,
    }),
    {
      applySuppression: true,
      mirrorOutreachFailure: true,
      preserveTestOutreachState: false,
      processAttemptEvents: true,
    },
  );
  assert.equal(
    canBindResendWebhookProviderMessage({
      status: "manual_review",
      testSend: false,
      providerCredentialScope: null,
    }),
    true,
  );
  assert.equal(
    canBindResendWebhookProviderMessage({
      status: "legacy_unknown",
      testSend: false,
    }),
    false,
  );
  assert.equal(
    canBindResendWebhookProviderMessage({
      status: "manual_review",
      testSend: null,
    }),
    false,
  );

  const route = readFileSync(
    new URL("../app/api/resend/webhook/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    route,
    /testSend: null,\s+status: \{ in: \["legacy_unknown", "manual_review"\] \}/,
  );
  assert.match(route, /!canBindResendWebhookProviderMessage\(correlation\.attempt\)/);
  assert.match(route, /outreachAttempts\.length === 1/);
  assert.match(
    route,
    /recipientEmails: impactedRecipients/,
  );
  assert.ok(
    route.indexOf("if (!failurePolicy.processAttemptEvents)") <
      route.indexOf(
        "const attempt = await tx.outreachSendAttempt.findUnique",
      ),
  );
});

test("late provider acceptance mirrors only the current immutable identity", () => {
  const attempt = {
    idempotencyKey: "outreach/outreach-1/attempt-1",
    providerMessageId: "message-1",
  };
  for (const status of [
    "retry_scheduled",
    "request_failed",
    "cancelled",
    "manual_review",
  ]) {
    assert.equal(
      shouldMirrorResendAttempt(
        {
          status,
          idempotencyKey: attempt.idempotencyKey,
          providerMessageId: null,
        },
        attempt,
      ),
      true,
    );
    assert.equal(
      shouldMirrorResendAttempt(
        {
          idempotencyKey: attempt.idempotencyKey,
          providerMessageId: "message-1",
          providerMessageIds: ["message-1"],
        },
        {
          ...attempt,
          providerMessageIds: ["message-1", "message-2"],
        },
      ),
      true,
    );
    assert.equal(
      shouldMirrorResendAttempt(
        {
          idempotencyKey: attempt.idempotencyKey,
          providerMessageId: "message-conflict",
          providerMessageIds: ["message-conflict"],
        },
        {
          ...attempt,
          providerMessageIds: ["message-1", "message-2"],
        },
      ),
      false,
    );
  }
  assert.equal(
    shouldMirrorResendAttempt(
      {
        idempotencyKey: attempt.idempotencyKey,
        providerMessageId: attempt.providerMessageId,
      },
      attempt,
    ),
    true,
  );
  assert.equal(
    shouldMirrorResendAttempt(
      {
        idempotencyKey: "outreach/outreach-1/attempt-2",
        providerMessageId: null,
      },
      attempt,
    ),
    false,
  );
  assert.equal(
    shouldMirrorResendAttempt(
      {
        idempotencyKey: attempt.idempotencyKey,
        providerMessageId: "message-other",
      },
      attempt,
    ),
    false,
  );

  const route = readFileSync(
    new URL("../app/api/resend/webhook/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /shouldMirrorResendAttempt\(outreach, attempt\)/);
  assert.match(
    route,
    /failureDisposition: null,[\s\S]*nextAttemptAt: null/,
  );
  assert.match(
    route,
    /providerMessageId: primaryProviderMessageId[\s\S]*providerMessageIds,[\s\S]*scheduledFor: null[\s\S]*nextAttemptAt: null/,
  );
  const providerBindingGuard = route.slice(
    route.indexOf("correlation.bindProviderMessageId &&"),
    route.indexOf("if (", route.indexOf("correlation.bindProviderMessageId &&") + 1),
  );
  assert.doesNotMatch(providerBindingGuard, /status === "manual_review"/);
});

test("late delay and generic failure events preserve terminal delivery failures", () => {
  const route = readFileSync(
    new URL("../app/api/resend/webhook/route.ts", import.meta.url),
    "utf8",
  );
  const delayed = route.slice(
    route.indexOf('case "email.delivery_delayed"'),
    route.indexOf('case "email.failed"'),
  );
  const failed = route.slice(
    route.indexOf('case "email.failed"'),
    route.indexOf("default:", route.indexOf('case "email.failed"')),
  );

  assert.match(delayed, /if \(hadDeliveryFailure\) break;/);
  assert.match(failed, /if \(hadDeliveryFailure\) break;/);
});
