import assert from "node:assert/strict";
import test from "node:test";
import { outreachDeliveryBadges } from "./outreach-delivery-badges";

test("delivery badges show tracked progression with clicked in purple", () => {
  assert.deepEqual(
    outreachDeliveryBadges({
      status: "sent",
      sentAt: new Date("2026-07-29T18:14:00.000Z"),
      deliveredAt: new Date("2026-07-29T18:14:01.000Z"),
      bouncedAt: null,
      complainedAt: null,
      openCount: 2,
      clickCount: 3,
    }),
    [
      { key: "sent", label: "Sent", tone: "default" },
      { key: "delivered", label: "Delivered", tone: "success" },
      { key: "opened", label: "Opened (2)", tone: "info" },
      { key: "clicked", label: "Clicked (3)", tone: "accent" },
    ],
  );
});

test("delivery badges omit untracked and unavailable states", () => {
  assert.deepEqual(
    outreachDeliveryBadges({
      status: "scheduled",
      sentAt: null,
      deliveredAt: null,
      bouncedAt: null,
      complainedAt: null,
      openCount: 0,
      clickCount: 0,
    }),
    [],
  );
  assert.deepEqual(
    outreachDeliveryBadges({
      status: "test",
      sentAt: new Date("2026-07-29T18:14:00.000Z"),
      deliveredAt: new Date("2026-07-29T18:14:01.000Z"),
      bouncedAt: null,
      complainedAt: null,
      openCount: 1,
      clickCount: 1,
    }),
    [],
  );
});

test("delivery badges propagate bounce failures", () => {
  assert.deepEqual(
    outreachDeliveryBadges({
      status: "failed",
      sentAt: new Date("2026-08-17T13:00:00.000Z"),
      deliveredAt: null,
      bouncedAt: new Date("2026-08-17T13:01:00.000Z"),
      complainedAt: null,
      openCount: 0,
      clickCount: 0,
    }),
    [
      { key: "sent", label: "Sent", tone: "default" },
      { key: "bounced", label: "Bounced", tone: "danger" },
    ],
  );
});
