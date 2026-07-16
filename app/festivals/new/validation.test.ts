import assert from "node:assert/strict";
import test from "node:test";
import type { FestivalFormValues } from "./form-state";
import { validateFestivalCreation } from "./validation";

function values(
  overrides: Partial<FestivalFormValues> = {}
): FestivalFormValues {
  return {
    name: "Test Festival",
    date: "2026-07-16",
    venueName: "Test Venue",
    city: "New York",
    state: "NY",
    lineup: "Artist One",
    ...overrides,
  };
}

test("festival dates use the America/New_York midnight boundary", () => {
  assert.equal(
    validateFestivalCreation(
      values({ date: "2026-07-16" }),
      new Date("2026-07-17T03:59:59.999Z")
    ).ok,
    true
  );

  assert.deepEqual(
    validateFestivalCreation(
      values({ date: "2026-07-16" }),
      new Date("2026-07-17T04:00:00.000Z")
    ),
    {
      ok: false,
      message:
        "Festival date cannot be before the current America/New_York calendar day.",
    }
  );
});

test("festival date validation handles Eastern DST transition days", () => {
  assert.equal(
    validateFestivalCreation(
      values({ date: "2026-03-07" }),
      new Date("2026-03-08T04:59:59.999Z")
    ).ok,
    true
  );
  assert.equal(
    validateFestivalCreation(
      values({ date: "2026-03-07" }),
      new Date("2026-03-08T05:00:00.000Z")
    ).ok,
    false
  );
  assert.equal(
    validateFestivalCreation(
      values({ date: "2026-10-31" }),
      new Date("2026-11-01T03:59:59.999Z")
    ).ok,
    true
  );
  assert.equal(
    validateFestivalCreation(
      values({ date: "2026-10-31" }),
      new Date("2026-11-01T04:00:00.000Z")
    ).ok,
    false
  );
});

test("blank lineup lines are ignored but a blank lineup is rejected", () => {
  const parsed = validateFestivalCreation(
    values({ lineup: "\n  \nArtist One\r\n\t\nArtist Two\n" }),
    new Date("2026-07-16T16:00:00.000Z")
  );
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(
      parsed.entries.map((entry) => entry.name),
      ["Artist One", "Artist Two"]
    );
  }

  assert.deepEqual(
    validateFestivalCreation(
      values({ lineup: "\n \r\n\t" }),
      new Date("2026-07-16T16:00:00.000Z")
    ),
    {
      ok: false,
      message: "Lineup must include at least one artist.",
    }
  );
});

test("invalid submissions return feedback without a persistable payload", () => {
  const invalidSubmissions = [
    values({ name: "" }),
    values({ date: "2026-02-30" }),
    values({ date: "2026-07-15" }),
    values({ lineup: "" }),
  ];

  for (const submission of invalidSubmissions) {
    const result = validateFestivalCreation(
      submission,
      new Date("2026-07-16T16:00:00.000Z")
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.message.length > 0);
  }
});
