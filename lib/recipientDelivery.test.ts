import assert from "node:assert/strict";
import test from "node:test";
import {
  isRecipientDeliveryMode,
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
  assert.equal(isRecipientDeliveryMode("unknown"), false);
});
