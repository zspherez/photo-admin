import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeProfessionalPersonNames,
  parseProfessionalContactRequestInput,
} from "./professionalContactInput";

test("professional contact request validation normalizes and deduplicates names", () => {
  assert.deepEqual(
    parseProfessionalContactRequestInput({
      organizationName: "  LED   Presents ",
      website: "https://ledpresents.com/#team",
      locationContext: " San   Diego ",
      notes: " Founders ",
      personNames: "Jane Doe\n jane   doe \nJohn Smith\n",
    }),
    {
      organizationName: "LED Presents",
      normalizedOrganization: "led presents",
      website: "https://ledpresents.com/",
      locationContext: "San Diego",
      notes: "Founders",
      personNames: ["Jane Doe", "John Smith"],
    },
  );
});

test("professional contact request validation is bounded and requires public HTTPS", () => {
  assert.throws(
    () =>
      parseProfessionalContactRequestInput({
        organizationName: "LED Presents",
        website: "http://localhost/team",
        personNames: "Jane Doe",
      }),
    /public HTTPS/,
  );
  assert.throws(
    () =>
      normalizeProfessionalPersonNames(
        Array.from({ length: 51 }, (_, index) => `Person ${index + 1}`).join(
          "\n",
        ),
      ),
    /no more than 50/,
  );
  assert.throws(
    () => normalizeProfessionalPersonNames("1234"),
    /invalid/,
  );
});
