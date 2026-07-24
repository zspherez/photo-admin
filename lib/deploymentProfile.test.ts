import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_DEPLOYMENT_PROFILE,
  DEPLOYMENT_PROFILES,
  resolveDeploymentProfile,
} from "./deploymentProfile";

test("defaults to basic when nothing is set", () => {
  assert.equal(DEFAULT_DEPLOYMENT_PROFILE, "basic");
  assert.equal(resolveDeploymentProfile(undefined, {}), "basic");
});

test("defaults to basic when both CLI value and env are blank", () => {
  assert.equal(
    resolveDeploymentProfile("", { DEPLOYMENT_PROFILE: "   " }),
    "basic",
  );
});

test("DEPLOYMENT_PROFILE env selects a profile when no CLI value is given", () => {
  assert.equal(
    resolveDeploymentProfile(undefined, { DEPLOYMENT_PROFILE: "hardened" }),
    "hardened",
  );
  assert.equal(
    resolveDeploymentProfile(undefined, { DEPLOYMENT_PROFILE: "basic" }),
    "basic",
  );
});

test("an explicit CLI value wins over DEPLOYMENT_PROFILE", () => {
  assert.equal(
    resolveDeploymentProfile("hardened", { DEPLOYMENT_PROFILE: "basic" }),
    "hardened",
  );
});

test("is case-insensitive and trims whitespace", () => {
  assert.equal(resolveDeploymentProfile("  Hardened ", {}), "hardened");
  assert.equal(
    resolveDeploymentProfile(undefined, { DEPLOYMENT_PROFILE: " BASIC " }),
    "basic",
  );
});

test("fails closed (returns null) for an unrecognized explicit value", () => {
  assert.equal(resolveDeploymentProfile("advanced", {}), null);
  assert.equal(
    resolveDeploymentProfile(undefined, { DEPLOYMENT_PROFILE: "prod" }),
    null,
  );
});

test("DEPLOYMENT_PROFILES lists exactly the documented profiles", () => {
  assert.deepEqual([...DEPLOYMENT_PROFILES].sort(), ["basic", "hardened"]);
});
