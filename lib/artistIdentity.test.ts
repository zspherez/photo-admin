import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ARTIST_IDENTITY_LOCK_CLASS,
  ARTIST_IDENTITY_LOCK_KEY,
  ArtistIdentityResolutionError,
  acquireArtistIdentityLock,
  chooseArtistIdentityCandidate,
  resolveArtists,
} from "./artistIdentity";
import { normalizeArtistName } from "./normalize";

const candidate = (
  id: string,
  overrides: Partial<{
    name: string;
    normalizedName: string;
    spotifyId: string | null;
    statsfmId: string | null;
    edmtrainId: number | null;
  }> = {}
) => ({
  id,
  name: "Same Name",
  normalizedName: "same name",
  spotifyId: null,
  statsfmId: null,
  edmtrainId: null,
  ...overrides,
});

const persistedArtist = (
  id: string,
  overrides: Partial<ReturnType<typeof candidate>> &
    Partial<{
      genres: string | null;
      popularity: number | null;
      imageUrl: string | null;
    }> = {}
) => ({
  ...candidate(id, overrides),
  genres: null,
  popularity: null,
  imageUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...overrides,
});

test("external ids select authoritatively despite a name collision", () => {
  const selected = candidate("spotify", { spotifyId: "sp-1" });
  const other = candidate("other", { spotifyId: "sp-2" });
  const decision = chooseArtistIdentityCandidate(
    { key: "sp-1", name: "Same Name", spotifyId: "sp-1" },
    [other, selected]
  );
  assert.equal(decision.action, "use");
  if (decision.action === "use") assert.equal(decision.candidate.id, "spotify");
  assert.equal(decision.conflicts[0]?.kind, "normalized-name-conflict");
});

test("same-provider id disagreement creates a distinct external artist", () => {
  const decision = chooseArtistIdentityCandidate(
    { key: "sp-2", name: "Same Name", spotifyId: "sp-2" },
    [candidate("existing", { spotifyId: "sp-1" })]
  );
  assert.equal(decision.action, "create");
  assert.equal(decision.conflicts[0]?.kind, "normalized-name-conflict");
});

test("ambiguous name-only identities remain unmatched", () => {
  const decision = chooseArtistIdentityCandidate(
    { key: "same name", name: "Same Name" },
    [candidate("a"), candidate("b")]
  );
  assert.equal(decision.action, "unmatched");
  assert.equal(decision.conflicts[0]?.kind, "ambiguous-name");
});

test("providers can explicitly disable normalized-name bridging", () => {
  const decision = chooseArtistIdentityCandidate(
    {
      key: "statsfm-ambiguous",
      name: "Same Name",
      statsfmId: "sf-1",
      allowNameMatch: false,
    },
    [candidate("spotify", { spotifyId: "sp-1" })]
  );

  assert.equal(decision.action, "create");
  assert.equal(decision.conflicts[0]?.kind, "normalized-name-conflict");
});

test("conflicting supplied external ids never merge two records", () => {
  const decision = chooseArtistIdentityCandidate(
    {
      key: "mixed",
      name: "Same Name",
      spotifyId: "sp-1",
      statsfmId: "sf-2",
    },
    [
      candidate("a", { spotifyId: "sp-1" }),
      candidate("b", { statsfmId: "sf-2" }),
    ]
  );
  assert.equal(decision.action, "unmatched");
  assert.equal(decision.conflicts[0]?.kind, "external-id-disagreement");
});

test("normalization preserves letters and numbers across scripts", () => {
  const normalized = [
    normalizeArtistName("宇多田ヒカル"),
    normalizeArtistName("Молчат Дома"),
    normalizeArtistName("أم كلثوم"),
    normalizeArtistName("Beyoncé"),
  ];

  assert.deepEqual(normalized.slice(0, 2), ["宇多田ヒカル", "молчат дома"]);
  assert.equal(normalized[2].length > 0, true);
  assert.equal(normalized[3], "beyonce");
  assert.equal(new Set(normalized).size, normalized.length);
});

test("normalization preserves meaningful non-Latin combining marks", () => {
  assert.notEqual(normalizeArtistName("किरण"), normalizeArtistName("करण"));
  assert.equal(normalizeArtistName("AC/DC & Friends"), "ac dc and friends");
  assert.equal(
    normalizeArtistName("Ｂｅｙｏｎｃé ＆ 東京"),
    "beyonce and 東京"
  );
  assert.equal(normalizeArtistName("✨ !!!"), "");
});

