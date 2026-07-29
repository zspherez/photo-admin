import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  artistDisplayName,
  normalizeArtistCustomName,
} from "./artistDisplayName";

test("artist display names prefer a trimmed custom override", () => {
  assert.equal(
    artistDisplayName({ name: "No Static (NC)", customName: "No Static" }),
    "No Static",
  );
  assert.equal(
    artistDisplayName({ name: "No Static (NC)", customName: null }),
    "No Static (NC)",
  );
});

test("custom artist names normalize safely and clear when blank", () => {
  assert.equal(normalizeArtistCustomName("  No Static  "), "No Static");
  assert.equal(normalizeArtistCustomName("   "), null);
  assert.throws(
    () => normalizeArtistCustomName("bad\nname"),
    /unsupported characters/,
  );
});

test("custom artist name migration is transactional and constrained", () => {
  const migration = readFileSync(
    new URL(
      "../prisma/migrations/20260729023000_artist_custom_display_name/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(migration, /^BEGIN;\n/);
  assert.match(migration, /ADD COLUMN "customName" TEXT/);
  assert.match(migration, /CONSTRAINT "Artist_customName_check"/);
  assert.match(migration, /char_length\("customName"\) <= 200/);
  assert.match(migration, /\nCOMMIT;\s*$/);
});

test("provider links retain canonical names while previews use display names", () => {
  const modal = readFileSync(
    new URL("../components/artist-modal.tsx", import.meta.url),
    "utf8",
  );
  const template = readFileSync(
    new URL("../app/settings/template/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(modal, /canonicalName: string/);
  assert.match(modal, /encodeURIComponent\(d\.canonicalName\)/);
  assert.match(modal, /d\.canonicalName\.toLowerCase\(\)/);
  assert.match(
    template,
    /const sampleArtistName = artistDisplayName\(matched\.artist\)/,
  );
  assert.match(template, /artistName: sampleArtistName/);
  assert.match(template, /Preview: \$\{sampleArtistName\}/);
});
