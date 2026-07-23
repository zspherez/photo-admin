import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_COOKIE_MAX_AGE_SECONDS,
  createSessionToken,
  getSessionAccess,
  getAuthConfiguration,
  isAuthenticated,
  requireServerActionAuth,
  sanitizeNextPath,
  serverActionLoginPath,
  serverActionReadOnlyPath,
  verifySessionToken,
} from "./auth";
import { isValidCronAuthorization } from "./cron-auth";

const SESSION_SECRET = "test-session-secret-that-is-independent-from-the-password";
const ADMIN_PASSWORD = "test-admin-password";
const READ_ONLY_PASSWORD = "test-read-only-password";
const NOW = 1_700_000_000_000;

test("sanitizeNextPath allows only local paths with a single leading slash", () => {
  assert.equal(sanitizeNextPath("/dashboard?tab=shows#today"), "/dashboard?tab=shows#today");
  assert.equal(sanitizeNextPath(" /shows "), "/shows");

  for (const value of [
    undefined,
    "",
    "https://example.com",
    "javascript:alert(1)",
    "//example.com",
    "///example.com",
    "\\\\example.com",
    "/\\example.com",
    "/%5cexample.com",
    "/%2f%2fexample.com",
    "/%252f%252fexample.com",
    "/%25252f%25252fexample.com",
    "/dashboard\u0000",
    "/dashboard%0aLocation:%20https://example.com",
    "/bad%",
  ]) {
    assert.equal(sanitizeNextPath(value), "/");
  }
});

test("server action login paths always contain a sanitized local return path", () => {
  assert.equal(
    serverActionLoginPath("/dashboard?view=upcoming"),
    "/login?next=%2Fdashboard%3Fview%3Dupcoming",
  );
  assert.equal(
    serverActionLoginPath("https://example.com/steal"),
    "/login?next=%2F",
  );
  assert.equal(
    serverActionReadOnlyPath("/settings?tab=general"),
    "/read-only?next=%2Fsettings%3Ftab%3Dgeneral",
  );
});

test("server action auth guard redirects invalid sessions and allows valid ones", async () => {
  let redirectLocation: string | null = null;
  const redirect = (location: string): never => {
    redirectLocation = location;
    throw new Error("redirected");
  };

  await assert.rejects(
    requireServerActionAuth("//example.com", {
      readSessionCookie: async () => "expired",
      authenticate: async () => false,
      redirect,
    }),
    /redirected/,
  );
  assert.equal(redirectLocation, "/login?next=%2F");

  redirectLocation = null;
  await requireServerActionAuth("/dashboard", {
    readSessionCookie: async () => "valid",
    authenticate: async () => true,
    redirect,
  });
  assert.equal(redirectLocation, null);

  await assert.rejects(
    requireServerActionAuth("/settings", {
      readSessionCookie: async () => "read-only",
      authenticate: async () => false,
      readAccess: async () => "read_only",
      redirect,
    }),
    /redirected/,
  );
  assert.equal(redirectLocation, "/read-only?next=%2Fsettings");
});

test("session tokens are random, signed, and carry issued and expiry times", async () => {
  const first = await createSessionToken(SESSION_SECRET, ADMIN_PASSWORD, NOW);
  const second = await createSessionToken(SESSION_SECRET, ADMIN_PASSWORD, NOW);

  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first, second);
  assert.equal(await verifySessionToken(first, SESSION_SECRET, ADMIN_PASSWORD, NOW), true);

  const payload = JSON.parse(Buffer.from(first.split(".")[1], "base64url").toString("utf8")) as {
    iat: number;
    exp: number;
    access: string;
  };
  assert.equal(payload.iat, Math.floor(NOW / 1000));
  assert.equal(payload.exp, payload.iat + SESSION_COOKIE_MAX_AGE_SECONDS);
  assert.equal(payload.access, "admin");
});

test("session verification rejects tampering, wrong secrets, expiry, and malformed tokens", async () => {
  const token = await createSessionToken(SESSION_SECRET, ADMIN_PASSWORD, NOW);
  assert.ok(token);

  const replacement = token.endsWith("A") ? "B" : "A";
  const tampered = token.slice(0, -1) + replacement;
  assert.equal(await verifySessionToken(tampered, SESSION_SECRET, ADMIN_PASSWORD, NOW), false);
  assert.equal(
    await verifySessionToken(token, "wrong-secret", ADMIN_PASSWORD, NOW),
    false,
  );
  assert.equal(
    await verifySessionToken(token, SESSION_SECRET, "rotated-password", NOW),
    false,
  );
  assert.equal(
    await verifySessionToken(
      token,
      SESSION_SECRET,
      ADMIN_PASSWORD,
      NOW + SESSION_COOKIE_MAX_AGE_SECONDS * 1000,
    ),
    false,
  );
  const futureToken = await createSessionToken(
    SESSION_SECRET,
    ADMIN_PASSWORD,
    NOW + 61_000,
  );
  assert.ok(futureToken);
  assert.equal(
    await verifySessionToken(futureToken, SESSION_SECRET, ADMIN_PASSWORD, NOW),
    false,
  );
  assert.equal(
    await verifySessionToken(
      "v3.not-base64.not-base64",
      SESSION_SECRET,
      ADMIN_PASSWORD,
      NOW,
    ),
    false,
  );
  assert.equal(
    await verifySessionToken(undefined, SESSION_SECRET, ADMIN_PASSWORD, NOW),
    false,
  );
});

