import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  RESEND_IDEMPOTENCY_RETENTION_MS,
  RESEND_CONFIGURATION_ERROR,
  RESEND_FROM_EMAIL_CONFIGURATION_ERROR,
  RESEND_FROM_EMAIL_INVALID_CONFIGURATION_ERROR,
  RESEND_FULL_CONFIGURATION_ERROR,
  RATE_CARD_MISSING_WARNING,
  ResendPreparationError,
  buildResendDeliveryPolicy,
  canBindResendWebhookProviderMessage,
  canRetryResendRequest,
  classifyResendProviderError,
  compareResendRequestToPolicy,
  correlateResendWebhookAttempt,
  getResendConfigurationError,
  getResendCredentialScope,
  getResendSubmissionCredential,
  getResendWebhookFailurePolicy,
  hashAttachmentContent,
  hashResendRequestSnapshot,
  isValidResendSender,
  loadRateCardAttachments,
  parseResendRequestSnapshot,
  sendPreparedEmailViaResend,
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
      filename: "rate-card.pdf",
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

test("confirmed missing rate cards are omitted but other download failures remain explicit", async () => {
  const missingUrl = await loadRateCardAttachments(
    {
      source: "https://example.com/missing.pdf",
      filename: "missing.pdf",
      kind: "url",
      exists: true,
    },
    {
      fetchImpl: async () => new Response(null, { status: 404 }),
    },
  );
  assert.deepEqual(missingUrl.warnings, [RATE_CARD_MISSING_WARNING]);
  assert.equal(missingUrl.rateCardAttachmentOmitted, true);
  assert.deepEqual(missingUrl.snapshots, []);

  const missingFile = await loadRateCardAttachments(
    {
      source: "missing.pdf",
      filename: "missing.pdf",
      kind: "file",
      exists: false,
    },
    {
      readFileImpl: async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    },
  );
  assert.equal(missingFile.rateCardAttachmentOmitted, true);

  for (const status of [408, 429, 503]) {
    await assert.rejects(
      loadRateCardAttachments(
        {
          source: "https://example.com/broken.pdf",
          filename: "broken.pdf",
          kind: "url",
          exists: true,
        },
        {
          fetchImpl: async () => new Response(null, { status }),
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof ResendPreparationError);
        assert.equal(error.preparationDisposition, "retryable");
        assert.match(error.message, new RegExp(`HTTP ${status}`));
        return true;
      },
    );
  }

  await assert.rejects(
    loadRateCardAttachments(
      {
        source: "https://example.com/network.pdf",
        filename: "network.pdf",
        kind: "url",
        exists: true,
      },
      {
        fetchImpl: async () => {
          throw new TypeError("fetch failed");
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ResendPreparationError);
      assert.equal(error.preparationDisposition, "retryable");
      assert.match(error.message, /fetch failed/);
      return true;
    },
  );

  await assert.rejects(
    loadRateCardAttachments(
      {
        source: "https://example.com/bad-request.pdf",
        filename: "bad-request.pdf",
        kind: "url",
        exists: true,
      },
      {
        fetchImpl: async () => new Response(null, { status: 400 }),
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ResendPreparationError);
      assert.equal(error.preparationDisposition, "permanent");
      return true;
    },
  );

  await assert.rejects(
    loadRateCardAttachments(
      {
        source: "forbidden.pdf",
        filename: "forbidden.pdf",
        kind: "file",
        exists: true,
      },
      {
        readFileImpl: async () => {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ResendPreparationError);
      assert.equal(error.preparationDisposition, "permanent");
      assert.match(error.message, /permission denied/);
      return true;
    },
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
  assert.match(route, /recipientEmails: normalizeEmails\(parsed\.data\.to/);
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
    /failureDisposition: hadDeliveryFailure[\s\S]*nextAttemptAt: null/,
  );
  assert.match(
    route,
    /providerMessageId: attempt\.providerMessageId[\s\S]*scheduledFor: null[\s\S]*nextAttemptAt: null/,
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
