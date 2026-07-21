import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import {
  acquireShowArtistMembershipLock,
  SHOW_ARTIST_MEMBERSHIP_LOCK_CLASS,
  SHOW_ARTIST_MEMBERSHIP_LOCK_KEY,
  staleReadyTrajectoryRunsWithMissingMembership,
} from "./showArtistMembershipInvariant";

class LockManager {
  private locked = false;
  private readonly waiters: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return () => this.release();
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.locked = false;
  }
}

interface TestRun {
  status: "ready" | "stale";
  memberships: string[];
}

class MembershipDatabase {
  readonly lock = new LockManager();
  readonly memberships = new Set<string>();
  readonly runs = new Map<string, TestRun>();

  async transaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const releases: Array<() => void> = [];
    const tx = {
      $queryRaw: async (query: { text: string }) => {
        if (query.text.includes("pg_advisory_xact_lock")) {
          releases.push(await this.lock.acquire());
          return [{ locked: 1 }];
        }
        if (query.text.includes('UPDATE "TrajectoryModelRun"')) {
          const affected: Array<{ id: string }> = [];
          for (const [id, run] of this.runs) {
            if (
              run.status === "ready" &&
              run.memberships.some(
                (membership) => !this.memberships.has(membership),
              )
            ) {
              run.status = "stale";
              affected.push({ id });
            }
          }
          return affected;
        }
        return [];
      },
    } as unknown as Prisma.TransactionClient;
    try {
      return await work(tx);
    } finally {
      for (const release of releases.reverse()) release();
    }
  }
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("membership invariant lock uses stable PostgreSQL integer keys", async () => {
  let query:
    | {
        text: string;
        values: unknown[];
      }
    | undefined;
  const tx = {
    $queryRaw: async (captured: {
      text: string;
      values: unknown[];
    }) => {
      query = captured;
      return [];
    },
  } as unknown as Parameters<typeof acquireShowArtistMembershipLock>[0];

  await acquireShowArtistMembershipLock(tx);

  assert.ok(query);
  assert.match(
    query.text,
    /pg_advisory_xact_lock\(\s*CAST\(\$1 AS INTEGER\),\s*CAST\(\$2 AS INTEGER\)\s*\)/,
  );
  assert.deepEqual(query.values, [
    SHOW_ARTIST_MEMBERSHIP_LOCK_CLASS,
    SHOW_ARTIST_MEMBERSHIP_LOCK_KEY,
  ]);
});

test("ready-run invalidation evaluates exact final show and artist membership", async () => {
  let query: { text: string } | undefined;
  const tx = {
    $queryRaw: async (captured: { text: string }) => {
      query = captured;
      return [];
    },
  } as unknown as Parameters<
    typeof staleReadyTrajectoryRunsWithMissingMembership
  >[0];

  await staleReadyTrajectoryRunsWithMissingMembership(tx);

  assert.ok(query);
  assert.match(query.text, /SET[\s\S]*"status" = 'stale'/);
  assert.match(query.text, /model_run\."status" = 'ready'/);
  assert.match(
    query.text,
    /membership\."showId" = recommendation\."showId"[\s\S]*membership\."artistId" = run_artist\."artistId"/,
  );
  assert.match(
    query.text,
    /run_artist\."artistId" IS NULL[\s\S]*membership\."showId" IS NULL/,
  );
});

test("reconciliation-first makes importer wait, revalidate, and reject", async () => {
  const database = new MembershipDatabase();
  database.memberships.add("show-old:artist-old");
  database.memberships.add("show-new:artist-new");
  database.runs.set("old-ready", {
    status: "ready",
    memberships: ["show-old:artist-old"],
  });
  const reconciliationLocked = deferred();
  const releaseReconciliation = deferred();

  const reconciliation = database.transaction(async (tx) => {
    await acquireShowArtistMembershipLock(tx);
    reconciliationLocked.resolve();
    await releaseReconciliation.promise;
    database.memberships.delete("show-new:artist-new");
    await staleReadyTrajectoryRunsWithMissingMembership(tx);
  });
  await reconciliationLocked.promise;

  let importValidated = false;
  const importer = database.transaction(async (tx) => {
    await acquireShowArtistMembershipLock(tx);
    importValidated = true;
    if (!database.memberships.has("show-new:artist-new")) {
      throw new Error("membership changed");
    }
    database.runs.set("incoming", {
      status: "ready",
      memberships: ["show-new:artist-new"],
    });
  });
  await Promise.resolve();
  assert.equal(importValidated, false);
  releaseReconciliation.resolve();
  await reconciliation;
  await assert.rejects(importer, /membership changed/);

  assert.equal(database.runs.get("old-ready")?.status, "ready");
  assert.equal(database.runs.has("incoming"), false);
});

test("import-first makes reconciliation wait and stale actual membership loss", async () => {
  const database = new MembershipDatabase();
  database.memberships.add("show-new:artist-new");
  const importLocked = deferred();
  const releaseImport = deferred();

  const importer = database.transaction(async (tx) => {
    await acquireShowArtistMembershipLock(tx);
    assert.equal(
      database.memberships.has("show-new:artist-new"),
      true,
    );
    database.runs.set("incoming", {
      status: "ready",
      memberships: ["show-new:artist-new"],
    });
    importLocked.resolve();
    await releaseImport.promise;
  });
  await importLocked.promise;

  let reconciliationMutated = false;
  const reconciliation = database.transaction(async (tx) => {
    await acquireShowArtistMembershipLock(tx);
    reconciliationMutated = true;
    database.memberships.delete("show-new:artist-new");
    await staleReadyTrajectoryRunsWithMissingMembership(tx);
  });
  await Promise.resolve();
  assert.equal(reconciliationMutated, false);
  releaseImport.resolve();
  await importer;
  await reconciliation;

  assert.equal(reconciliationMutated, true);
  assert.equal(database.runs.get("incoming")?.status, "stale");
});

test("delete and reinsert of an unchanged lineup keeps the ready run", async () => {
  const database = new MembershipDatabase();
  database.memberships.add("show-new:artist-new");
  database.runs.set("incoming", {
    status: "ready",
    memberships: ["show-new:artist-new"],
  });

  const affected = await database.transaction(async (tx) => {
    await acquireShowArtistMembershipLock(tx);
    database.memberships.delete("show-new:artist-new");
    database.memberships.add("show-new:artist-new");
    return staleReadyTrajectoryRunsWithMissingMembership(tx);
  });

  assert.deepEqual(affected, []);
  assert.equal(database.runs.get("incoming")?.status, "ready");
});

test("EDMTrain replacement locks before deletion and checks final state", () => {
  const source = readFileSync(new URL("./edmtrain.ts", import.meta.url), "utf8");
  const lock = source.indexOf("await acquireShowArtistMembershipLock(tx)");
  const deletion = source.indexOf("await tx.showArtist.deleteMany");
  const insertion = source.indexOf("await tx.showArtist.createMany");
  const invalidation = source.indexOf(
    "await staleReadyTrajectoryRunsWithMissingMembership(tx)",
  );

  assert.ok(lock >= 0);
  assert.ok(lock < deletion);
  assert.ok(deletion < insertion);
  assert.ok(insertion < invalidation);
});
