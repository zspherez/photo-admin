import assert from "node:assert/strict";
import test from "node:test";
import {
  pickEmailContact,
  pickPhoneContact,
} from "./contactSelection";

const contacts = [
  {
    id: "phone-only",
    email: null,
    phone: "+15550000001",
    isFullTeam: false,
    state: "active" as const,
  },
  {
    id: "manager",
    email: "manager@example.com",
    phone: "+15550000002",
    isFullTeam: false,
    state: "active" as const,
  },
  {
    id: "full-team",
    email: "team@example.com",
    phone: null,
    isFullTeam: true,
    state: "active" as const,
  },
];

test("email selection prefers an email-bearing full-team contact", () => {
  assert.equal(pickEmailContact(contacts)?.id, "full-team");
  assert.equal(
    pickEmailContact(contacts.filter((contact) => !contact.isFullTeam))?.id,
    "manager"
  );
  assert.equal(pickEmailContact([contacts[0]]), null);
});

test("phone selection preserves SMS when the email contact has no phone", () => {
  const emailContact = pickEmailContact(contacts);
  assert.equal(pickPhoneContact(contacts, emailContact)?.id, "phone-only");
  assert.equal(
    pickPhoneContact(
      contacts,
      contacts.find((contact) => contact.id === "manager") ?? null
    )?.id,
    "manager"
  );
});

test("quarantined contacts are never selectable", () => {
  const quarantined = [
    {
      id: "quarantined-full-team",
      email: "legacy@example.com",
      phone: "+15550000003",
      isFullTeam: true,
      state: "quarantined" as const,
    },
  ];
  assert.equal(pickEmailContact(quarantined), null);
  assert.equal(pickPhoneContact(quarantined, quarantined[0]), null);
  assert.equal(
    pickEmailContact([...quarantined, contacts[1]])?.id,
    "manager",
  );
});
