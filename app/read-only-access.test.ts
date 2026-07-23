import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

function source(file: string): string {
  return readFileSync(path.join(process.cwd(), file), "utf8");
}

test("read-only mode is visible and blocks mutation form submissions", () => {
  const layout = source("app/layout.tsx");
  const blocker = source("components/read-only-mode.tsx");
  const page = source("app/read-only/page.tsx");

  assert.match(layout, /access === "read_only" && <ReadOnlyMode \/>/);
  assert.match(blocker, /document\.addEventListener\("submit"/);
  assert.match(blocker, /form\.method\.toLowerCase\(\)/);
  assert.match(blocker, /method === "get"/);
  assert.match(blocker, /\/api\/auth\/logout/);
  assert.match(blocker, /event\.preventDefault\(\)/);
  assert.match(page, /cannot save changes/);
  assert.doesNotMatch(source("app/login/page.tsx"), /submittedPassword\.trim/);
});

test("Spotify OAuth requires full admin access before any credential mutation", () => {
  const login = source("app/api/spotify/login/route.ts");
  const callback = source("app/api/spotify/callback/route.ts");

  assert.match(login, /hasWriteAccess/);
  assert.match(login, /status: 403/);
  assert.match(callback, /hasWriteAccess/);
  assert.match(callback, /admin_access_required/);
  assert.ok(
    callback.indexOf("hasWriteAccess") < callback.indexOf("saveTokens(tokens)"),
  );
});

test("page rendering reads template defaults without seeding or normalizing rows", () => {
  const settings = source("app/settings/template/page.tsx");
  const customize = source(
    "app/dashboard/customize/[showId]/[contactId]/page.tsx",
  );
  const templates = source("lib/template.ts");

  assert.match(settings, /readTemplate\(kind\)/);
  assert.match(customize, /readOriginalTemplateForShow\(show\)/);
  assert.match(settings, /access === "read_only"/);
  assert.match(customize, /access === "read_only"/);
  assert.match(settings, /readOnlyTemplateForPurpose\(kind\)/);
  assert.match(customize, /readOnlyTemplateForPurpose/);
  assert.match(
    customize,
    /access === "read_only"[\s\S]*renderedContentByContact\.get\(candidate\.id\)/,
  );
  assert.match(
    templates,
    /readTemplateForPurpose[\s\S]*emailTemplate\.findUnique/,
  );
  assert.match(templates, /if \(!template\) return fallbackTemplate\(purpose\)/);
  const reader = templates.slice(
    templates.indexOf("export async function readTemplateForPurpose"),
    templates.indexOf("export function readOriginalTemplateForShow"),
  );
  assert.doesNotMatch(reader, /upsert|update|create/);
  assert.match(templates, /Lorem ipsum outreach preview/);
  assert.match(
    templates,
    /Lorem ipsum dolor sit amet, consectetur adipiscing elit/,
  );
});

test("read-only dashboard rendering never creates or deletes snapshots", () => {
  const dashboardPage = source("app/dashboard/page.tsx");
  const match = source("lib/match.ts");
  const batchRoute = source("app/api/dashboard/shows/route.ts");

  assert.match(dashboardPage, /getReadOnlyDashboardData\(query, now\)/);
  const reader = match.slice(
    match.indexOf("export async function getReadOnlyDashboardData"),
  );
  assert.match(reader, /db\.show\.findMany/);
  assert.doesNotMatch(
    reader,
    /dashboardShowSnapshot\.(create|delete|deleteMany)|dashboardShowSnapshotMember\.create/,
  );
  assert.match(reader, /nextCursor: null/);
  assert.match(
    batchRoute,
    /getSessionAccess[\s\S]*=== "read_only"[\s\S]*status: 403/,
  );
});