test("different scripts do not collide during name matching", () => {
  const decision = chooseArtistIdentityCandidate(
    { key: "cjk", name: "東京" },
    [
      candidate("cjk", { name: "東京", normalizedName: "東京" }),
      candidate("cyrillic", { name: "Токио", normalizedName: "токио" }),
    ]
  );

  assert.equal(decision.action, "use");
  if (decision.action === "use") assert.equal(decision.candidate.id, "cjk");
});

test("empty name-only identities remain unmatched", () => {
  const decision = chooseArtistIdentityCandidate(
    { key: "symbols", name: "✨ !!!" },
    []
  );

  assert.equal(decision.action, "unmatched");
  assert.equal(decision.conflicts[0]?.kind, "empty-normalized-name");
});

test("external ids can create and resolve identities with empty normalized names", () => {
  const created = chooseArtistIdentityCandidate(
    { key: "new", name: "✨", edmtrainId: 100 },
    [candidate("other-empty", { normalizedName: "", edmtrainId: 99 })]
  );
  assert.equal(created.action, "create");
  assert.deepEqual(created.conflicts, []);

  const existing = candidate("external", {
    name: "✨",
    normalizedName: "",
    edmtrainId: 100,
  });
  const resolved = chooseArtistIdentityCandidate(
    { key: "existing", name: "✨", edmtrainId: 100 },
    [existing, candidate("other-empty", { normalizedName: "", edmtrainId: 99 })]
  );
  assert.equal(resolved.action, "use");
  if (resolved.action === "use") {
    assert.equal(resolved.candidate.id, "external");
  }
  assert.deepEqual(resolved.conflicts, []);
});

test("resolver persists symbol-only artists when a provider id is authoritative", async () => {
  const created: Array<{ normalizedName: string; edmtrainId: number | null }> = [];
  let queryCount = 0;
  const tx = {
    $queryRaw: async () => {
      queryCount++;
      return [];
    },
    artist: {
      createMany: async ({
        data,
      }: {
        data: Array<{ normalizedName: string; edmtrainId: number | null }>;
      }) => {
        created.push(...data);
        return { count: data.length };
      },
      update: async () => {
        throw new Error("unexpected update");
      },
    },
  } as unknown as Parameters<typeof resolveArtists>[0];

  const resolved = await resolveArtists(tx, [
    { key: "edmtrain:100", name: "✨", edmtrainId: 100 },
  ]);

  assert.equal(resolved.created, 1);
  assert.equal(created[0]?.normalizedName, "");
  assert.equal(created[0]?.edmtrainId, 100);
  assert.equal(resolved.artistsByKey.get("edmtrain:100")?.edmtrainId, 100);
  assert.equal(queryCount, 2);
});

test("resolver rejects symbol-only name identities without querying all empty names", async () => {
  let queried = false;
  const tx = {
    artist: {
      findMany: async () => {
        queried = true;
        return [];
      },
    },
  } as unknown as Parameters<typeof resolveArtists>[0];

  await assert.rejects(
    resolveArtists(tx, [{ key: "symbols", name: "✨" }]),
    ArtistIdentityResolutionError
  );
  assert.equal(queried, false);
});

test("resolver locks before re-reading candidates", async () => {
  const order: string[] = [];
  let queryCount = 0;
  const existing = persistedArtist("artist-1", {
    spotifyId: "sp-1",
  });
  const tx = {
    $queryRaw: async () => {
      queryCount++;
      if (queryCount === 1) {
        order.push("lock");
        return [];
      }
      order.push("locked-read");
      return [existing];
    },
    artist: {
      createMany: async () => {
        throw new Error("unexpected create");
      },
      update: async () => {
        throw new Error("unexpected update");
      },
    },
  } as unknown as Parameters<typeof resolveArtists>[0];

  await resolveArtists(tx, [
    {
      key: "sp-1",
      name: existing.name,
      spotifyId: "sp-1",
      updateName: false,
    },
  ]);

  assert.deepEqual(order, ["lock", "locked-read"]);
});

