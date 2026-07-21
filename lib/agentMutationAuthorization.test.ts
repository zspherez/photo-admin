import assert from "node:assert/strict";
import test from "node:test";
import {
  isProductionAgentEnvironment,
  isValidAgentMutationAuthorization,
} from "./agentMutationAuthorization";

test("production detection covers Vercel and non-Vercel production runtimes", () => {
  assert.equal(
    isProductionAgentEnvironment({ VERCEL_ENV: "production" }),
    true
  );
  assert.equal(
    isProductionAgentEnvironment({ VERCEL_TARGET_ENV: "production" }),
    true
  );
  assert.equal(
    isProductionAgentEnvironment({ NODE_ENV: "production" }),
    true
  );
  assert.equal(
    isProductionAgentEnvironment({
      NODE_ENV: "development",
      VERCEL_ENV: "preview",
    }),
    false
  );
});

test("production mutation auth never falls back to configured static secrets", async () => {
  assert.equal(
    await isValidAgentMutationAuthorization("Bearer static-secret", {
      environment: { NODE_ENV: "production" },
      staticSecrets: ["static-secret", "cron-secret"],
      verifyOidcToken: async () => false,
    }),
    false
  );
  assert.equal(
    await isValidAgentMutationAuthorization("Bearer oidc-token", {
      environment: { VERCEL_ENV: "production" },
      staticSecrets: "static-secret",
      verifyOidcToken: async (token) => token === "oidc-token",
    }),
    true
  );
});
