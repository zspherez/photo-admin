import assert from "node:assert/strict";
import test from "node:test";
import {
  ENV_SCHEMA,
  ENV_VAR_GROUPS,
  ENV_VAR_GROUP_ORDER,
  envVarDefinition,
  envVarsByGroup,
} from "./envSchema";

test("every schema entry has a unique key", () => {
  const keys = ENV_SCHEMA.map((entry) => entry.key);
  assert.equal(new Set(keys).size, keys.length);
});

test("every schema entry belongs to a known group", () => {
  for (const entry of ENV_SCHEMA) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(ENV_VAR_GROUPS, entry.group),
      `unknown group ${entry.group} for ${entry.key}`
    );
  }
});

test("group order lists every group exactly once", () => {
  assert.equal(new Set(ENV_VAR_GROUP_ORDER).size, ENV_VAR_GROUP_ORDER.length);
  assert.deepEqual(
    [...ENV_VAR_GROUP_ORDER].sort(),
    Object.keys(ENV_VAR_GROUPS).sort()
  );
});

test("envVarDefinition finds an entry by key and returns undefined otherwise", () => {
  assert.equal(envVarDefinition("DATABASE_URL")?.group, "database");
  assert.equal(envVarDefinition("NOT_A_REAL_VAR"), undefined);
});

test("envVarsByGroup returns only entries from the requested group", () => {
  const databaseVars = envVarsByGroup("database");
  assert.ok(databaseVars.length > 0);
  for (const entry of databaseVars) assert.equal(entry.group, "database");
});

test("fork-identity overrides are documented as optional, non-secret configuration", () => {
  for (const key of [
    "REPOSITORY_SLUG",
    "CONTACT_RESEARCH_WORKFLOW_REF",
    "CONTACT_AUDIT_WORKFLOW_REF",
  ]) {
    const entry = envVarDefinition(key);
    assert.ok(entry, `missing schema entry for ${key}`);
    assert.equal(entry!.group, "fork-identity");
    assert.equal(entry!.secret, false);
    assert.equal(entry!.defaultValue, "");
  }
});

test("every entry flagged secret defaults to an empty string or a masked placeholder", () => {
  for (const entry of ENV_SCHEMA) {
    if (entry.secret) {
      const isEmpty = entry.defaultValue === "";
      const isMaskedPlaceholder = entry.defaultValue.includes("******");
      assert.ok(
        isEmpty || isMaskedPlaceholder,
        `${entry.key} is flagged secret but its default value is neither empty nor masked`
      );
    }
  }
});

test("core groups are marked as core and optional groups as optional", () => {
  assert.equal(ENV_VAR_GROUPS.database.kind, "core");
  assert.equal(ENV_VAR_GROUPS.app.kind, "core");
  for (const [group, info] of Object.entries(ENV_VAR_GROUPS)) {
    if (group === "database" || group === "app") continue;
    assert.equal(info.kind, "optional", `${group} should be optional`);
  }
});
