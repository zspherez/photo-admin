import assert from "node:assert/strict";
import test from "node:test";
import {
  groupFestivalManagerTargets,
  sharedFestivalManagementArtistIds,
  uniqueFestivalRecipientTargets,
} from "./festivalOutreach";

test("festival manager targets collapse shared recipient emails deterministically", () => {
  const result = groupFestivalManagerTargets(
    [
      {
        artistId: "artist-b",
        contactId: "contact-b",
        email: "manager@example.com",
      },
      {
        artistId: "artist-a",
        contactId: "contact-a",
        email: "manager@example.com",
      },
      {
        artistId: "artist-c",
        contactId: "contact-c",
        email: "other@example.com",
      },
    ],
    new Set(["contact-a", "contact-b", "contact-c"]),
  );
  assert.deepEqual(result, {
    groups: [
      {
        email: "manager@example.com",
        contactId: "contact-a",
        artistIds: ["artist-a", "artist-b"],
      },
      {
        email: "other@example.com",
        contactId: "contact-c",
        artistIds: ["artist-c"],
      },
    ],
    skipped: 0,
  });

  test("mixed manager recipients produce one shared target and two individual targets", () => {
    const targets = uniqueFestivalRecipientTargets([
      {
        artistId: "layz",
        contacts: [
          { id: "emily", email: "Emily@ConfirmedGroup.com", state: "active" },
          { id: "jon-layz", email: "Jon <jon@confirmedgroup.com>", state: "active" },
          { id: "duplicate", email: "JON@confirmedgroup.com", state: "active" },
        ],
      },
      {
        artistId: "wooli",
        contacts: [
          { id: "anthony", email: "anthony@confirmedgroup.com", state: "active" },
          { id: "jon-wooli", email: "jon@confirmedgroup.com", state: "active" },
          { id: "quarantined", email: "skip@example.com", state: "quarantined" },
        ],
      },
    ]);
    const { groups } = groupFestivalManagerTargets(
      targets,
      new Set(targets.map((target) => target.contactId)),
    );
    assert.deepEqual(
      groups.map((group) => [group.email, group.artistIds]),
      [
        ["emily@confirmedgroup.com", ["layz"]],
        ["jon@confirmedgroup.com", ["layz", "wooli"]],
        ["anthony@confirmedgroup.com", ["wooli"]],
      ],
    );
  });
});

test("festival manager grouping excludes contacts that fail sendability", () => {
  const result = groupFestivalManagerTargets(
    [
      {
        artistId: "artist-a",
        contactId: "contact-a",
        email: "manager@example.com",
      },
      {
        artistId: "artist-b",
        contactId: "contact-b",
        email: "manager@example.com",
      },
    ],
    new Set(["contact-a"]),
  );
  assert.deepEqual(result, {
    groups: [
      {
        email: "manager@example.com",
        contactId: "contact-a",
        artistIds: ["artist-a"],
      },
    ],
    skipped: 1,
  });
});

test("shared management includes artists with a common active email", () => {
  const shared = sharedFestivalManagementArtistIds([
    { artistId: "artist-a", contactId: "contact-a1", email: "team@example.com" },
    { artistId: "artist-a", contactId: "contact-a2", email: "team@example.com" },
    { artistId: "artist-b", contactId: "contact-b1", email: "team@example.com" },
    { artistId: "artist-b", contactId: "contact-b2", email: "other@example.com" },
    { artistId: "artist-c", contactId: "contact-c1", email: "other@example.com" },
    { artistId: "artist-d", contactId: "contact-d1", email: "solo@example.com" },
    { artistId: "artist-e", contactId: "contact-e1", email: "duplicate@example.com" },
    { artistId: "artist-e", contactId: "contact-e2", email: "duplicate@example.com" },
  ]);
  assert.deepEqual([...shared].sort(), ["artist-a", "artist-b", "artist-c"]);
  assert.deepEqual(sharedFestivalManagementArtistIds([]), new Set());
});
