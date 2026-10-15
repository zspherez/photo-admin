import assert from "node:assert/strict";
import test from "node:test";
import { triggerScheduledOutreachWorkflow } from "./scheduledOutreachWorkflow";

test("manual dispatch requests the scheduled outreach workflow on main", async () => {
  let calls = 0;
  const result = await triggerScheduledOutreachWorkflow(
    "dispatch-token",
    async (url, init) => {
      calls += 1;
      assert.equal(
        url,
        "https://api.github.com/repos/zspherez/photo-admin/actions/workflows/send-scheduled.yml/dispatches",
      );
      assert.equal(init?.method, "POST");
      assert.equal(init?.headers && new Headers(init.headers).get("authorization"), "Bearer dispatch-token");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        ref: "main",
        inputs: { mode: "manual" },
      });
      return new Response(null, { status: 204 });
    },
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 1);
});

test("manual dispatch fails visibly without credentials or on GitHub rejection", async () => {
  assert.deepEqual(
    await triggerScheduledOutreachWorkflow("", async () => {
      throw new Error("Should not call GitHub without a token");
    }),
    { ok: false, error: "GitHub workflow dispatch is not configured" },
  );
  assert.deepEqual(
    await triggerScheduledOutreachWorkflow(
      "dispatch-token",
      async () => new Response(null, { status: 403 }),
    ),
    { ok: false, error: "GitHub rejected the workflow dispatch (403)" },
  );
});
