import assert from "node:assert/strict";
import test from "node:test";
import { dashboardSessionIdentity } from "./dashboardSession";

test("dashboard persistence is scoped to the authenticated session", () => {
  const first = dashboardSessionIdentity("session-a", { mode: "protected" });
  const second = dashboardSessionIdentity("session-b", { mode: "protected" });
  assert.match(first.ownerKey, /^[0-9a-f]{64}$/);
  assert.match(first.persistenceScope, /^[0-9a-f]{64}$/);
  assert.notEqual(first.ownerKey, first.persistenceScope);
  assert.notEqual(first.ownerKey, second.ownerKey);
  assert.notEqual(first.persistenceScope, second.persistenceScope);
  assert.deepEqual(
    dashboardSessionIdentity(undefined, { mode: "open" }),
    dashboardSessionIdentity("ignored", { mode: "open" })
  );
});
