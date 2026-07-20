import assert from "node:assert/strict";
import test from "node:test";
import {
  customizeRecipientIdentity,
  customizeRecipientIdentityError,
  customizeRecipientSelectionError,
  eligibleCustomizeRecipientContacts,
  renderCustomizeRecipientContent,
  type CustomizeRecipientContact,
} from "./customizeRecipients";

const createdAt = new Date("2026-07-20T12:00:00.000Z");
const updatedAt = new Date("2026-07-20T13:00:00.000Z");

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
    updatedAt,
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

test("recipient-specific template rendering switches names without double rendering", () => {
  const template = {
    subject: "Hello {{manager_name}} for {{artist}}",
    htmlBody: "<p>Hello {{manager_name}} for {{artist}}</p>",
  };
  const alice = renderCustomizeRecipientContent(template, {
    manager_name: "Alice",
    artist: "Example Artist",
  });
  const bob = renderCustomizeRecipientContent(template, {
    manager_name: "Bob",
    artist: "Example Artist",
  });
  assert.deepEqual(alice, {
    subject: "Hello Alice for Example Artist",
    html: "<p>Hello Alice for Example Artist</p>",
  });
  assert.deepEqual(bob, {
    subject: "Hello Bob for Example Artist",
    html: "<p>Hello Bob for Example Artist</p>",
  });
  assert.deepEqual(
    renderCustomizeRecipientContent(template, {
      manager_name: "{{artist}}",
      artist: "Example Artist",
    }),
    {
      subject: "Hello {{artist}} for Example Artist",
      html: "<p>Hello {{artist}} for Example Artist</p>",
    },
  );
});

test("bound recipient identity rejects email, state, artist, and version changes", () => {
  const original = contact("route", "manager@example.com");
  const expected = customizeRecipientIdentity(original)!;
  assert.equal(customizeRecipientIdentityError(original, expected), null);
  assert.match(
    customizeRecipientIdentityError(
      { ...original, email: "new@example.com" },
      expected,
    ) ?? "",
    /email changed/,
  );
  assert.match(
    customizeRecipientIdentityError(
      { ...original, artistId: "artist-2" },
      expected,
    ) ?? "",
    /artist changed/,
  );
  assert.match(
    customizeRecipientIdentityError(
      {
        ...original,
        updatedAt: new Date("2026-07-20T14:00:00.000Z"),
      },
      expected,
    ) ?? "",
    /updated/,
  );
  const contextContact = contact("context", "context@example.com");
  assert.match(
    customizeRecipientSelectionError({
      contextContact,
      selectedContact: { ...original, state: "quarantined" },
      artistContacts: [contextContact, original],
    }) ?? "",
    /quarantined/,
  );
});
