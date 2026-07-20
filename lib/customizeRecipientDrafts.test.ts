import assert from "node:assert/strict";
import test from "node:test";
import {
  initializeCustomizeRecipientDrafts,
  updateCustomizeRecipientDraft,
} from "./customizeRecipientDrafts";

test("recipient drafts switch personalization without losing intentional edits", () => {
  const initialized = initializeCustomizeRecipientDrafts([
    {
      id: "alice",
      subject: "Hello Alice",
      html: "<p>Hello Alice</p>",
    },
    {
      id: "bob",
      subject: "Hello Bob",
      html: "<p>Hello Bob</p>",
    },
  ]);
  const edited = updateCustomizeRecipientDraft(
    initialized,
    "alice",
    initialized.alice,
    { html: "<p>Custom note for Alice</p>" },
  );

  assert.deepEqual(edited.bob, {
    subject: "Hello Bob",
    html: "<p>Hello Bob</p>",
  });
  assert.deepEqual(edited.alice, {
    subject: "Hello Alice",
    html: "<p>Custom note for Alice</p>",
  });
});
