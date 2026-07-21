import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

function source(file: string): string {
  return readFileSync(path.join(process.cwd(), file), "utf8");
}

test("Customize defaults to the URL contact and preserves editor navigation state", () => {
  const page = source(
    "app/dashboard/customize/[showId]/[contactId]/page.tsx",
  );
  const form = source(
    "app/dashboard/customize/[showId]/[contactId]/customize-form.tsx",
  );

  assert.match(page, /contextContactId=\{contactId\}/);
  assert.match(page, /singleRecipient: true/);
  assert.match(page, /eligibleCustomizeRecipientContacts\(/);
  assert.match(form, /useState\(contextContactId\)/);
  assert.match(form, /const \[drafts, setDrafts\]/);
  assert.match(form, /name="selectedContactId"/);
  assert.match(form, /value=\{selectedContactId\}/);
  assert.match(form, /name="expectedRecipientEmail"/);
  assert.match(form, /name="expectedRecipientArtistId"/);
  assert.match(form, /name="expectedRecipientUpdatedAt"/);
  assert.match(form, /useActionState\(action, initialState\)/);
  assert.match(page, /action=\{sendCustom\.bind\(null,/);
  assert.match(page, /returnTo: safeReturnTo/);
  assert.match(form, /<LinkButton href=\{returnTo\}/);
  assert.match(form, /<TemplateEditor[\s\S]*disabled=\{isRetry\}/);
  assert.match(form, /subjectValue=\{selectedDraft\.subject\}/);
  assert.match(form, /htmlValue=\{selectedDraft\.html\}/);
  assert.match(
    form,
    /state\.selectedContactId === selectedContactId/,
  );
});

test("Customize renders and preserves a separate personalized draft per contact", () => {
  const page = source(
    "app/dashboard/customize/[showId]/[contactId]/page.tsx",
  );
  const form = source(
    "app/dashboard/customize/[showId]/[contactId]/customize-form.tsx",
  );

  assert.match(
    page,
    /eligibleContacts\.map\(async \(candidate\)[\s\S]*managerName: candidate\.name/,
  );
  assert.match(page, /renderCustomizeRecipientContent\(template, vars\)/);
  assert.match(form, /initializeCustomizeRecipientDrafts\(recipientOptions\)/);
  assert.match(form, /updateCustomizeRecipientDraft\(/);
});

test("Customize actions validate the selected contact and preserve failures in place", () => {
  const actions = source(
    "app/dashboard/customize/[showId]/[contactId]/actions.ts",
  );

  assert.match(actions, /contextContactId/);
  assert.match(actions, /selectedContactId/);
  assert.match(actions, /workflowReturnPath\(context\.returnTo\)/);
  assert.match(actions, /customizeRecipientSelectionError\(/);
  assert.match(actions, /customizeRecipientIdentityError\(/);
  assert.match(actions, /emailSuppression\.findUnique/);
  assert.match(actions, /expectedRecipientIdentity/);
  assert.match(
    actions,
    /getOutreachSendabilityBatch\(\[[\s\S]*singleRecipient: true/,
  );
  assert.match(actions, /sendOutreach\(input\)/);
  assert.match(actions, /scheduleOutreach\(input, getNextMondaySlot\(\)\)/);
  assert.match(
    actions,
    /scheduleOutreach\(input, getNextNormalOutreachDispatch\(\)\)/,
  );
  assert.match(actions, /intent === "queue"/);
  assert.match(actions, /return actionError\(selectedContactId/);
  assert.doesNotMatch(
    actions,
    /dashboardResultHref\(returnTo, "error"/,
  );
});

test("immutable retries load their stored preview and lock recipient selection", () => {
  const page = source(
    "app/dashboard/customize/[showId]/[contactId]/page.tsx",
  );
  const form = source(
    "app/dashboard/customize/[showId]/[contactId]/customize-form.tsx",
  );

  assert.match(page, /retryOutreachIds/);
  assert.match(page, /finalSubject: true/);
  assert.match(page, /finalHtml: true/);
  assert.match(page, /recipientEmails: true/);
  assert.match(page, /recipientSnapshotState === "verified"/);
  assert.match(page, /subject: validRetrySnapshot\.finalSubject/);
  assert.match(page, /html: validRetrySnapshot\.finalHtml/);
  assert.match(page, /retryContactId:/);
  assert.match(form, /disabled=\{isRetry\}/);
  assert.match(form, /immutable retry content is unavailable/);
});

test("immediate, scheduled, and retry delivery use the selected immutable snapshot", () => {
  const send = source("lib/sendOutreach.ts");
  const prepare = send.slice(
    send.indexOf("async function prepareOriginalOutreach"),
    send.indexOf("async function prepareFollowUpOutreach"),
  );
  const immediate = send.slice(
    send.indexOf("async function claimImmediateOutreach"),
    send.indexOf("async function releasePreparationFailure"),
  );
  const schedule = send.slice(
    send.indexOf("async function schedulePreparedOutreach"),
    send.indexOf("export async function scheduleOutreach"),
  );
  const locked = send.slice(
    send.indexOf("async function evaluateLockedOutreachDeliveryPolicy"),
    send.indexOf("function blockedSendability"),
  );

  assert.match(prepare, /singleRecipient/);
  assert.match(prepare, /recipients: sendability\.recipients/);
  assert.match(prepare, /fullTeamSend: sendability\.fullTeamSend/);
  assert.match(immediate, /recipientEmails: prep\.recipients/);
  assert.match(immediate, /fullTeamSend: prep\.fullTeamSend/);
  assert.match(schedule, /recipientEmails: prep\.recipients/);
  assert.match(schedule, /fullTeamSend: prep\.fullTeamSend/);
  assert.match(schedule, /finalSubject: prep\.subject/);
  assert.match(schedule, /finalHtml: prep\.html/);
  assert.match(
    schedule,
    /expectedRecipientIdentityData\(prep\.expectedRecipientIdentity\)/,
  );
  assert.match(schedule, /sameExpectedRecipientIdentity\(/);
  assert.match(
    schedule,
    /scheduled\.finalSubject === prep\.subject[\s\S]*scheduled\.finalHtml === prep\.html[\s\S]*scheduled\.scheduledFor\?\.getTime\(\) === scheduledFor\.getTime\(\)[\s\S]*ok: true/,
  );
  assert.match(locked, /outreach\.fullTeamSend/);
  assert.match(locked, /stored: outreach/);
  assert.match(locked, /"updatedAt"/);
  assert.match(locked, /customizeRecipientIdentityError/);
  assert.match(
    locked,
    /if \(identityError\)[\s\S]*state: "manual_review"/,
  );
  assert.match(
    send,
    /preparedDeliveryPolicyBlockingReason[\s\S]*FROM "Contact"[\s\S]*FOR UPDATE/,
  );
  const preparedPolicy = send.slice(
    send.indexOf("async function preparedDeliveryPolicyBlockingReason"),
    send.indexOf("async function claimImmediateOutreach"),
  );
  assert.ok(
    preparedPolicy.indexOf('FOR UPDATE') <
      preparedPolicy.indexOf("getResendDeliverySettingsSnapshot(tx)"),
  );
  assert.match(
    send,
    /expectedRecipientIdentity: outreach\.expectedRecipientIdentity/,
  );
  assert.match(
    send,
    /expectedRecipientIdentity: storedExpectedRecipientIdentity\(row\)/,
  );
  assert.match(
    send,
    /recipients: currentPolicy\.currentRecipients,[\s\S]*fullTeamSend: currentPolicy\.fullTeamSend,[\s\S]*mode: "retry"/,
  );
});

test("scheduled Customize identity is persisted and constrained as one snapshot", () => {
  const send = source("lib/sendOutreach.ts");
  const migration = source(
    "prisma/migrations/20260721050000_queue_next_dispatch/migration.sql",
  );

  assert.match(send, /expectedRecipientContactId: identity\?\.contactId/);
  assert.match(send, /expectedRecipientArtistId: identity\?\.artistId/);
  assert.match(send, /expectedRecipientEmail: identity\?\.normalizedEmail/);
  assert.match(
    send,
    /expectedRecipientUpdatedAt: identity[\s\S]*new Date\(identity\.updatedAt\)/,
  );
  assert.match(
    send,
    /updatedAt: row\.expectedRecipientUpdatedAt!\.toISOString\(\)/,
  );
  assert.match(
    migration,
    /Outreach_expected_recipient_identity_check[\s\S]*expectedRecipientContactId" IS NULL[\s\S]*expectedRecipientUpdatedAt" IS NULL[\s\S]*expectedRecipientContactId" IS NOT NULL[\s\S]*expectedRecipientUpdatedAt" IS NOT NULL/,
  );
});

test("legacy contact schedules are safely backfilled without guessing changed identity", () => {
  const migration = source(
    "prisma/migrations/20260721050000_queue_next_dispatch/migration.sql",
  );
  const quarantine = migration.slice(
    migration.indexOf('UPDATE "Outreach" AS outreach'),
    migration.indexOf(
      'UPDATE "Outreach" AS outreach',
      migration.indexOf('UPDATE "Outreach" AS outreach') + 1,
    ),
  );
  const backfill = migration.slice(
    migration.indexOf(
      'UPDATE "Outreach" AS outreach',
      migration.indexOf('UPDATE "Outreach" AS outreach') + 1,
    ),
    migration.indexOf('ALTER TABLE "Outreach"', 200),
  );

  for (const block of [quarantine, backfill]) {
    assert.match(block, /'queued',\s+'scheduled',\s+'retry_scheduled',\s+'failed'/);
    assert.match(block, /contact\."artistId" = outreach\."artistId"/);
    assert.match(block, /contact\."state" = 'active'/);
    assert.match(block, /contact\."updatedAt" <= outreach\."createdAt"/);
    assert.match(
      block,
      /unnest\(outreach\."recipientEmails"\)[\s\S]*lower\(btrim\(recipient\."email"\)\) = lower\(btrim\(contact\."email"\)\)/,
    );
    assert.doesNotMatch(block, /fullTeamSend|templateId|singleRecipient/);
  }
  assert.match(
    quarantine,
    /"status" = 'manual_review'[\s\S]*"contactId" IS NULL[\s\S]*OR NOT EXISTS/,
  );
  assert.match(quarantine, /contact\."email" IS NOT NULL/);
  assert.match(quarantine, /scheduledFor" = NULL/);
  assert.match(quarantine, /claimToken" = NULL/);
  assert.match(
    backfill,
    /"expectedRecipientContactId" = contact\."id"[\s\S]*"expectedRecipientEmail" = lower\(btrim\(contact\."email"\)\)[\s\S]*"expectedRecipientUpdatedAt" = contact\."updatedAt"/,
  );
  assert.doesNotMatch(migration, /UPDATE "OutreachSendAttempt"/);
});

test("dispatch identity constraint rejects old writers while preserving terminal history", () => {
  const migration = source(
    "prisma/migrations/20260721050000_queue_next_dispatch/migration.sql",
  );
  const constraint = migration.slice(
    migration.indexOf(
      'ADD CONSTRAINT "Outreach_dispatch_recipient_identity_check"',
    ),
    migration.indexOf('ALTER TABLE "ArbitraryEmail"'),
  );

  assert.match(
    constraint,
    /"status" NOT IN \('queued', 'scheduled', 'retry_scheduled'\)/,
  );
  assert.match(
    constraint,
    /OR "contactId" IS NULL[\s\S]*"expectedRecipientContactId" IS NOT NULL[\s\S]*"expectedRecipientUpdatedAt" IS NOT NULL/,
  );
  assert.match(
    constraint,
    /"expectedRecipientContactId" = "contactId"[\s\S]*"expectedRecipientArtistId" = "artistId"/,
  );
  assert.doesNotMatch(constraint, /'sent'|'test'|'cancelled'|'manual_review'/);

  const dispatchIdentityAllowed = ({
    status,
    contactId,
    expectedContactId,
    expectedArtistId,
    artistId,
    expectedEmail,
    expectedUpdatedAt,
  }: {
    status: string;
    contactId: string | null;
    expectedContactId: string | null;
    expectedArtistId: string | null;
    artistId: string;
    expectedEmail: string | null;
    expectedUpdatedAt: Date | null;
  }) =>
    !["queued", "scheduled", "retry_scheduled"].includes(status) ||
    contactId === null ||
    (expectedContactId !== null &&
      expectedArtistId !== null &&
      expectedEmail !== null &&
      expectedUpdatedAt !== null &&
      expectedContactId === contactId &&
      expectedArtistId === artistId);

  const identitylessOldWriter = {
    status: "scheduled",
    contactId: "contact-1",
    expectedContactId: null,
    expectedArtistId: null,
    artistId: "artist-1",
    expectedEmail: null,
    expectedUpdatedAt: null,
  };
  assert.equal(dispatchIdentityAllowed(identitylessOldWriter), false);
  assert.equal(
    dispatchIdentityAllowed({ ...identitylessOldWriter, status: "sent" }),
    true,
  );
  assert.equal(
    dispatchIdentityAllowed({
      ...identitylessOldWriter,
      contactId: null,
    }),
    true,
  );
  assert.equal(
    dispatchIdentityAllowed({
      ...identitylessOldWriter,
      expectedContactId: "contact-1",
      expectedArtistId: "artist-1",
      expectedEmail: "manager@example.com",
      expectedUpdatedAt: new Date("2026-07-20T12:00:00.000Z"),
    }),
    true,
  );
});

test("Customize exposes the shared next-dispatch target without changing Send now", () => {
  const page = source(
    "app/dashboard/customize/[showId]/[contactId]/page.tsx",
  );
  const form = source(
    "app/dashboard/customize/[showId]/[contactId]/customize-form.tsx",
  );

  assert.match(page, /formatNextDispatchActionLabel\(/);
  assert.match(page, /getNextNormalOutreachDispatch\(\)/);
  assert.match(form, /name="intent"[\s\S]*value="send"/);
  assert.match(form, /name="intent"[\s\S]*value="queue"/);
  assert.match(form, /\{queueLabel\}/);
  assert.match(form, /Email queued for \{state\.queuedFor\} ET/);
  assert.match(form, /subjectValue=\{selectedDraft\.subject\}/);
  assert.match(form, /htmlValue=\{selectedDraft\.html\}/);
});

test("default and bulk outreach calls retain existing recipient semantics", () => {
  const dashboardActions = source("app/dashboard/actions.ts");
  const festival = source("app/festivals/[showId]/page.tsx");
  const sendNow = dashboardActions.slice(
    dashboardActions.indexOf("export async function sendNowAction"),
    dashboardActions.indexOf("export async function sendFollowUpAction"),
  );

  assert.match(
    sendNow,
    /sendOutreach\(\{\s*showId,\s*contactId,\s*trajectoryContext:/,
  );
  assert.doesNotMatch(sendNow, /singleRecipient/);
  assert.match(festival, /sendOutreach\(\{ showId, contactId \}\)/);

  const send = source("lib/sendOutreach.ts");
  const original = send.slice(
    send.indexOf("async function prepareOriginalOutreach"),
    send.indexOf("async function prepareFollowUpOutreach"),
  );
  const followUp = send.slice(
    send.indexOf("async function prepareFollowUpOutreach"),
    send.indexOf("async function currentAttempt"),
  );
  assert.match(original, /customizeRecipientIdentity\(contact\)/);
  assert.match(
    original,
    /expectedRecipientIdentity:\s*expectedRecipientIdentity \?\? currentRecipientIdentity/,
  );
  assert.match(followUp, /email: true/);
  assert.match(followUp, /updatedAt: true/);
  assert.match(
    followUp,
    /expectedRecipientIdentity = customizeRecipientIdentity\(parent\.contact\)/,
  );
  assert.match(followUp, /expectedRecipientIdentity,/);
});