test("runtime advisory lock parameters are explicitly cast to PostgreSQL integers", async () => {
  let query:
    | {
        text: string;
        values: unknown[];
      }
    | undefined;
  const tx = {
    $queryRaw: async (captured: { text: string; values: unknown[] }) => {
      query = captured;
      return [];
    },
  } as unknown as Parameters<typeof acquireArtistIdentityLock>[0];

  await acquireArtistIdentityLock(tx);

  assert.ok(query);
  assert.match(
    query.text,
    /pg_advisory_xact_lock\(\s*CAST\(\$1 AS INTEGER\),\s*CAST\(\$2 AS INTEGER\)\s*\)/
  );
  assert.deepEqual(query.values, [
    ARTIST_IDENTITY_LOCK_CLASS,
    ARTIST_IDENTITY_LOCK_KEY,
  ]);
});

test("resolver updates only explicitly supplied fields", async () => {
  const existing = persistedArtist("artist-1", {
    spotifyId: "sp-1",
    statsfmId: "sf-existing",
    edmtrainId: 10,
    genres: "[\"old\"]",
  });
  let queryCount = 0;
  let updateData: unknown;
  const tx = {
    $queryRaw: async () => {
      queryCount++;
      return queryCount === 1 ? [] : [existing];
    },
    artist: {
      createMany: async () => {
        throw new Error("unexpected create");
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updateData = data;
        return { ...existing, ...data, updatedAt: new Date() };
      },
    },
  } as unknown as Parameters<typeof resolveArtists>[0];

  const resolved = await resolveArtists(tx, [
    {
      key: "sp-1",
      name: "Ignored stale display name",
      spotifyId: "sp-1",
      updateName: false,
      genres: "[\"new\"]",
    },
  ]);

  assert.deepEqual(updateData, {
    spotifyId: "sp-1",
    genres: "[\"new\"]",
  });
  const artist = resolved.artistsByKey.get("sp-1");
  assert.equal(artist?.statsfmId, "sf-existing");
  assert.equal(artist?.edmtrainId, 10);
});

test("name-only database inserts share the resolver advisory lock", () => {
  const migration = readFileSync(
    new URL(
      "../prisma/migrations/20260716070000_data_sync_leases/migration.sql",
      import.meta.url
    ),
    "utf8"
  );

  assert.match(
    migration,
    new RegExp(
      `pg_advisory_xact_lock\\(${ARTIST_IDENTITY_LOCK_CLASS}, ${ARTIST_IDENTITY_LOCK_KEY}\\)`
    )
  );
  assert.match(migration, /NEW\."spotifyId" IS NULL/);
  assert.match(migration, /"ArtistIdentityNameClaim"/);
  assert.match(migration, /COALESCE\(claim_created, FALSE\) = FALSE/);
  assert.match(migration, /ERRCODE = '40001'/);
});

test("manual and Sheet identity adoption lock before reading candidates", () => {
  const festivalSource = readFileSync(
    new URL("../app/festivals/new/actions.ts", import.meta.url),
    "utf8"
  );
  const festivalStart = festivalSource.indexOf("async function persistFestival");
  const festivalLock = festivalSource.indexOf(
    "await acquireArtistIdentityLock(tx)",
    festivalStart
  );
  const festivalCandidates = festivalSource.indexOf(
    "await tx.artist.findMany",
    festivalStart
  );
  assert.ok(festivalLock > festivalStart);
  assert.ok(festivalLock < festivalCandidates);

  const sheetsSource = readFileSync(
    new URL("./sheets.ts", import.meta.url),
    "utf8"
  );
  const sheetsStart = sheetsSource.indexOf(
    "export async function syncContactsFromSheet"
  );
  const sheetsLock = sheetsSource.indexOf(
    "await acquireArtistIdentityLock(tx)",
    sheetsStart
  );
  const ownershipRead = sheetsSource.indexOf(
    "const ownershipContacts = await tx.contact.findMany",
    sheetsStart
  );
  assert.ok(sheetsLock > sheetsStart);
  assert.ok(sheetsLock < ownershipRead);

  const backfillSource = readFileSync(
    new URL("../scripts/backfill-normalized-artists.ts", import.meta.url),
    "utf8"
  );
  assert.match(backfillSource, /await acquireArtistIdentityLock\(tx\)/);
});
