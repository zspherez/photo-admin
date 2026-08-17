import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

function source(file: string): string {
  return readFileSync(path.join(process.cwd(), file), "utf8");
}

test("workflow rows expose the shared rejection control", () => {
  const button = source("components/reject-workflow-target-button.tsx");
  assert.match(button, /rejectWorkflowTargetAction/);
  assert.match(button, /name="targetArtistId"/);
  assert.match(button, /pendingLabel="Rejecting…"/);

  for (const file of [
    "app/dashboard/dashboard-client.tsx",
    "components/artist-modal.tsx",
    "app/recommendations/recommendations-client.tsx",
    "app/festivals/[showId]/page.tsx",
  ]) {
    assert.match(source(file), /RejectWorkflowTargetButton/, file);
  }
});

test("rejected festival artists cannot enter outreach preparation or claims", () => {
  const send = source("lib/sendOutreach.ts");
  assert.match(send, /AND "rejectedAt" IS NULL/);
  assert.ok(
    (send.match(/rejectedAt: null/g) ?? []).length >= 6,
    "all festival association checks must exclude rejected artists",
  );
  assert.match(send, /!association \|\| association\.rejectedAt/);
});
