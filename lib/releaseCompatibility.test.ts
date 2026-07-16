import assert from "node:assert/strict";
import test from "node:test";
import {
  assertReleaseCompatibility,
  ReleaseCompatibilityError,
} from "./releaseCompatibility";

test("schema compatibility can be verified before Sheet ownership cutover", () => {
  assert.doesNotThrow(() =>
    assertReleaseCompatibility(
      {
        databaseProbeSucceeded: true,
        configuredSpreadsheetId: null,
        configuredSheetTab: null,
        activeUnownedSheetContacts: 4,
      },
      false
    )
  );
});

test("post-adoption compatibility requires a complete target and no active unowned Sheet contacts", () => {
  assert.doesNotThrow(() =>
    assertReleaseCompatibility(
      {
        databaseProbeSucceeded: true,
        configuredSpreadsheetId: "sheet-123",
        configuredSheetTab: "Artists",
        activeUnownedSheetContacts: 0,
      },
      true
    )
  );
  assert.throws(
    () =>
      assertReleaseCompatibility(
        {
          databaseProbeSucceeded: true,
          configuredSpreadsheetId: "sheet-123",
          configuredSheetTab: null,
          activeUnownedSheetContacts: 0,
        },
        true
      ),
    ReleaseCompatibilityError
  );
  assert.throws(
    () =>
      assertReleaseCompatibility(
        {
          databaseProbeSucceeded: true,
          configuredSpreadsheetId: "sheet-123",
          configuredSheetTab: "Artists",
          activeUnownedSheetContacts: 1,
        },
        true
      ),
    /Active legacy Sheet contacts/
  );
});

test("required schema probes fail closed", () => {
  assert.throws(
    () =>
      assertReleaseCompatibility(
        {
          databaseProbeSucceeded: false,
          configuredSpreadsheetId: null,
          configuredSheetTab: null,
          activeUnownedSheetContacts: 0,
        },
        false
      ),
    /required schema surface/
  );
});
