import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildFestivalConfirmationGroups } from "./festival-bulk-outreach-form";

const source = readFileSync(
  new URL("./festival-bulk-outreach-form.tsx", import.meta.url),
  "utf8",
);

test("festival bulk outreach supports select all and grouped confirmation", () => {
  assert.match(source, />\s*Select all\s*</);
  assert.match(source, />\s*Send to selected\s*</);
  assert.match(source, /Confirm festival outreach/);
  assert.match(source, /<th[^>]*>To<\/th>/);
  assert.match(source, /<th[^>]*>CC<\/th>/);
  assert.match(source, /<th[^>]*>Associated artists<\/th>/);
  assert.match(source, /<th[^>]*>Type<\/th>/);
  assert.match(source, /<th[^>]*>Email format<\/th>/);
  assert.match(source, /"Shared"/);
  assert.match(source, /"to_thread"/);
  assert.match(source, /Put every management contact in To/);
  assert.match(
    source,
    /selected\.has\(candidate\.selectionId\)[\s\S]*candidate\.outreachKind === "original"[\s\S]*!candidate\.immutableDeliveryMode[\s\S]*\(candidate\.recipientDeliveryMode === "to_thread" \|\|[\s\S]*candidate\.recipientDeliveryMode === "cc_thread"\)/,
  );
  assert.match(source, /group\.outreachKind === "follow_up"/);
  assert.match(source, /"Inherited from original"/);
  assert.match(
    source,
    /checkbox\.value === target\.value[\s\S]*checkbox\.checked = target\.checked/,
  );
  assert.match(source, /target\.dataset\.festivalArtistId/);
  assert.match(source, /artistValues\.has\(checkbox\.value\)[\s\S]*checkbox\.checked = target\.checked/);
  assert.match(source, /syncArtistCheckboxes\(formId\)/);
  assert.match(
    source,
    /new Set\(candidates\.map\(\(candidate\) => candidate\.selectionId\)\)\.size/,
  );
  assert.match(source, /"Individual"/);
  assert.match(source, /PendingSubmitButton/);
  assert.match(source, /dialog\.showModal\(\)/);
  assert.match(source, /onCancel=\{\(\) => setConfirming\(false\)\}/);
  assert.match(source, /Confirm send \/ schedule/);
});

test("confirmation groups selected artists by the exact server grouping key", () => {
  assert.deepEqual(
    buildFestivalConfirmationGroups(
      [
        {
          selectionId: "original:contact-a",
          artistId: "artist-a",
          coveredArtistIds: ["artist-a"],
          contactId: "contact-a",
          outreachKind: "original",
          artistNames: ["Artist A"],
          groupKey: "manager@example.com",
          emailLabel: "manager@example.com",
          recipients: ["manager@example.com"],
          primaryRecipientEmail: "manager@example.com",
          recipientDeliveryMode: "individual_threads",
          immutableDeliveryMode: false,
          selectedByDefault: false,
        },
        {
          selectionId: "original:contact-b",
          artistId: "artist-b",
          coveredArtistIds: ["artist-b"],
          contactId: "contact-b",
          outreachKind: "original",
          artistNames: ["Artist B"],
          groupKey: "manager@example.com",
          emailLabel: "manager@example.com",
          recipients: ["manager@example.com"],
          primaryRecipientEmail: "manager@example.com",
          recipientDeliveryMode: "individual_threads",
          immutableDeliveryMode: false,
          selectedByDefault: false,
        },
        {
          selectionId: "follow_up:outreach-c",
          artistId: "artist-c",
          coveredArtistIds: ["artist-c", "artist-d"],
          contactId: "contact-c",
          outreachKind: "follow_up",
          artistNames: ["Artist C", "Artist D"],
          groupKey: "follow_up:outreach-c",
          emailLabel: "team@example.com, manager@example.com",
          recipients: ["manager@example.com", "team@example.com"],
          primaryRecipientEmail: "manager@example.com",
          recipientDeliveryMode: "individual_threads",
          immutableDeliveryMode: true,
          selectedByDefault: false,
        },
      ],
      [
        "original:contact-a",
        "original:contact-b",
        "follow_up:outreach-c",
      ],
    ),
    [
      {
        groupKey: "manager@example.com",
        outreachKind: "original",
        emailLabel: "manager@example.com",
        artistNames: ["Artist A", "Artist B"],
        recipients: ["manager@example.com"],
        primaryRecipientEmail: "manager@example.com",
        recipientDeliveryMode: "individual_threads",
        immutableDeliveryMode: false,
      },
      {
        groupKey: "follow_up:outreach-c",
        outreachKind: "follow_up",
        emailLabel: "team@example.com, manager@example.com",
        artistNames: ["Artist C", "Artist D"],
        recipients: ["manager@example.com", "team@example.com"],
        primaryRecipientEmail: "manager@example.com",
        recipientDeliveryMode: "individual_threads",
        immutableDeliveryMode: true,
      },
    ],
  );
});

test("mixed original and follow-up confirmation has three messages per stage", () => {
  const candidates = [
    ["jon-layz", "LAYZ", "jon@confirmedgroup.com"],
    ["emily", "LAYZ", "emily@confirmedgroup.com"],
    ["anthony", "Wooli", "anthony@confirmedgroup.com"],
    ["jon-wooli", "Wooli", "jon@confirmedgroup.com"],
  ].map(([contactId, artistName, email]) => ({
    selectionId: `original:${contactId}`,
    artistId: artistName,
    coveredArtistIds: [artistName],
    contactId,
    outreachKind: "original" as const,
    artistNames: [artistName],
    groupKey: email,
    emailLabel: email,
    recipients: [email],
    primaryRecipientEmail: email,
    recipientDeliveryMode: "individual_threads" as const,
    immutableDeliveryMode: false,
    selectedByDefault: false,
  }));
  const originals = buildFestivalConfirmationGroups(
    candidates,
    candidates.map((candidate) => candidate.selectionId),
  );
  assert.deepEqual(originals.map((group) => [group.emailLabel, group.artistNames]), [
    ["jon@confirmedgroup.com", ["LAYZ", "Wooli"]],
    ["emily@confirmedgroup.com", ["LAYZ"]],
    ["anthony@confirmedgroup.com", ["Wooli"]],
  ]);
  const followUps = buildFestivalConfirmationGroups(
    originals.map((group, index) => ({
      ...candidates[index],
      selectionId: `follow_up:${index}`,
      outreachKind: "follow_up" as const,
      groupKey: `follow_up:${index}`,
      artistNames: group.artistNames,
      coveredArtistIds: group.artistNames,
      emailLabel: group.emailLabel,
      recipients: group.recipients,
    })),
    ["follow_up:0", "follow_up:1", "follow_up:2"],
  );
  assert.deepEqual(
    followUps.map((group) => [group.emailLabel, group.artistNames]),
    originals.map((group) => [group.emailLabel, group.artistNames]),
  );
});

test("submission uses the click-time confirmation selection and its exact plan", () => {
  assert.match(source, /setConfirmedIds\(selectedOutreachTargets\)/);
  assert.match(source, /buildFestivalConfirmationGroups\(candidates, confirmedIds\)/);
  assert.match(source, /formData\.delete\("outreachTargets"\)/);
  assert.match(source, /for \(const id of confirmedIds\) formData\.append\("outreachTargets", id\)/);
  assert.match(source, /JSON\.stringify\(festivalConfirmedPlan\([\s\S]*candidates, confirmedIds, recipientDeliveryMode/);
});
