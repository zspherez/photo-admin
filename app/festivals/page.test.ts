import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

test("festivals page exposes an authenticated EDMTrain refresh action", () => {
  assert.match(source, /async function refreshFestivals\(formData: FormData\)/);
  assert.match(source, /"use server"/);
  assert.match(
    source,
    /requireServerActionAuth\(formData\.get\("returnTo"\) \?\? "\/festivals"\)/
  );
  assert.match(source, /syncEdmtrainFestivals\(365, deadline\)/);
  assert.match(source, /label="Refresh festivals"/);
  assert.match(source, /pendingLabel="Refreshing…"/);
  assert.match(source, /Festivals refreshed\./);
  assert.match(source, /Festival refresh failed\./);
  assert.match(source, /Festival refresh already running\./);
  assert.match(source, /revalidatePath\("\/festivals"\)/);
});

test("festival refresh preserves the selected list view", () => {
  assert.match(source, /parseFestivalListView\(\{/);
  assert.match(source, /includeInternational: formData\.get/);
  assert.match(source, /dismissed: formData\.get/);
  assert.match(source, /const returnTo = festivalListPath\(view\)/);
  assert.match(source, /hiddenFields=\{\{/);
});
