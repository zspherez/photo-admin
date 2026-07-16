import assert from "node:assert/strict";
import test from "node:test";
import {
  addDateOnlyDays,
  easternDateOnly,
  easternTodayStoredDate,
  parseDateOnly,
  splitDateOnlyRange,
} from "./calendarDate";

test("Eastern calendar day remains active until Eastern midnight", () => {
  assert.equal(
    easternTodayStoredDate(new Date("2026-07-17T03:59:59Z")).toISOString(),
    "2026-07-16T00:00:00.000Z"
  );
  assert.equal(
    easternTodayStoredDate(new Date("2026-07-17T04:00:00Z")).toISOString(),
    "2026-07-17T00:00:00.000Z"
  );
});

test("Eastern date conversion handles both DST transitions", () => {
  assert.equal(easternDateOnly(new Date("2026-03-08T04:59:59Z")), "2026-03-07");
  assert.equal(easternDateOnly(new Date("2026-03-08T05:00:00Z")), "2026-03-08");
  assert.equal(easternDateOnly(new Date("2026-11-01T03:59:59Z")), "2026-10-31");
  assert.equal(easternDateOnly(new Date("2026-11-01T04:00:00Z")), "2026-11-01");
});

test("date-only arithmetic is calendar based and validated", () => {
  assert.equal(addDateOnlyDays("2024-02-28", 1), "2024-02-29");
  assert.equal(addDateOnlyDays("2024-02-29", 1), "2024-03-01");
  assert.throws(() => parseDateOnly("2026-02-30"), /Invalid calendar date/);
  assert.deepEqual(splitDateOnlyRange("2026-03-01", "2026-03-05", 2), [
    { startDate: "2026-03-01", endDate: "2026-03-02" },
    { startDate: "2026-03-03", endDate: "2026-03-04" },
    { startDate: "2026-03-05", endDate: "2026-03-05" },
  ]);
});
