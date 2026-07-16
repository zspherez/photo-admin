import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const APP_DIR = path.join(process.cwd(), "app");
const PUBLIC_ACTION_FILES = new Set(["app/login/page.tsx"]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(fullPath);
    return /\.[jt]sx?$/.test(entry.name) && !entry.name.includes(".test.")
      ? [fullPath]
      : [];
  });
}

function hasDirective(body: ts.Block, directive: string): boolean {
  return body.statements.some(
    (statement) =>
      ts.isExpressionStatement(statement) &&
      ts.isStringLiteral(statement.expression) &&
      statement.expression.text === directive,
  );
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    Boolean(
      ts
        .getModifiers(node)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
    )
  );
}

function firstOperativeStatement(body: ts.Block): ts.Statement | undefined {
  return body.statements.find(
    (statement) =>
      !(
        ts.isExpressionStatement(statement) &&
        ts.isStringLiteral(statement.expression) &&
        statement.expression.text === "use server"
      ),
  );
}

test("every protected Server Action starts with the reusable auth guard", () => {
  const actions: Array<{
    file: string;
    name: string;
    sourceFile: ts.SourceFile;
    body: ts.Block;
  }> = [];

  for (const file of sourceFiles(APP_DIR)) {
    const relativePath = path.relative(process.cwd(), file);
    if (PUBLIC_ACTION_FILES.has(relativePath)) continue;

    const source = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const fileUsesServer = sourceFile.statements.some(
      (statement) =>
        ts.isExpressionStatement(statement) &&
        ts.isStringLiteral(statement.expression) &&
        statement.expression.text === "use server",
    );

    if (fileUsesServer) {
      for (const statement of sourceFile.statements) {
        if (
          ts.isFunctionDeclaration(statement) &&
          statement.body &&
          hasExportModifier(statement)
        ) {
          actions.push({
            file: relativePath,
            name: statement.name?.text ?? "(default)",
            sourceFile,
            body: statement.body,
          });
        }
        if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            const initializer = declaration.initializer;
            if (
              initializer &&
              (ts.isArrowFunction(initializer) ||
                ts.isFunctionExpression(initializer)) &&
              ts.isBlock(initializer.body)
            ) {
              actions.push({
                file: relativePath,
                name: declaration.name.getText(sourceFile),
                sourceFile,
                body: initializer.body,
              });
            }
          }
        }
      }
      continue;
    }

    const visit = (node: ts.Node) => {
      if (
        (ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isArrowFunction(node) ||
          ts.isMethodDeclaration(node)) &&
        node.body &&
        ts.isBlock(node.body) &&
        hasDirective(node.body, "use server")
      ) {
        actions.push({
          file: relativePath,
          name:
            "name" in node && node.name
              ? node.name.getText(sourceFile)
              : "(anonymous)",
          sourceFile,
          body: node.body,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  assert.ok(actions.length > 0, "Expected to find protected Server Actions");
  for (const action of actions) {
    const firstStatement = firstOperativeStatement(action.body);
    assert.ok(
      firstStatement
        ?.getText(action.sourceFile)
        .includes("requireServerActionAuth("),
      `${action.file}:${action.name} must authenticate before doing any work`,
    );
  }
});
