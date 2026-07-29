import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { handleTextDraftRequest } from "./route";

function request(
  query = "showId=show-1&artistId=artist-1&phoneContactId=contact-1",
) {
  return new NextRequest(`https://admin.example/api/outreach/text-draft?${query}`);
}

test("text draft route requires admin access", async () => {
  const response = await handleTextDraftRequest(request(), {
    authenticate: async () => "read_only",
    loadDraft: async () => {
      throw new Error("must not load");
    },
  });

  assert.equal(response.status, 403);
});

test("text draft route fails closed when authentication is misconfigured", async () => {
  const response = await handleTextDraftRequest(request(), {
    authenticate: async () => "misconfigured",
    loadDraft: async () => {
      throw new Error("must not load");
    },
  });

  assert.equal(response.status, 500);
});

test("text draft route returns personalized body without caching", async () => {
  const response = await handleTextDraftRequest(request(), {
    authenticate: async () => "admin",
    loadDraft: async (input) => {
      assert.deepEqual(input, {
        showId: "show-1",
        artistId: "artist-1",
        phoneContactId: "contact-1",
      });
      return "Hi Taylor";
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.deepEqual(await response.json(), { body: "Hi Taylor" });
});
