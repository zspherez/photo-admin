import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
