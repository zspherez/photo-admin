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
});

test("festival customize links do not require a listening signal", () => {
  assert.match(
    source,
    /const canCustomize =\s*outreachEnabled &&\s*!!r\.contact &&\s*r\.sendability\?\.mode !== "retry";/
  );
  assert.match(source, /\{canCustomize && r\.contact && \(/);
  assert.doesNotMatch(
    source,
    /canCustomize[\s\S]{0,100}r\.matched/
  );
});

test("festival sendability and bulk queueing do not require listen signals", () => {
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
  assert.match(bulk, /sendFestivalManagerOutreach/);
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
