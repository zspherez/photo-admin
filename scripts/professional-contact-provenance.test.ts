import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFetchedSourceRecord,
  emailAssociation,
  ownershipStatement,
} from "./professional-contact-provenance.mjs";

test("compact adjacent staff records cannot bind another person's email", () => {
  const source = buildFetchedSourceRecord({
    url: "https://ledpresents.com/team",
    title: "LED Presents Team",
    text:
      "Jane Doe — Founder | John Smith — COO — john.smith@ledpresents.com",
    emails: ["john.smith@ledpresents.com"],
    links: [],
    blocks: [
      "Jane Doe — Founder | John Smith — COO — john.smith@ledpresents.com",
    ],
  });
  assert.equal(
    emailAssociation(source, "john.smith@ledpresents.com", {
      personName: "Jane Doe",
      organizationName: "LED Presents",
    }),
    null,
  );
});

test("separate one-person one-email records produce unambiguous associations", () => {
  const source = buildFetchedSourceRecord({
    url: "https://ledpresents.com/team",
    title: "LED Presents Team",
    text:
      "Jane Doe — Founder — jane.doe@ledpresents.com\nJohn Smith — COO — john.smith@ledpresents.com",
    emails: [
      "jane.doe@ledpresents.com",
      "john.smith@ledpresents.com",
    ],
    links: [],
    blocks: [
      "Jane Doe — Founder — jane.doe@ledpresents.com",
      "John Smith — COO — john.smith@ledpresents.com",
    ],
  });
  assert.ok(
    emailAssociation(source, "jane.doe@ledpresents.com", {
      personName: "Jane Doe",
      organizationName: "LED Presents",
    }),
  );
  const ambiguous = buildFetchedSourceRecord({
    url: "https://ledpresents.com/contact",
    title: "LED Presents Contact",
    text:
      "Jane Doe jane.doe@ledpresents.com john.smith@ledpresents.com",
    emails: [
      "jane.doe@ledpresents.com",
      "john.smith@ledpresents.com",
    ],
    links: [],
    blocks: [
      "Jane Doe jane.doe@ledpresents.com john.smith@ledpresents.com",
    ],
  });
  assert.equal(
    emailAssociation(ambiguous, "jane.doe@ledpresents.com", {
      personName: "Jane Doe",
      organizationName: "LED Presents",
    }),
    null,
  );
});

test("domain links require an explicit contextual ownership statement", () => {
  const linked = buildFetchedSourceRecord({
    url: "https://ledpresents.com/partners",
    title: "LED Presents Partners",
    text: "LED Presents works with agency.com for selected events.",
    emails: [],
    links: [{ label: "Agency", url: "https://agency.com/" }],
    blocks: ["LED Presents works with agency.com for selected events."],
  });
  assert.equal(
    ownershipStatement(linked, "agency.com", "LED Presents"),
    null,
  );
  const official = buildFetchedSourceRecord({
    url: "https://ledpresents.com/contact",
    title: "LED Presents Contact",
    text: "LED Presents official email domain: ledmail.com",
    emails: [],
    links: [],
    blocks: ["LED Presents official email domain: ledmail.com"],
  });
  assert.ok(
    ownershipStatement(official, "ledmail.com", "LED Presents"),
  );
});
