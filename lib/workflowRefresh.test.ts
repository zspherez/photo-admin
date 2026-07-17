import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { workflowRevalidationPaths } from "./workflowRefresh";

test("workflow mutation refreshes preserve validated dashboard and festival views", () => {
  assert.deepEqual(
    workflowRevalidationPaths(
      "/dashboard?mode=interested&status=sent&search=Four%20Tet&page=3",
      ["/outreach", "/dashboard?ignored=1"],
    ),
    ["/dashboard", "/outreach"],
  );
  assert.deepEqual(
    workflowRevalidationPaths(
      "/festivals/show_123?filter=unsent&genre=house",
      ["/outreach", "/festivals/show_123?stale=1"],
    ),
    ["/dashboard", "/festivals/show_123", "/outreach"],
  );
  assert.deepEqual(
    workflowRevalidationPaths(
      "/festivals?includeInternational=1&dismissed=1",
      ["/festivals/show_123"],
    ),
    ["/dashboard", "/festivals", "/festivals/show_123"],
  );
  assert.deepEqual(
    workflowRevalidationPaths(
      "/outreach?status=sent&search=Artist&page=2",
      ["/festivals/show_123"],
    ),
    ["/dashboard", "/outreach", "/festivals/show_123"],
  );
  assert.deepEqual(
    workflowRevalidationPaths(
      "/dashboard/contact/contact_123?historyPage=3",
      ["/outreach"],
    ),
    ["/dashboard", "/dashboard/contact/contact_123", "/outreach"],
  );
});

test("workflow mutation refreshes reject unsafe related paths", () => {
  assert.deepEqual(
    workflowRevalidationPaths("https://example.com/dashboard"),
    ["/dashboard"],
  );
  assert.throws(
    () => workflowRevalidationPaths("/dashboard", ["https://example.com"]),
    /internal path/,
  );
});

test("workflow mutations request a router refresh before path revalidation", () => {
  const source = readFileSync(
    path.join(process.cwd(), "lib/workflowRefresh.ts"),
    "utf8",
  );
  const refreshCall = source.indexOf("refresh();");
  const revalidateCall = source.indexOf("revalidatePath(path);");
  assert.notEqual(refreshCall, -1);
  assert.notEqual(revalidateCall, -1);
  assert.ok(refreshCall < revalidateCall);
});
