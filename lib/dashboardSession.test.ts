import assert from "node:assert/strict";
import test from "node:test";
import { dashboardOwnerKey } from "./dashboardSession";

test("dashboard persistence is scoped to the authenticated session", () => {
  const first = dashboardOwnerKey("session-a", { mode: "protected" });
  const second = dashboardOwnerKey("session-b", { mode: "protected" });
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, second);
  assert.equal(
    dashboardOwnerKey(undefined, { mode: "open" }),
    dashboardOwnerKey("ignored", { mode: "open" })
  );
});
