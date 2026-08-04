import assert from "node:assert/strict";
import test from "node:test";
import {
  emailContactsRequireSelection,
  pickDirectOutreachContact,
  pickEmailContact,
  pickPhoneContact,
} from "./contactSelection";

const contacts = [
  {
    id: "phone-only",
    email: null,
    phone: "+15550000001",
    directOutreachNote: null,
    isFullTeam: false,
    state: "active" as const,
  },
  {
    id: "manager",
    email: "manager@example.com",
    phone: "+15550000002",
    directOutreachNote: null,
    isFullTeam: false,
    state: "active" as const,
  },
  {
    id: "full-team",
    email: "team@example.com",
    phone: null,
    directOutreachNote: null,
    isFullTeam: true,
    state: "active" as const,
  },
];

test("email selection uses the first active email without marker semantics", () => {
  assert.equal(pickEmailContact(contacts)?.id, "manager");
  assert.equal(pickEmailContact([contacts[0]]), null);
});

test("multiple active email contacts always require explicit selection", () => {
  const managerContacts = contacts.filter(
    (contact) => contact.id !== "phone-only",
  );

  assert.equal(
    emailContactsRequireSelection(managerContacts),
    true,
  );
  assert.equal(
    emailContactsRequireSelection([
      managerContacts[0],
      { ...managerContacts[1], state: "quarantined" },
    ]),
    false,
  );
});

test("phone selection prefers the selected email contact when it has a phone", () => {
  const emailContact = pickEmailContact(contacts);
  assert.equal(pickPhoneContact(contacts, emailContact)?.id, "manager");
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
      directOutreachNote: null,
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

test("direct outreach contacts never become email or SMS targets", () => {
  const direct = {
    id: "direct",
    email: null,
    phone: null,
    directOutreachNote: "Reach out through a personal introduction",
    isFullTeam: true,
    state: "active" as const,
  };

  assert.equal(pickEmailContact([direct]), null);
  assert.equal(pickPhoneContact([direct]), null);
  assert.equal(pickDirectOutreachContact([direct])?.id, "direct");
});
