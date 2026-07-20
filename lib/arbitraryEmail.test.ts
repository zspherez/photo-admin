import assert from "node:assert/strict";
import test from "node:test";
import {
  arbitraryEmailEventUpdate,
  parseArbitraryEmailInput,
} from "./arbitraryEmail";

test("arbitrary email input validates recipients and adds explicit UTM values", () => {
  const result = parseArbitraryEmailInput({
    recipients: " One@Example.com, two@example.com;one@example.com ",
    subject: " Gallery update ",
    html: '<p><a href="https://example.com/work?view=all#new">View</a></p>',
    utm_source: "newsletter",
    utm_medium: "email",
    utm_campaign: "summer",
    utm_content: "hero",
    utm_term: "portraits",
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.input.recipientEmails, [
    "one@example.com",
    "two@example.com",
  ]);
  assert.equal(result.input.subject, "Gallery update");
  assert.match(
    result.input.html,
    /view=all&amp;utm_source=newsletter&amp;utm_medium=email&amp;utm_campaign=summer&amp;utm_content=hero&amp;utm_term=portraits#new/,
  );
});

test("arbitrary email input rejects invalid recipients and header injection", () => {
  assert.deepEqual(
    parseArbitraryEmailInput({
      recipients: "valid@example.com, invalid",
      subject: "Subject",
      html: "<p>Hello</p>",
    }),
    { ok: false, error: "One or more recipient email addresses are invalid" },
  );
  assert.deepEqual(
    parseArbitraryEmailInput({
      recipients: "valid@example.com",
      subject: "Subject\r\nBcc: hidden@example.com",
      html: "<p>Hello</p>",
    }),
    { ok: false, error: "Subject is invalid or too long" },
  );
});

test("arbitrary email event updates count engagement and preserve event bounds", () => {
  const first = new Date("2026-07-20T12:00:00Z");
  const later = new Date("2026-07-20T13:00:00Z");
  const state = {
    status: "sent",
    testSend: false,
    sentAt: first,
    deliveredAt: null,
    firstOpenedAt: later,
    lastOpenedAt: later,
    openCount: 1,
    firstClickedAt: null,
    lastClickedAt: null,
    clickCount: 0,
    bouncedAt: null,
    complainedAt: null,
  };

  assert.deepEqual(arbitraryEmailEventUpdate(state, "email.opened", first), {
    firstOpenedAt: first,
    lastOpenedAt: later,
    openCount: { increment: 1 },
  });
  assert.deepEqual(arbitraryEmailEventUpdate(state, "email.clicked", later), {
    firstClickedAt: later,
    lastClickedAt: later,
    clickCount: { increment: 1 },
  });
});

test("late provider acceptance does not erase a terminal delivery failure", () => {
  const occurredAt = new Date("2026-07-20T14:00:00Z");
  const state = {
    status: "failed",
    testSend: false,
    sentAt: null,
    deliveredAt: null,
    firstOpenedAt: null,
    lastOpenedAt: null,
    openCount: 0,
    firstClickedAt: null,
    lastClickedAt: null,
    clickCount: 0,
    bouncedAt: occurredAt,
    complainedAt: null,
  };

  assert.deepEqual(arbitraryEmailEventUpdate(state, "email.sent", occurredAt), {
    status: "failed",
    sentAt: occurredAt,
  });
  assert.deepEqual(
    arbitraryEmailEventUpdate(state, "email.delivery_delayed", occurredAt),
    {},
  );
});
