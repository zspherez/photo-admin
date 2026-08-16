import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("Artists automatically flags case-insensitive normalized duplicates", () => {
  const list = source("app/artists/page.tsx");
  assert.match(list, /"all", "with", "without", "duplicates"/);
  assert.match(list, /label: "Possible duplicates"/);
  assert.match(
    list,
    /duplicate_artist\."normalizedName" = artist\."normalizedName"/,
  );
  assert.match(list, /artist\."normalizedName" <> ''/);
  assert.match(list, /Possible duplicate ·/);
});

test("artist detail links every normalized-name duplicate candidate", () => {
  const detail = source("app/artists/[id]/page.tsx");
  assert.match(
    detail,
    /normalizedName: artist\.normalizedName,[\s\S]*id: \{ not: artist\.id \}/,
  );
  assert.match(detail, /artist\?\.normalizedName/);
  assert.match(detail, /Possible duplicate artist records/);
  assert.match(detail, /Matching is case-insensitive/);
  assert.match(detail, /\/artists\/\$\{duplicate\.id\}/);
  assert.match(detail, /Duplicate candidate/);
  assert.match(detail, /Spotify \$\{duplicate\.spotifyId\}/);
  assert.match(detail, /Stats\.fm \$\{duplicate\.statsfmId\}/);
});

test("festival ambiguity explains case-insensitive duplicate records", () => {
  const action = source(
    "app/festivals/[showId]/manual-lineup-actions.ts",
  );
  const form = source("app/festivals/[showId]/manual-lineup-form.tsx");
  assert.match(action, /Multiple case-insensitive artist records/);
  assert.match(form, /possible duplicate/);
});
