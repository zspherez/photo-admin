import assert from "node:assert/strict";
import test from "node:test";
import {
  isRecipientDeliveryMode,
  isSelectableRecipientDeliveryMode,
  recipientDeliveryLayout,
} from "./recipientDelivery";

test("recipient delivery mode keeps the existing separate-thread layout by default", () => {
  assert.deepEqual(
    recipientDeliveryLayout(
      ["primary@example.com", "other@example.com"],
      "primary@example.com",
      "individual_threads",
    ),
    {
      to: ["primary@example.com", "other@example.com"],
      cc: [],
    },
  );
});

test("CC delivery keeps the primary recipient on To", () => {
  assert.deepEqual(
    recipientDeliveryLayout(
      ["other@example.com", "primary@example.com"],
      "primary@example.com",
      "cc_thread",
    ),
    {
      to: ["primary@example.com"],
      cc: ["other@example.com"],
    },
  );
  assert.equal(isRecipientDeliveryMode("cc_thread"), true);
  assert.equal(isSelectableRecipientDeliveryMode("cc_thread"), false);
  assert.equal(isRecipientDeliveryMode("unknown"), false);
  assert.equal(isRecipientDeliveryMode("legacy_multi_to"), true);
  assert.equal(isSelectableRecipientDeliveryMode("legacy_multi_to"), false);
});

test("new one-thread delivery places every recipient on To", () => {
  assert.deepEqual(
    recipientDeliveryLayout(
      ["other@example.com", "primary@example.com"],
      "primary@example.com",
      "to_thread",
    ),
    {
      to: ["other@example.com", "primary@example.com"],
      cc: [],
    },
  );
  assert.equal(isRecipientDeliveryMode("to_thread"), true);
  assert.equal(isSelectableRecipientDeliveryMode("to_thread"), true);
});
