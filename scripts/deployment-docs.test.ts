import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const deploymentDocs = readFileSync(
  new URL("../docs/deployment.md", import.meta.url),
  "utf8",
);
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const vercelConfig = JSON.parse(
  readFileSync(new URL("../vercel.json", import.meta.url), "utf8"),
);

test("README links to the deployment guide", () => {
  assert.match(readme, /\[docs\/deployment\.md\]\(docs\/deployment\.md\)/);
});

test("deployment guide documents both profiles and how forks choose one", () => {
  assert.match(deploymentDocs, /\*\*Basic\*\*/);
  assert.match(deploymentDocs, /\*\*Hardened\*\*/);
  assert.match(deploymentDocs, /## How forks choose a profile/);
  assert.match(
    deploymentDocs,
    /[Nn]either profile is a\s*\nworkflow input or runtime flag/,
  );
});

test("deployment guide covers prerequisites, secrets/variables, crons, migrations, and rollback/recovery", () => {
  assert.match(deploymentDocs, /## Prerequisites/);
  assert.match(deploymentDocs, /### Crons/);
  assert.match(deploymentDocs, /### Migrations/);
  assert.match(deploymentDocs, /Rollback/);
  assert.match(deploymentDocs, /Recovery expectations/);
  assert.match(deploymentDocs, /VERCEL_TOKEN.*VERCEL_ORG_ID.*VERCEL_PROJECT_ID/);
  assert.match(deploymentDocs, /RECOVERY_ENVIRONMENT_GUARD/);
  assert.match(deploymentDocs, /HARDENED_RELEASE_REPOSITORY/);
  assert.match(deploymentDocs, /db:migrate:deploy/);
});

test("deployment guide's basic-profile Vercel edit matches the field release-production.yml actually gates on", () => {
  assert.match(deploymentDocs, /"deploymentEnabled":\s*\{\s*\n\s*"main": true/);
  assert.equal(vercelConfig.git.deploymentEnabled.main, false);
});

test("deployment guide documents the offline readiness command and its guarantees", () => {
  assert.match(deploymentDocs, /npm run deployment:readiness/);
  assert.match(deploymentDocs, /--profile=hardened/);
  assert.match(deploymentDocs, /--json/);
  assert.match(deploymentDocs, /never prints a\s+secret value/);
  assert.match(deploymentDocs, /cannot\* see or verify/);
});

test("README's hardened release section links to the deployment guide and documents the configurable repository variable", () => {
  const hardenedSection = readme.slice(
    readme.indexOf("## Production release safety"),
  );
  assert.match(hardenedSection, /\[docs\/deployment\.md\]\(docs\/deployment\.md\)/);
  assert.match(hardenedSection, /HARDENED_RELEASE_REPOSITORY/);
});
