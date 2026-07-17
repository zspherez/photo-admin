import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  isServerActionRequest,
  proxy,
  unauthenticatedResponse,
} from "./proxy";

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

test("the fixed release verification route reaches its own fail-closed bearer auth", async () => {
  const response = await proxy(
    new NextRequest(
      "https://admin.example/api/release/runtime-verification"
    )
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-middleware-next"), "1");
});
