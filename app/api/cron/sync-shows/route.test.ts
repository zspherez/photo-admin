import assert from "node:assert/strict";
import test from "node:test";
import type {
  EdmtrainScopeSyncResult,
  EdmtrainSyncResult,
  SyncResult,
} from "@/lib/edmtrain";
import { edmtrainCompletion } from "./route";

const synced: SyncResult = {
  fetched: 1,
  upserted: 1,
  skippedVenue: 0,
  artistsLinked: 0,
  missing: 0,
  cancelled: 0,
  identityConflicts: [],
};

const success: EdmtrainScopeSyncResult = { ok: true, data: synced };
const failure: EdmtrainScopeSyncResult = {
  ok: false,
  error: "provider unavailable",
};
const busy: EdmtrainScopeSyncResult = {
  ok: false,
  status: "busy",
  reason: "lease_conflict",
  leaseKey: "integration-sync:edmtrain-nyc:W10",
  expiresAt: "2026-07-16T12:00:00.000Z",
  retryAfterMs: 10_000,
};
const deferred: EdmtrainScopeSyncResult = {
  ok: false,
  status: "deferred",
  reason: "operation_deadline_exceeded",
  details: {
    phase: "festivals EDMTrain reconciliation",
    operation: "festivals EDMTrain reconciliation",
    requiredMs: 46_001,
    remainingMs: 20_000,
    destructiveWorkStarted: false,
    transactionStarted: false,
    transactionRolledBack: false,
    priorSnapshotPreserved: true,
  },
};

test("cron reports a required partial EDMTrain failure as non-2xx", () => {
  const partial: EdmtrainSyncResult = {
    nyc: success,
    festivals: failure,
  };

  assert.deepEqual(edmtrainCompletion(partial), { ok: false, status: 500 });
});

test("cron succeeds only after both independent snapshots reconcile", () => {
  const complete: EdmtrainSyncResult = {
    nyc: success,
    festivals: success,
  };

  assert.deepEqual(edmtrainCompletion(complete), { ok: true, status: 200 });
});

test("cron returns a conflict when the only failure is an active lease", () => {
  const overlap: EdmtrainSyncResult = {
    nyc: busy,
    festivals: success,
  };

  assert.deepEqual(edmtrainCompletion(overlap), { ok: false, status: 409 });
});

test("cron reports a deadline-deferred EDMTrain scope as incomplete", () => {
  const result: EdmtrainSyncResult = {
    nyc: success,
    festivals: deferred,
  };

  assert.deepEqual(edmtrainCompletion(result), { ok: false, status: 500 });
});
