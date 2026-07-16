import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const APP_DIR = path.join(process.cwd(), "app");

function pageFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return pageFiles(fullPath);
    return entry.name === "page.tsx" ? [fullPath] : [];
  });
}

function isExported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    Boolean(
      ts
        .getModifiers(node)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
    )
  );
}

test("every navigable App Router page defines route-specific metadata", () => {
  const missing: string[] = [];

  for (const file of pageFiles(APP_DIR)) {
    const sourceFile = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const hasMetadata = sourceFile.statements.some((statement) => {
      if (
        ts.isFunctionDeclaration(statement) &&
        statement.name?.text === "generateMetadata"
      ) {
        return isExported(statement);
      }
      if (!ts.isVariableStatement(statement) || !isExported(statement)) {
        return false;
      }
      return statement.declarationList.declarations.some(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === "metadata",
      );
    });

    if (!hasMetadata) missing.push(path.relative(process.cwd(), file));
  }

  assert.deepEqual(missing, []);
});
