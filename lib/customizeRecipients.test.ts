import assert from "node:assert/strict";
import test from "node:test";
import {
  customizeRecipientSelectionError,
  eligibleCustomizeRecipientContacts,
  type CustomizeRecipientContact,
} from "./customizeRecipients";

const createdAt = new Date("2026-07-20T12:00:00.000Z");

function contact(
  id: string,
  email: string | null,
  overrides: Partial<CustomizeRecipientContact> = {},
): CustomizeRecipientContact {
  return {
    id,
    artistId: "artist-1",
    email,
    state: "active",
    createdAt,
    ...overrides,
  };
}

test("the URL contact is the default canonical recipient", () => {
  const contacts = [
    contact("older", "manager@example.com", {
      createdAt: new Date("2026-07-19T12:00:00.000Z"),
    }),
    contact("route", "MANAGER@example.com"),
    contact("other", "agent@example.com"),
  ];

  assert.deepEqual(
    eligibleCustomizeRecipientContacts(contacts, "route").map(
      (candidate) => candidate.id,
    ),
    ["route", "other"],
  );
});

test("another active same-artist email can be selected", () => {
  const contextContact = contact("route", "manager@example.com");
  const selectedContact = contact("other", "agent@example.com");
  assert.equal(
    customizeRecipientSelectionError({
      contextContact,
      selectedContact,
      artistContacts: [contextContact, selectedContact],
    }),
    null,
  );
});

test("invalid, stale, suppressed, and cross-artist selections are rejected", () => {
  const contextContact = contact("route", "manager@example.com");
  const valid = contact("valid", "agent@example.com");
  const artistContacts = [contextContact, valid];

  assert.match(
    customizeRecipientSelectionError({
      contextContact,
      selectedContact: contact("cross", "cross@example.com", {
        artistId: "artist-2",
      }),
      artistContacts,
    }) ?? "",
    /same artist/,
  );
  assert.match(
    customizeRecipientSelectionError({
      contextContact,
      selectedContact: contact("quarantined", "old@example.com", {
        state: "quarantined",
      }),
      artistContacts,
    }) ?? "",
    /quarantined/,
  );
  assert.match(
    customizeRecipientSelectionError({
      contextContact,
      selectedContact: contact("missing", null),
      artistContacts,
    }) ?? "",
    /valid email/,
  );
  assert.match(
    customizeRecipientSelectionError({
      contextContact,
      selectedContact: valid,
      artistContacts,
      suppressedEmails: ["AGENT@example.com"],
    }) ?? "",
    /suppressed/,
  );
  assert.match(
    customizeRecipientSelectionError({
      contextContact,
      selectedContact: null,
      artistContacts,
    }) ?? "",
    /no longer available/,
  );
});

test("duplicate same-artist addresses resolve deterministically", () => {
  const contextContact = contact("route", "route@example.com");
  const first = contact("first", "team@example.com", {
    createdAt: new Date("2026-07-18T12:00:00.000Z"),
  });
  const duplicate = contact("duplicate", "TEAM@example.com", {
    createdAt: new Date("2026-07-19T12:00:00.000Z"),
  });
  const artistContacts = [duplicate, contextContact, first];

  assert.deepEqual(
    eligibleCustomizeRecipientContacts(artistContacts, contextContact.id).map(
      (candidate) => candidate.id,
    ),
    ["route", "first"],
  );
  assert.match(
    customizeRecipientSelectionError({
      contextContact,
      selectedContact: duplicate,
      artistContacts,
    }) ?? "",
    /duplicates another active contact/,
  );
});
