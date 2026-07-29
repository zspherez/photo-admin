import assert from "node:assert/strict";
import test from "node:test";
import { groupFestivalManagerTargets } from "./festivalOutreach";

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
