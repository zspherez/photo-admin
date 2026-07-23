import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  SESSION_COOKIE,
  createSessionToken,
} from "./lib/auth";
import {
  isServerActionRequest,
  networkOnlyResponse,
  proxy,
  readOnlyMutationResponse,
  unauthenticatedResponse,
} from "./proxy";

test("authenticated responses are explicitly network-only", () => {
  const response = networkOnlyResponse();

  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("pragma"), "no-cache");
});

test("PWA shell assets remain public", async () => {
  for (const pathname of [
    "/manifest.webmanifest",
    "/sw.js",
    "/offline.html",
    "/icons/icon-192.png",
  ]) {
    const response = await proxy(
      new NextRequest(`https://admin.example${pathname}`),
    );
    assert.equal(response.status, 200, pathname);
    assert.equal(response.headers.get("x-middleware-next"), "1", pathname);
  }
});

test("unauthenticated Server Action POSTs continue to the guarded action", () => {
  const request = new NextRequest("https://admin.example/dashboard", {
    method: "POST",
    headers: { "Next-Action": "action-id" },
  });

  assert.equal(isServerActionRequest(request), true);
  const response = unauthenticatedResponse(request);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-middleware-next"), "1");
});

test("ordinary unauthenticated page POSTs use a 303 login redirect", () => {
  const request = new NextRequest(
    "https://admin.example/dashboard?view=upcoming",
    { method: "POST" },
  );

  const response = unauthenticatedResponse(request);
  assert.equal(response.status, 303);
  assert.equal(
    response.headers.get("location"),
    "https://admin.example/login?next=%2Fdashboard%3Fview%3Dupcoming",
  );
});

test("unauthenticated API requests return 401 even with an action-like header", () => {
  const request = new NextRequest("https://admin.example/api/artists/123", {
    method: "POST",
    headers: { "Next-Action": "spoofed-action-id" },
  });

  const response = unauthenticatedResponse(request);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("location"), null);
});

test("unauthenticated page GETs keep the standard temporary login redirect", () => {
  const request = new NextRequest("https://admin.example/festivals");
  const response = unauthenticatedResponse(request);

  assert.equal(response.status, 307);
  assert.equal(
    response.headers.get("location"),
    "https://admin.example/login?next=%2Ffestivals",
  );
});

test("read-only mutation responses fail closed while Server Actions reach their guard", () => {
  const api = readOnlyMutationResponse(
    new NextRequest("https://admin.example/api/artists/123", {
      method: "PATCH",
    }),
  );
  assert.equal(api.status, 403);
  assert.deepEqual(api.headers.get("location"), null);

  const action = readOnlyMutationResponse(
    new NextRequest("https://admin.example/settings", {
      method: "POST",
      headers: { "Next-Action": "action-id" },
    }),
  );
  assert.equal(action.status, 200);
  assert.equal(action.headers.get("x-middleware-next"), "1");

  const pagePost = readOnlyMutationResponse(
    new NextRequest("https://admin.example/settings?tab=general", {
      method: "POST",
    }),
  );
  assert.equal(pagePost.status, 303);
  assert.equal(
    pagePost.headers.get("location"),
    "https://admin.example/read-only?next=%2Fsettings%3Ftab%3Dgeneral",
  );
});

test("proxy allows read-only GETs and rejects read-only mutation requests", async () => {
  const previous = {
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    ADMIN_SESSION_SECRET: process.env.ADMIN_SESSION_SECRET,
    READ_ONLY_PASSWORD: process.env.READ_ONLY_PASSWORD,
    NODE_ENV: process.env.NODE_ENV,
  };
  process.env.ADMIN_PASSWORD = "admin-password";
  process.env.ADMIN_SESSION_SECRET = "independent-session-secret";
  process.env.READ_ONLY_PASSWORD = "read-only-password";
  Reflect.set(process.env, "NODE_ENV", "production");
  try {
    const token = await createSessionToken(
      process.env.ADMIN_SESSION_SECRET,
      process.env.READ_ONLY_PASSWORD,
      Date.now(),
      "read_only",
    );
    assert.ok(token);
    const headers = {
      cookie: `${SESSION_COOKIE}=${token}`,
    };
    const page = await proxy(
      new NextRequest("https://admin.example/settings", { headers }),
    );
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("x-middleware-next"), "1");

    const mutation = await proxy(
      new NextRequest("https://admin.example/api/artists/123", {
        method: "PATCH",
        headers,
      }),
    );
    assert.equal(mutation.status, 403);

    const spotify = await proxy(
      new NextRequest("https://admin.example/api/spotify/login", { headers }),
    );
    assert.equal(spotify.status, 403);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else Reflect.set(process.env, key, value);
    }
  }
});

test("the fixed release verification route reaches its own fail-closed bearer auth", async () => {
  const response = await proxy(
    new NextRequest(
      "https://admin.example/api/release/runtime-verification"
    )
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-middleware-next"), "1");
});

test("trajectory ingest reaches its own fail-closed request authentication", async () => {
  const response = await proxy(
    new NextRequest(
      "https://admin.example/api/integrations/trajectory-runs",
      { method: "POST" },
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-middleware-next"), "1");
});
