import assert from "node:assert/strict";
import test from "node:test";
import {
  appConfig,
  buildWorkflowRef,
  CONTACT_AUDIT_WORKFLOW_FILE,
  CONTACT_RESEARCH_WORKFLOW_FILE,
  PROFESSIONAL_CONTACT_RESEARCH_WORKFLOW_FILE,
  loadAppConfig,
  resolveContactAuditTrustConfig,
  resolveContactResearchTrustConfig,
  resolveProfessionalContactResearchTrustConfig,
  resolveRepositoryIdentity,
  workflowActionsRunUrl,
  workflowActionsUrl,
} from "./appConfig";

test("default config reproduces this deployment's current behavior exactly", () => {
  assert.equal(appConfig.appName, "Rehders Photos Admin");
  assert.equal(appConfig.appShortName, "Photo Admin");
  assert.equal(appConfig.marketName, "NYC");
  assert.equal(appConfig.timeZone, "America/New_York");
  assert.deepEqual(appConfig.edmtrain.locationIds, [38]);
  assert.equal(appConfig.outreachDispatch.hour, 9);
  assert.equal(appConfig.outreachDispatch.minute, 7);
  assert.equal(appConfig.outreachDispatch.label, "9:07 AM ET");
  assert.equal(appConfig.repository.slug, "zspherez/photo-admin");
  assert.equal(appConfig.repository.owner, "zspherez");
  assert.equal(appConfig.repository.name, "photo-admin");
  assert.equal(appConfig.repository.url, "https://github.com/zspherez/photo-admin");
});

test("resolveRepositoryIdentity defaults when REPOSITORY_SLUG is unset or blank", () => {
  assert.equal(resolveRepositoryIdentity({})?.slug, "zspherez/photo-admin");
  assert.equal(
    resolveRepositoryIdentity({ REPOSITORY_SLUG: "" })?.slug,
    "zspherez/photo-admin"
  );
  assert.equal(
    resolveRepositoryIdentity({ REPOSITORY_SLUG: "   " })?.slug,
    "zspherez/photo-admin"
  );
});

test("resolveRepositoryIdentity resolves a valid override", () => {
  const identity = resolveRepositoryIdentity({
    REPOSITORY_SLUG: "my-org/my-fork",
  });
  assert.deepEqual(identity, {
    owner: "my-org",
    name: "my-fork",
    slug: "my-org/my-fork",
    url: "https://github.com/my-org/my-fork",
  });
});

test("resolveRepositoryIdentity fails closed on a malformed override", () => {
  for (const malformed of ["not-a-slug", "owner/", "/name", "owner/name/extra"]) {
    assert.equal(
      resolveRepositoryIdentity({ REPOSITORY_SLUG: malformed }),
      null,
      `expected null for ${JSON.stringify(malformed)}`
    );
  }
});

test("resolveContactResearchTrustConfig defaults to this deployment's workflow", () => {
  const trust = resolveContactResearchTrustConfig({});
  assert.deepEqual(trust, {
    repository: "zspherez/photo-admin",
    owner: "zspherez",
    workflowRef:
      "zspherez/photo-admin/.github/workflows/contact-research.yml@refs/heads/main",
  });
});

test("resolveContactAuditTrustConfig defaults to this deployment's workflow", () => {
  const trust = resolveContactAuditTrustConfig({});
  assert.deepEqual(trust, {
    repository: "zspherez/photo-admin",
    owner: "zspherez",
    workflowRef:
      "zspherez/photo-admin/.github/workflows/contact-audit.yml@refs/heads/main",
  });
});

test("resolveProfessionalContactResearchTrustConfig defaults to the standalone workflow", () => {
  const trust = resolveProfessionalContactResearchTrustConfig({});
  assert.deepEqual(trust, {
    repository: "zspherez/photo-admin",
    owner: "zspherez",
    workflowRef:
      "zspherez/photo-admin/.github/workflows/professional-contact-research.yml@refs/heads/main",
  });
});

