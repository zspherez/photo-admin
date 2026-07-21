import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeUniqueById,
  shouldAutomaticallyLoadMore,
} from "./dashboardInfinite";

test("appended dashboard batches cannot duplicate stable show keys", () => {
  const merged = mergeUniqueById(
    [{ id: "a" }, { id: "b" }],
    [{ id: "b" }, { id: "c" }, { id: "c" }]
  );
  assert.deepEqual(merged.items, [{ id: "a" }, { id: "b" }, { id: "c" }]);
  assert.equal(merged.added, 1);
});

test("automatic loading respects observer, motion, and data preferences", () => {
  assert.equal(
    shouldAutomaticallyLoadMore({
      intersectionObserver: true,
      reducedMotion: false,
      saveData: false,
    }),
    true
  );
  for (const options of [
    { intersectionObserver: false, reducedMotion: false, saveData: false },
    { intersectionObserver: true, reducedMotion: true, saveData: false },
    { intersectionObserver: true, reducedMotion: false, saveData: true },
  ]) {
    assert.equal(shouldAutomaticallyLoadMore(options), false);
  }
});
