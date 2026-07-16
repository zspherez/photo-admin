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
});
