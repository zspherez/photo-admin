import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(
  new URL("./festivals/[showId]/page.tsx", import.meta.url),
  "utf8",
);
const sourceFile = ts.createSourceFile(
  "page.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

function tagName(node: ts.JsxTagNameExpression): string {
  return node.getText(sourceFile);
}

function attribute(
  attributes: ts.JsxAttributes,
  name: string,
): ts.JsxAttribute | undefined {
  return attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) &&
      property.name.getText(sourceFile) === name,
  );
}

function isIdentifierExpression(
  value: ts.JsxAttribute | undefined,
  identifier: string,
): boolean {
  return Boolean(
    value?.initializer &&
      ts.isJsxExpression(value.initializer) &&
      value.initializer.expression &&
      ts.isIdentifier(value.initializer.expression) &&
      value.initializer.expression.text === identifier,
  );
}

test("festival outreach forms are valid and explicitly associated", () => {
  let bulkFormFound = false;
  let cancelFormFound = false;
  let managerResearchFormFound = false;
  let queueOutreachFormFound = false;
  let manualArtistFormFound = false;
  let bulkManualArtistFormFound = false;
  let manualRemovalFormFound = false;
  let contactCheckboxFound = false;

  const visit = (node: ts.Node, formDepth: number) => {
    let childFormDepth = formDepth;

    if (ts.isJsxElement(node) && tagName(node.openingElement.tagName) === "form") {
      assert.equal(formDepth, 0, "Festival detail must never render nested forms");
      childFormDepth += 1;
      const attributes = node.openingElement.attributes;
      if (
        isIdentifierExpression(attribute(attributes, "action"), "bulkSend")
      ) {
        bulkFormFound = isIdentifierExpression(
          attribute(attributes, "id"),
          "bulkFormId",
        );
      }
      if (
        isIdentifierExpression(
          attribute(attributes, "action"),
          "cancelScheduledAction",
        )
      ) {
        cancelFormFound = true;
      }
      if (
        isIdentifierExpression(
          attribute(attributes, "action"),
          "queueFestivalManagerResearch",
        )
      ) {
        managerResearchFormFound = true;
      }
      if (
        isIdentifierExpression(
          attribute(attributes, "action"),
          "queueFestivalOutreach",
        )
      ) {
        queueOutreachFormFound = true;
      }
      if (
        isIdentifierExpression(
          attribute(attributes, "action"),
          "removeManualFestivalArtist",
        )
      ) {
        manualRemovalFormFound = true;
      }
    }

    if (
      ts.isJsxSelfClosingElement(node) &&
      tagName(node.tagName) === "input"
    ) {
      const name = attribute(node.attributes, "name");
      if (
        name?.initializer &&
        ts.isStringLiteral(name.initializer) &&
        name.initializer.text === "contactIds"
      ) {
        contactCheckboxFound = isIdentifierExpression(
          attribute(node.attributes, "form"),
          "bulkFormId",
        );
      }
    }
    if (
      ts.isJsxSelfClosingElement(node) &&
      tagName(node.tagName) === "FestivalBulkOutreachForm"
    ) {
      bulkFormFound =
        isIdentifierExpression(attribute(node.attributes, "action"), "bulkSend") &&
        isIdentifierExpression(attribute(node.attributes, "formId"), "bulkFormId");
    }
    if (
      ts.isJsxSelfClosingElement(node) &&
      tagName(node.tagName) === "ManualFestivalArtistForm"
    ) {
      manualArtistFormFound = true;
    }
    if (
      ts.isJsxSelfClosingElement(node) &&
      tagName(node.tagName) === "BulkManualFestivalArtistForm"
    ) {
      bulkManualArtistFormFound = true;
    }

    ts.forEachChild(node, (child) => visit(child, childFormDepth));
  };

  visit(sourceFile, 0);
  assert.equal(bulkFormFound, true, "Bulk submit controls need a named form");
  assert.equal(
    contactCheckboxFound,
    true,
    "Artist checkboxes must explicitly target the bulk form",
  );
  assert.equal(
    cancelFormFound,
    true,
    "Cancellation must remain an independent form action",
  );
  assert.equal(
    managerResearchFormFound,
    true,
    "Festival pages need an independent manager-research action",
  );
  assert.equal(
    queueOutreachFormFound,
    true,
    "Festival pages need a one-click queue-outreach action",
  );
  assert.equal(
    manualArtistFormFound,
    true,
    "Festival pages need an independent manual-artist form",
  );
  assert.equal(
    bulkManualArtistFormFound,
    true,
    "Festival pages need an independent bulk manual-lineup form",
  );
  assert.equal(
    manualRemovalFormFound,
    true,
    "Manual lineup rows need an independent removal action",
  );
});

