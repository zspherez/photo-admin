import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const edmtrain = readFileSync(new URL("./edmtrain.ts", import.meta.url), "utf8");
const action = readFileSync(
  new URL(
    "../app/festivals/[showId]/manual-lineup-actions.ts",
    import.meta.url,
  ),
  "utf8",
);
const detailPage = readFileSync(
  new URL("../app/festivals/[showId]/page.tsx", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL(
    "../prisma/migrations/20260804170000_manual_festival_lineup_artists/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

test("manual lineup ownership migration is forward-only and behavior safe", () => {
  assert.match(migration, /^BEGIN;\n/);
  assert.match(
    migration,
    /"providerManaged" BOOLEAN NOT NULL DEFAULT TRUE/,
  );
  assert.match(
    migration,
    /"manuallyAdded" BOOLEAN NOT NULL DEFAULT FALSE/,
  );
  assert.match(
    migration,
    /show\."source" = 'manual'/,
  );
  assert.match(
    migration,
    /CHECK \("providerManaged" OR "manuallyAdded"\)/,
  );
  assert.match(migration, /\nCOMMIT;\s*$/);
});

test("EDMTrain refresh preserves manual lineup ownership", () => {
  const reconciliation = edmtrain.slice(
    edmtrain.indexOf("const persistedShows"),
    edmtrain.indexOf("const scopeFestival"),
  );
  assert.match(
    reconciliation,
    /manuallyAdded: false/,
  );
  assert.match(
    reconciliation,
    /manuallyAdded: true[\s\S]*providerManaged: false/,
  );
  assert.match(
    reconciliation,
    /ON CONFLICT \("showId", "artistId"\) DO UPDATE SET[\s\S]*"providerManaged" = TRUE/,
  );
});

test("manual lineup actions authenticate, normalize, and serialize identity changes", () => {
  const addAction = action.slice(
    action.indexOf("export async function addManualFestivalArtist"),
    action.indexOf("export async function removeManualFestivalArtist"),
  );
  assert.match(addAction, /requireServerActionAuth\(/);
  assert.match(addAction, /normalizeArtistName\(artistName\)/);
  assert.match(action, /acquireArtistIdentityLock\(tx\)/);
  assert.match(action, /acquireShowArtistMembershipLock\(tx\)/);
  assert.match(action, /providerManaged: false/);
  assert.match(action, /manuallyAdded: true/);
});

test("manual lineup removal is exposed only for manually owned rows", () => {
  assert.match(
    detailPage,
    /\{r\.association\.manuallyAdded && \(\s*<form action=\{removeManualFestivalArtist\}>/,
  );
  assert.match(action, /manualFestivalArtistRemoval\(association\)/);
  assert.match(
    action,
    /removal === "retain-provider-association"[\s\S]*manuallyAdded: false/,
  );
  assert.match(
    action,
    /removal === "provider-owned"[\s\S]*lineup_error: "provider_owned"/,
  );
});