test("contact research/audit trust config follows a valid REPOSITORY_SLUG override", () => {
  const env = { REPOSITORY_SLUG: "my-org/my-fork" };
  assert.equal(
    resolveContactResearchTrustConfig(env)?.workflowRef,
    "my-org/my-fork/.github/workflows/contact-research.yml@refs/heads/main"
  );
  assert.equal(
    resolveContactAuditTrustConfig(env)?.workflowRef,
    "my-org/my-fork/.github/workflows/contact-audit.yml@refs/heads/main"
  );
  assert.equal(
    resolveProfessionalContactResearchTrustConfig(env)?.workflowRef,
    "my-org/my-fork/.github/workflows/professional-contact-research.yml@refs/heads/main"
  );
});

test("contact research/audit trust config fails closed on an invalid REPOSITORY_SLUG", () => {
  const env = { REPOSITORY_SLUG: "not a slug" };
  assert.equal(resolveContactResearchTrustConfig(env), null);
  assert.equal(resolveContactAuditTrustConfig(env), null);
  assert.equal(resolveProfessionalContactResearchTrustConfig(env), null);
});

test("contact research trust config fails closed on a malformed workflow ref override", () => {
  const validRepository = { REPOSITORY_SLUG: "my-org/my-fork" };
  for (const malformed of [
    "wrong-org/my-fork/.github/workflows/contact-research.yml@refs/heads/main",
    "my-org/my-fork/.github/workflows/contact-research.yml@refs/heads/other",
    "my-org/my-fork/.github/workflows/contact-research.exe@refs/heads/main",
    "my-org/my-fork/.github/workflows/@refs/heads/main",
  ]) {
    assert.equal(
      resolveContactResearchTrustConfig({
        ...validRepository,
        CONTACT_RESEARCH_WORKFLOW_REF: malformed,
      }),
      null,
      `expected null for ${JSON.stringify(malformed)}`
    );
  }
});

test("contact audit trust config fails closed on a malformed workflow ref override", () => {
  assert.equal(
    resolveContactAuditTrustConfig({
      CONTACT_AUDIT_WORKFLOW_REF:
        "zspherez/photo-admin/.github/workflows/contact-audit.yml@refs/heads/side-branch",
    }),
    null
  );
});

test("professional contact trust config fails closed on a malformed workflow ref override", () => {
  assert.equal(
    resolveProfessionalContactResearchTrustConfig({
      PROFESSIONAL_CONTACT_RESEARCH_WORKFLOW_REF:
        "zspherez/photo-admin/.github/workflows/professional-contact-research.yml@refs/heads/side-branch",
    }),
    null,
  );
});

test("contact research/audit trust config accepts an explicit valid override matching the default", () => {
  assert.equal(
    resolveContactResearchTrustConfig({
      CONTACT_RESEARCH_WORKFLOW_REF: buildWorkflowRef(
        { owner: "zspherez", name: "photo-admin", slug: "zspherez/photo-admin", url: "https://github.com/zspherez/photo-admin" },
        CONTACT_RESEARCH_WORKFLOW_FILE
      ),
    })?.workflowRef,
    "zspherez/photo-admin/.github/workflows/contact-research.yml@refs/heads/main"
  );
});

test("loadAppConfig falls back to the default repository when the override is malformed", () => {
  const config = loadAppConfig({ REPOSITORY_SLUG: "not a slug" });
  assert.equal(config.repository.slug, "zspherez/photo-admin");
});

test("workflowActionsUrl builds a repo-scoped Actions link from a workflow ref", () => {
  const ref = buildWorkflowRef(appConfig.repository, CONTACT_AUDIT_WORKFLOW_FILE);
  assert.equal(
    workflowActionsUrl(ref),
    "https://github.com/zspherez/photo-admin/actions/workflows/contact-audit.yml"
  );
});

test("professional contact workflow URL is repository scoped", () => {
  const ref = buildWorkflowRef(
    appConfig.repository,
    PROFESSIONAL_CONTACT_RESEARCH_WORKFLOW_FILE,
  );
  assert.equal(
    workflowActionsUrl(ref),
    "https://github.com/zspherez/photo-admin/actions/workflows/professional-contact-research.yml",
  );
});

test("workflowActionsRunUrl builds a repo-scoped Actions run link", () => {
  assert.equal(
    workflowActionsRunUrl(12345),
    "https://github.com/zspherez/photo-admin/actions/runs/12345"
  );
});