test("manual mark target does not collide with trajectory attribution", () => {
  assert.match(
    source,
    /name="targetArtistId"[\s\S]*value=\{r\.artist\.id\}/,
  );
  const markFormStart = source.indexOf("<form action={markSentAction}>");
  const markForm = source.slice(
    markFormStart,
    source.indexOf("</form>", markFormStart),
  );
  assert.doesNotMatch(markForm, /name="artistId"/);
});

test("festival manager research UI reflects the full eligible lineup", () => {
  assert.match(
    source,
    /const managerResearchCount = rows\.filter\(\s*\(row\) => row\.managerResearchEligible\s*\)\.length;/
  );
  assert.match(source, /Research managers \(\{managerResearchCount\}\)/);
  assert.match(
    source,
    /disabled=\{!festivalActive \|\| managerResearchCount === 0\}/
  );
  assert.match(
    source,
    /\{r\.managerResearchEligible && \(\s*<Badge tone="warning">Manager needed<\/Badge>/
  );
  assert.doesNotMatch(
    source,
    /managerResearchCount = rows\.filter\([\s\S]{0,100}\.matched/
  );
  assert.match(
    source,
    /filter === "manager_needed" && !r\.managerResearchEligible/,
  );
  assert.match(
    source,
    /\{ key: "manager_needed", label: "Manager needed" \}/,
  );
});

test("festival customize links do not require a listening signal", () => {
  assert.match(
    source,
    /const canCustomize =\s*outreachEnabled &&\s*!!r\.contact &&\s*!r\.followUpEligibility &&\s*r\.sendability\?\.mode !== "retry";/
  );
  assert.match(source, /\{canCustomize && r\.contact && \(/);
  assert.doesNotMatch(
    source,
    /canCustomize[\s\S]{0,100}r\.matched/
  );
});

test("festival sendability and bulk queueing do not require listen signals", () => {
  assert.match(source, /const BULK_SCHEDULE_CONCURRENCY = 1/);
  assert.match(source, /const BULK_ACTION_BUDGET_MS = 260_000/);
  assert.match(source, /const BULK_ACTION_MIN_START_BUDGET_MS = 70_000/);
  assert.match(
    source,
    /const SCHEDULED_WORKFLOW_START_WINDOW_MS = 15 \* 60 \* 1000/,
  );
  assert.ok(
    (source.match(/hasFestivalBulkActionBudget\(deadlineAt\)/g)?.length ?? 0) >=
      2,
  );
  for (const actionName of ["bulkSend", "queueFestivalOutreach"]) {
    const actionStart = source.indexOf(`async function ${actionName}`);
    const auth = source.indexOf("await requireServerActionAuth", actionStart);
    const deadline = source.indexOf(
      "const deadlineAt = Date.now() + BULK_ACTION_BUDGET_MS",
      actionStart,
    );
    assert.ok(actionStart >= 0 && auth > actionStart && deadline > auth);
  }
  assert.match(source, /rerun to process the remaining artists/);
  assert.match(
    source,
    /async \(group\) => \{[\s\S]*const immediateSchedule = new Date\(Date\.now\(\) \+ 60_000\)[\s\S]*nextScheduledOutreachPoll\(immediateSchedule\)/,
  );
  assert.match(
    source,
    /isWeekendET\(nextDispatcherPoll\) \|\|[\s\S]*isWeekendET\(dispatcherWindowEnd\)[\s\S]*getNextMondaySlot\(immediateSchedule\)/,
  );
  const bulk = source.slice(
    source.indexOf("async function bulkSend"),
    source.indexOf("async function queueFestivalOutreach"),
  );
  assert.match(bulk, /scheduleFestivalManagerOutreach/);
  assert.match(bulk, /scheduleOutreach/);
  assert.doesNotMatch(bulk, /sendFestivalManagerOutreach\(/);
  assert.doesNotMatch(bulk, /\bsendOutreach\(/);
  assert.ok(
    (source.match(/errors\.splice\(/g)?.length ?? 0) >= 2,
  );
  assert.doesNotMatch(
    source.slice(
      source.indexOf("async function festivalBulkCandidates"),
      source.indexOf("async function bulkSend"),
    ),
    /pickTopListenSignal/,
  );
  assert.match(source, /Queue outreach \(\{contactIds\.length\}\)/);
  assert.match(source, /getNextNormalOutreachDispatch\(now\)/);
  assert.match(source, /groupFestivalManagerTargets/);
  assert.match(source, /scheduleFestivalManagerOutreach/);
  assert.match(
    source,
    /const canSend =\s*outreachEnabled &&\s*r\.sendability\?\.sendable === true/,
  );
  assert.doesNotMatch(
    source,
    /const disabledReason = !r\.matched[\s\S]*No active listen signal/,
  );
});

test("selected festival sends use the same manager grouping as queue-all", () => {
  const bulk = source.slice(
    source.indexOf("async function bulkSend"),
    source.indexOf("async function queueFestivalOutreach"),
  );
  assert.match(bulk, /groupFestivalManagerTargets/);
  assert.match(bulk, /scheduleFestivalManagerOutreach/);
  assert.match(bulk, /scheduleFestivalManagerOutreach/);
  assert.match(source, /FestivalBulkOutreachForm/);
  assert.match(source, /bulkConfirmationCandidates/);
  assert.match(
    source,
    /!result\.fullTeamSend &&[\s\S]*recipients\.length === 1/,
  );
  assert.match(
    source,
    /!row\.sendability\.fullTeamSend &&[\s\S]*recipients\.length === 1/,
  );
});

test("festival individual outreach snapshots all active management contacts", () => {
  assert.ok(
    (source.match(/festivalAllContacts: true/g)?.length ?? 0) >= 3,
  );
  assert.match(
    source,
    /!row\.sendability\.fullTeamSend &&[\s\S]*groupKey: shareable/,
  );
});

test("festival confirmation submits the optional immutable all-To delivery mode", () => {
  assert.match(source, /recipientDeliveryMode/);
  assert.match(source, /isSelectableRecipientDeliveryMode/);
  assert.match(
    source,
    /festivalAllContacts: true,[\s\S]*recipientDeliveryMode/,
  );
  const form = readFileSync(
    new URL("../components/festival-bulk-outreach-form.tsx", import.meta.url),
    "utf8",
  );
  assert.match(form, /Keep management contacts on one email thread/);
  assert.match(form, /Put every management contact in To/);
  assert.match(form, /name="recipientDeliveryMode"/);
  assert.match(form, /recipientDeliveryLayout/);
});

test("covered artists keep shared outreach status and actions without a current contact", () => {
  assert.match(source, /const coveredOutreach =/);
  assert.match(source, /storedOutreachLabel\(r\.coveredOutreach\)/);
  assert.match(
    source,
    /r\.coveredOutreach &&[\s\S]*isCancellableOutreachStatus\(r\.coveredOutreach\.status\)/,
  );
  assert.match(
    source,
    /\{outreachEnabled && r\.followUpEligibility && \(/,
  );
});

test("festival rows show provider-tracked delivery and engagement badges", () => {
  for (const field of ["sentAt", "deliveredAt", "openCount", "clickCount"]) {
    assert.match(source, new RegExp(`${field}: true`));
  }
  assert.match(
    source,
    /const engagementOutreach = outreachHistory\.find\([\s\S]*outreach\.id !== manualMarker\?\.id[\s\S]*outreach\.status !== "test"[\s\S]*outreach\.providerMessageId !== null/,
  );
  assert.match(
    source,
    /\{r\.engagementOutreach && \(\s*<OutreachDeliveryBadges[\s\S]*outreach=\{r\.engagementOutreach\}/,
  );
});

test("festival pages persist an optional UTM campaign for all festival email kinds", () => {
  assert.match(source, /async function saveFestivalUtmCampaign/);
  assert.match(source, /requireServerActionAuth/);
  assert.match(source, /normalizeFestivalUtmCampaign/);
  assert.match(
    source,
    /data: \{ festivalUtmCampaign \}/,
  );
  assert.match(source, /name="festivalUtmCampaign"/);
  assert.match(source, /Festival UTM campaign saved\./);

  const send = readFileSync(
    new URL("../lib/sendOutreach.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    (send.match(/festivalUtmCampaign/g)?.length ?? 0) >= 5,
  );
  assert.match(
    send,
    /show\.isFestival \? show\.festivalUtmCampaign : null/,
  );
  assert.match(
    send,
    /parent\.show\.isFestival[\s\S]*parent\.show\.festivalUtmCampaign/,
  );

  const migration = readFileSync(
    new URL(
      "../prisma/migrations/20260731013000_festival_utm_campaign/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(migration, /^BEGIN;\n/);
  assert.match(migration, /ADD COLUMN "festivalUtmCampaign" TEXT/);
  assert.doesNotMatch(migration, /"isFestival" = true/);
  assert.match(migration, /BETWEEN 1 AND 200/);
  assert.match(migration, /\nCOMMIT;\s*$/);
});
