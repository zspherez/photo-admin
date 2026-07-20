import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("release probe exercises new festival, outreach, and agent schema surfaces", () => {
  const source = readFileSync(
    new URL("../scripts/verify-release-compatibility.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /db\.show\.count\(\{[\s\S]*countryCode: "US"[\s\S]*countryName: \{ not: null \}/,
  );
  assert.match(
    source,
    /db\.outreach\.count\(\{\s*where: \{ kind: "original", parentOutreachId: null \}/,
  );
  assert.match(
    source,
    /contactProbe,\s*directOutreachNoteProbe,\s*festivalGeographyProbe,\s*outreachKindProbe,\s*outreachAttemptProbe/,
  );
  assert.match(source, /directOutreachNote: \{ not: null \}/);
  assert.match(
    source,
    /db\.contactResearchJob\.findMany\(\{[\s\S]*claimedAgentRules: true,[\s\S]*claimedAgentRulesVersion: true/,
  );
  assert.doesNotMatch(source, /db\.contactResearchJob\.count/);
  assert.match(
    source,
    /db\.agentRuleSet\.findMany\(\{[\s\S]*scope: true,[\s\S]*instructions: true,[\s\S]*version: true,[\s\S]*createdAt: true,[\s\S]*updatedAt: true/,
  );
  assert.match(
    source,
    /\[contactResearchJobProbe, agentRuleSetProbe\]\.every\(Array\.isArray\)/,
  );
});
