import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Prisma Client includes Vercel ARM64 and x64 Linux engines", () => {
  const schema = readFileSync(
    new URL("../prisma/schema.prisma", import.meta.url),
    "utf8",
  );

  assert.match(schema, /"rhel-openssl-3\.0\.x"/);
  assert.match(schema, /"linux-arm64-openssl-3\.0\.x"/);
});
