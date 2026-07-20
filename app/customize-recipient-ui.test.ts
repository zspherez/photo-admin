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
  assert.match(locked, /outreach\.fullTeamSend/);
  assert.match(locked, /stored: outreach/);
  assert.match(locked, /"updatedAt"/);
  assert.match(locked, /customizeRecipientIdentityError/);
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
    /recipients: currentPolicy\.currentRecipients,[\s\S]*fullTeamSend: currentPolicy\.fullTeamSend,[\s\S]*mode: "retry"/,
  );
});

test("default and bulk outreach calls retain existing recipient semantics", () => {
  const dashboardActions = source("app/dashboard/actions.ts");
  const festival = source("app/festivals/[showId]/page.tsx");
  const sendNow = dashboardActions.slice(
    dashboardActions.indexOf("export async function sendNowAction"),
    dashboardActions.indexOf("export async function sendFollowUpAction"),
  );

  assert.match(sendNow, /sendOutreach\(\{ showId, contactId \}\)/);
  assert.doesNotMatch(sendNow, /singleRecipient/);
  assert.match(festival, /sendOutreach\(\{ showId, contactId \}\)/);
});
