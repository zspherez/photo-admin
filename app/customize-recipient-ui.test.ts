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
  assert.match(form, /name="selectedContactId"/);
  assert.match(form, /value=\{selectedContactId\}/);
  assert.match(form, /useActionState\(action, initialState\)/);
  assert.match(page, /action=\{sendCustom\.bind\(null,/);
  assert.match(page, /returnTo: safeReturnTo/);
  assert.match(form, /<LinkButton href=\{returnTo\}/);
  assert.match(form, /<TemplateEditor[\s\S]*disabled=\{isRetry\}/);
  assert.match(
    form,
    /state\.selectedContactId === selectedContactId/,
  );
});

test("Customize actions validate the selected contact and preserve failures in place", () => {
  const actions = source(
    "app/dashboard/customize/[showId]/[contactId]/actions.ts",
  );

  assert.match(actions, /contextContactId/);
  assert.match(actions, /selectedContactId/);
  assert.match(actions, /workflowReturnPath\(context\.returnTo\)/);
  assert.match(actions, /customizeRecipientSelectionError\(/);
  assert.match(actions, /emailSuppression\.findUnique/);
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