test("read-only sessions authenticate for views but not as admin sessions", async () => {
  const adminToken = await createSessionToken(
    SESSION_SECRET,
    ADMIN_PASSWORD,
    NOW,
    "admin",
  );
  const readOnlyToken = await createSessionToken(
    SESSION_SECRET,
    READ_ONLY_PASSWORD,
    NOW,
    "read_only",
  );
  assert.ok(adminToken);
  assert.ok(readOnlyToken);
  assert.equal(
    await getSessionAccess(
      adminToken,
      ADMIN_PASSWORD,
      SESSION_SECRET,
      NOW,
      { nodeEnv: "production" },
      READ_ONLY_PASSWORD,
    ),
    "admin",
  );
  assert.equal(
    await getSessionAccess(
      readOnlyToken,
      ADMIN_PASSWORD,
      SESSION_SECRET,
      NOW,
      { nodeEnv: "production" },
      READ_ONLY_PASSWORD,
    ),
    "read_only",
  );
  assert.equal(
    await isAuthenticated(
      readOnlyToken,
      ADMIN_PASSWORD,
      SESSION_SECRET,
      NOW,
      { nodeEnv: "production" },
      READ_ONLY_PASSWORD,
    ),
    true,
  );
  assert.equal(
    await verifySessionToken(
      readOnlyToken,
      SESSION_SECRET,
      ADMIN_PASSWORD,
      NOW,
      "admin",
    ),
    false,
  );
});

test("password and session-secret rotation both revoke sessions", async () => {
  const token = await createSessionToken(SESSION_SECRET, ADMIN_PASSWORD, NOW);
  assert.ok(token);

  assert.equal(
    await isAuthenticated(token, ADMIN_PASSWORD, SESSION_SECRET, NOW),
    true,
  );
  assert.equal(
    await isAuthenticated(token, "rotated-password", SESSION_SECRET, NOW),
    false,
  );
  assert.equal(
    await isAuthenticated(token, ADMIN_PASSWORD, "rotated-session-secret", NOW),
    false,
  );
});

test("authentication fails closed unless explicit open mode is enabled outside production", async () => {
  assert.deepEqual(
    getAuthConfiguration(undefined, undefined, {
      nodeEnv: "production",
      allowInsecureOpenMode: "true",
    }),
    {
      mode: "misconfigured",
      error:
        "Authentication configuration error: missing ADMIN_PASSWORD and ADMIN_SESSION_SECRET; ALLOW_INSECURE_OPEN_MODE is ignored in production",
    },
  );
  assert.equal(
    await isAuthenticated(undefined, undefined, undefined, NOW, {
      nodeEnv: "production",
      allowInsecureOpenMode: "true",
    }),
    false,
  );

  assert.deepEqual(
    getAuthConfiguration(undefined, undefined, {
      nodeEnv: "development",
      allowInsecureOpenMode: "true",
    }),
    { mode: "open" },
  );
  assert.equal(
    await isAuthenticated(undefined, undefined, undefined, NOW, {
      nodeEnv: "development",
      allowInsecureOpenMode: "true",
    }),
    true,
  );
  assert.equal(
    await isAuthenticated(undefined, undefined, undefined, NOW, {
      nodeEnv: "development",
      allowInsecureOpenMode: "false",
    }),
    false,
  );
});

test("a configured password without a session secret is a clear configuration error", async () => {
  const configuration = getAuthConfiguration(ADMIN_PASSWORD, undefined, {
    nodeEnv: "development",
    allowInsecureOpenMode: "true",
  });

  test("read-only password is optional but must differ from the admin password", () => {
    assert.deepEqual(
      getAuthConfiguration(
        ADMIN_PASSWORD,
        SESSION_SECRET,
        { nodeEnv: "production" },
        READ_ONLY_PASSWORD,
      ),
      { mode: "protected", readOnlyEnabled: true },
    );
    assert.deepEqual(
      getAuthConfiguration(
        ADMIN_PASSWORD,
        SESSION_SECRET,
        { nodeEnv: "production" },
        undefined,
      ),
      { mode: "protected", readOnlyEnabled: false },
    );
    const duplicate = getAuthConfiguration(
      ADMIN_PASSWORD,
      SESSION_SECRET,
      { nodeEnv: "production" },
      ADMIN_PASSWORD,
    );
    assert.equal(duplicate.mode, "misconfigured");
    assert.match(
      duplicate.mode === "misconfigured" ? duplicate.error : "",
      /READ_ONLY_PASSWORD must differ/,
    );
  });
  assert.equal(configuration.mode, "misconfigured");
  assert.match(
    configuration.mode === "misconfigured" ? configuration.error : "",
    /missing ADMIN_SESSION_SECRET/,
  );
  assert.equal(
    await isAuthenticated(undefined, ADMIN_PASSWORD, undefined, NOW, {
      nodeEnv: "development",
      allowInsecureOpenMode: "true",
    }),
    false,
  );
});

test("cron authorization requires a configured secret and an exact bearer token", async () => {
  assert.equal(await isValidCronAuthorization("Bearer cron-secret", ""), false);
  assert.equal(await isValidCronAuthorization(null, "cron-secret"), false);
  assert.equal(await isValidCronAuthorization("cron-secret", "cron-secret"), false);
  assert.equal(await isValidCronAuthorization("Bearer wrong", "cron-secret"), false);
  assert.equal(await isValidCronAuthorization("Bearer cron-secret extra", "cron-secret"), false);
  assert.equal(await isValidCronAuthorization("Bearer cron-secret", "cron-secret"), true);
});
