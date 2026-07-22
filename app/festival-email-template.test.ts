import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

function source(file: string): string {
  return readFileSync(path.join(process.cwd(), file), "utf8");
}

test("every original send path selects the show-purpose template before snapshotting", () => {
  const send = source("lib/sendOutreach.ts");
  const preparation = send.slice(
    send.indexOf("async function prepareOriginalOutreach"),
    send.indexOf("async function prepareFollowUpOutreach"),
  );
  const dashboardActions = source("app/dashboard/actions.ts");
  const festival = source("app/festivals/[showId]/page.tsx");

  assert.match(preparation, /ensureOriginalTemplateForShow\(show\)/);
  assert.match(preparation, /runAfterActionableTrajectoryValidation\(/);
  assert.ok(
    preparation.indexOf("runAfterActionableTrajectoryValidation") <
      preparation.indexOf("ensureOriginalTemplateForShow(show)"),
  );
  assert.match(preparation, /templateId: template\.id/);
  assert.match(preparation, /subject: normalizedSubjectOverride \|\| applyTemplate/);
  assert.match(preparation, /renderTrackedEmailHtml\(/);
  assert.match(send, /sendOutreach[\s\S]*prepareOriginalOutreach\(input\)/);
  assert.match(send, /scheduleOutreach[\s\S]*prepareOriginalOutreach\(input\)/);
  assert.match(
    dashboardActions,
    /sendOutreach\(\{\s*showId,\s*contactId,\s*trajectoryContext:/,
  );
  assert.match(
    dashboardActions,
    /scheduleOutreach\(\s*\{\s*showId,\s*contactId,\s*trajectoryContext:/,
  );
  assert.match(festival, /sendOutreach\(\{ showId, contactId \}\)/);
  assert.match(festival, /scheduleOutreach\(\{ showId, contactId \}/);
});

test("immediate and scheduled claims recheck template purpose before snapshots", () => {
  const send = source("lib/sendOutreach.ts");
  const immediate = send.slice(
    send.indexOf("async function claimImmediateOutreach"),
    send.indexOf("async function releasePreparationFailure"),
  );
  const schedule = send.slice(
    send.indexOf("async function schedulePreparedOutreach"),
    send.indexOf("export async function scheduleOutreach"),
  );

  for (const claim of [immediate, schedule]) {
    assert.match(claim, /withSerializableRetry/);
    assert.match(claim, /tx\.show\.findUnique/);
    assert.match(
      claim,
      /preparedTemplatePurposeBlockingReason\(\s*show,\s*prep/,
    );
    assert.ok(
      claim.indexOf("preparedTemplatePurposeBlockingReason") <
        claim.indexOf("finalSubject: prep.subject"),
    );
  }
  assert.match(send, /templatePurpose,\s*recipients:/);
  assert.match(send, /templatePurpose: "follow_up"/);
  assert.match(
    send,
    /RESEND_TEST_OVERRIDE|deliverySettings\.testOverride/,
  );
  assert.match(
    send,
    /isolationLevel: Prisma\.TransactionIsolationLevel\.Serializable/,
  );
});

test("Customize uses the festival template and still personalizes each selected manager", () => {
  const page = source(
    "app/dashboard/customize/[showId]/[contactId]/page.tsx",
  );
  const actions = source(
    "app/dashboard/customize/[showId]/[contactId]/actions.ts",
  );
  const pageBody = page.slice(page.indexOf("export default async function"));

  assert.match(page, /ensureOriginalTemplateForShow\(show\)/);
  assert.match(pageBody, /captureTrajectoryAction\(\s*safeReturnTo/);
  assert.match(pageBody, /runAfterActionableTrajectoryValidation\(/);
  assert.ok(
    pageBody.indexOf("runAfterActionableTrajectoryValidation") <
      pageBody.indexOf("ensureOriginalTemplateForShow(show)"),
  );
  assert.ok(
    pageBody.indexOf("redirect(capturedTemplate.errorHref)") <
      pageBody.indexOf("const template = capturedTemplate.value"),
  );
  assert.match(
    page,
    /eligibleContacts\.map\(async \(candidate\)[\s\S]*managerName: candidate\.name/,
  );
  assert.match(page, /eventName: show\.eventName/);
  assert.match(page, /renderCustomizeRecipientContent\(template, vars\)/);
  assert.match(actions, /contactId: selectedContactId/);
  assert.match(actions, /expectedRecipientIdentity/);
  assert.match(actions, /sendOutreach\(input\)/);
  assert.match(actions, /scheduleOutreach\(input, getNextMondaySlot\(\)\)/);
});

test("trajectory-aware original, follow-up, and customize paths validate before template writes", () => {
  const send = source("lib/sendOutreach.ts");
  const original = send.slice(
    send.indexOf("async function prepareOriginalOutreach"),
    send.indexOf("async function prepareFollowUpOutreach"),
  );
  const followUp = send.slice(
    send.indexOf("async function prepareFollowUpOutreach"),
    send.indexOf("async function currentAttempt"),
  );
  const customizeSource = source(
    "app/dashboard/customize/[showId]/[contactId]/page.tsx",
  );
  const customize = customizeSource.slice(
    customizeSource.indexOf("export default async function"),
  );

  for (const [pathName, preparation, provision] of [
    ["original", original, "ensureOriginalTemplateForShow"],
    ["follow-up", followUp, "ensureFollowUpTemplate"],
    ["customize", customize, "ensureOriginalTemplateForShow"],
  ] as const) {
    assert.match(preparation, /runAfterActionableTrajectoryValidation\(/);
    assert.ok(
      preparation.indexOf("runAfterActionableTrajectoryValidation") <
        preparation.indexOf(provision),
      `${pathName} validates before template provisioning`,
    );
  }

  assert.match(original, /captureTrajectoryPreparation\(/);
  assert.match(followUp, /captureTrajectoryPreparation\(/);
  assert.match(customize, /captureTrajectoryAction\(\s*safeReturnTo/);
  assert.match(customize, /redirect\(capturedTemplate\.errorHref\)/);
});

test("scheduled sends and retries retain stored festival snapshots", () => {
  const send = source("lib/sendOutreach.ts");
  const schedule = send.slice(
    send.indexOf("async function schedulePreparedOutreach"),
    send.indexOf("export async function scheduleOutreach"),
  );
  const scheduledClaim = send.slice(
    send.indexOf("async function claimScheduledOutreach"),
    send.indexOf("export async function dispatchScheduledOutreach"),
  );
  const claimedSnapshot = send.slice(
    send.indexOf("function claimedOutreach"),
    send.indexOf("async function markManualReview"),
  );

  assert.match(schedule, /finalSubject: prep\.subject/);
  assert.match(schedule, /finalHtml: prep\.html/);
  assert.match(schedule, /templateId: prep\.templateId/);
  assert.match(scheduledClaim, /outreach: claimedOutreach\(\s*claimed/);
  assert.match(claimedSnapshot, /finalSubject: row\.finalSubject/);
  assert.match(claimedSnapshot, /finalHtml: row\.finalHtml/);
  assert.doesNotMatch(scheduledClaim, /ensureOriginalTemplateForShow/);
});

test("Settings edits, previews, and resets normal and festival templates independently", () => {
  const settings = source("app/settings/template/page.tsx");
  const templates = source("lib/template.ts");

  assert.match(settings, /\["original", "festival", "follow_up"\]/);
  assert.match(settings, /if \(kind === "festival"\) return ensureFestivalTemplate\(\)/);
  assert.match(settings, /isFestival: kind === "festival"/);
  assert.match(settings, /supportedTemplateVars\(kind\)/);
  assert.match(settings, /unsupportedTemplateVars\(content, kind\)/);
  assert.match(settings, /malformedTemplateVariableTokens\(content\)/);
  assert.match(settings, /subject: DEFAULT_TEMPLATE_SUBJECT/);
  assert.match(settings, /htmlBody: DEFAULT_TEMPLATE_HTML/);
  assert.match(settings, /subject: FOLLOW_UP_TEMPLATE_SUBJECT/);
  assert.match(settings, /htmlBody: FOLLOW_UP_TEMPLATE_HTML/);
  assert.match(settings, /subject: FESTIVAL_TEMPLATE_SUBJECT/);
  assert.match(settings, /htmlBody: FESTIVAL_TEMPLATE_HTML/);
  assert.match(settings, /where: \{ id: existing\.id \}/);
  assert.match(settings, /templateUtmKind\(kind\)/);
  assert.match(
    settings,
    /previewHtml = renderTrackedEmailHtml\([\s\S]*template\.htmlBody/,
  );
  assert.match(
    templates,
    /where: \{ purpose: "festival" \},[\s\S]*update: \{\},[\s\S]*htmlBody: FESTIVAL_TEMPLATE_HTML/,
  );
});

test("festival template migration is transactional, preserving, constrained, and release-probed", () => {
  const migration = source(
    "prisma/migrations/20260721030000_festival_email_template/migration.sql",
  );
  const schema = source("prisma/schema.prisma");
  const releaseProbe = source("scripts/verify-release-compatibility.ts");

  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /CREATE TYPE "EmailTemplatePurpose"/);
  assert.match(migration, /SET "purpose" = 'original'[\s\S]*"isDefault" = true/);
  assert.match(migration, /SET "purpose" = 'follow_up'/);
  assert.match(migration, /SET "purpose" = 'festival'/);
  assert.match(migration, /WHERE NOT EXISTS \([\s\S]*"purpose" = 'festival'/);
  assert.match(migration, /CREATE UNIQUE INDEX "EmailTemplate_purpose_key"/);
  assert.match(migration, /EmailTemplate_canonical_purpose_default_check/);
  assert.match(migration, /EmailTemplate purpose is immutable once assigned/);
  assert.doesNotMatch(
    migration,
    /UPDATE "EmailTemplate"\s+SET "subject"|"htmlBody"\s*=/,
  );
  assert.match(migration, /COMMIT;\s*$/);
  assert.match(schema, /purpose\s+EmailTemplatePurpose\?\s+@unique/);
  assert.match(releaseProbe, /db\.emailTemplate\.findMany\([\s\S]*purpose: true/);
  assert.match(releaseProbe, /"EmailTemplate\.purpose"/);
});
