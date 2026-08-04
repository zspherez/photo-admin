import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { NextRequest } from "next/server";
import { POST as claim } from "./claim/route";

for (const relative of [
  "./prepare/route.ts",
  "./claim/route.ts",
  "./[jobId]/result/route.ts",
]) {
  test(`${relative} authenticates before mutation`, () => {
    const source = readFileSync(new URL(relative, import.meta.url), "utf8");
    const auth = source.indexOf("isValidProfessionalContactAuthorization");
    const mutation = Math.min(
      ...[
        source.indexOf("countClaimableProfessionalContactJobs("),
        source.indexOf("claimProfessionalContactJobs("),
        source.indexOf("submitProfessionalContactResult("),
      ].filter((index) => index >= 0),
    );
    assert.ok(auth >= 0);
    assert.ok(mutation > auth);
    assert.match(source, /status: 401/);
  });
}

test("claim handler fails closed without or with an invalid bearer token", async () => {
  for (const authorization of [undefined, "Bearer not-a-jwt"]) {
    const response = await claim(
      new NextRequest(
        "https://admin.example/api/professional-contact-research/claim",
        {
          method: "POST",
          headers: authorization ? { authorization } : undefined,
          body: JSON.stringify({ limit: 1 }),
        },
      ),
    );
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
  }
});
