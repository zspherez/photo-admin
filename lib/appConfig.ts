/**
 * Central, typed fork configuration.
 *
 * These are the values a fork of this app is expected to change: branding,
 * repository identity, market, time zone, outreach dispatch time, EDMTrain
 * location scope, and the GitHub Actions workflows trusted to mutate contact
 * research/audit state via OIDC. Every default below reproduces this
 * deployment's current behavior exactly; nothing changes unless the
 * corresponding environment variable is explicitly set.
 *
 * This module contains no secrets and is safe to bundle for the browser (it
 * is reached transitively from `lib/calendarDate.ts` via client components).
 */

export interface RepositoryIdentity {
  readonly owner: string;
  readonly name: string;
  /** `<owner>/<name>` */
  readonly slug: string;
  /** `https://github.com/<slug>` */
  readonly url: string;
}

export interface OutreachDispatchConfig {
  /** Local dispatch hour (0-23) in `timeZone`. */
  readonly hour: number;
  /** Local dispatch minute (0-59) in `timeZone`. */
  readonly minute: number;
  /** Human label for the dispatch time, e.g. "9:00 AM ET". */
  readonly label: string;
  /** DST-spanning candidate UTC hours a fixed cron schedule must cover. */
  readonly candidateUtcHours: readonly number[];
}

export interface EdmtrainScopeConfig {
  /** EDMTrain `locationIds` scoped to this deployment's market. */
  readonly locationIds: readonly number[];
}

export interface WorkflowTrustConfig {
  /** `<owner>/<name>` */
  readonly repository: string;
  readonly owner: string;
  /** `<owner>/<name>/.github/workflows/<file>@refs/heads/<branch>` */
  readonly workflowRef: string;
}

export interface AppConfig {
  readonly appName: string;
  readonly appShortName: string;
  readonly appDescription: string;
  readonly pwaDescription: string;
  readonly marketName: string;
  readonly timeZone: string;
  readonly repository: RepositoryIdentity;
  readonly outreachDispatch: OutreachDispatchConfig;
  readonly edmtrain: EdmtrainScopeConfig;
}

// ---- Defaults: preserve this deployment's current behavior exactly. ----

const DEFAULT_APP_NAME = "Rehders Photos Admin";
const DEFAULT_APP_SHORT_NAME = "Photo Admin";
const DEFAULT_APP_DESCRIPTION =
  "Match upcoming shows to your listening history and pitch the photo gig.";
const DEFAULT_PWA_DESCRIPTION =
  "Private mobile admin for show research, contact review, and photo outreach.";
const DEFAULT_MARKET_NAME = "NYC";
const DEFAULT_TIME_ZONE = "America/New_York";
const DEFAULT_REPOSITORY_SLUG = "zspherez/photo-admin";
const DEFAULT_EDMTRAIN_LOCATION_IDS: readonly number[] = [38];
const DEFAULT_OUTREACH_DISPATCH: OutreachDispatchConfig = {
  hour: 9,
  minute: 0,
  label: "9:00 AM ET",
  candidateUtcHours: [13, 14],
};

export const WORKFLOW_TRUSTED_BRANCH_REF = "refs/heads/main";
export const CONTACT_RESEARCH_WORKFLOW_FILE = "contact-research.yml";
export const CONTACT_AUDIT_WORKFLOW_FILE = "contact-audit.yml";

const GITHUB_REPOSITORY_SLUG_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW_FILE_NAME_PATTERN = /^[A-Za-z0-9_.-]+\.(?:yml|yaml)$/;

function defaultRepositoryIdentity(slug: string): RepositoryIdentity {
  const [owner, name] = slug.split("/");
  return { owner, name, slug, url: `https://github.com/${slug}` };
}

const DEFAULT_REPOSITORY_IDENTITY = defaultRepositoryIdentity(
  DEFAULT_REPOSITORY_SLUG,
);

export interface ForkIdentityEnvironment {
  readonly REPOSITORY_SLUG?: string;
  readonly CONTACT_RESEARCH_WORKFLOW_REF?: string;
  readonly CONTACT_AUDIT_WORKFLOW_REF?: string;
  readonly [key: string]: string | undefined;
}

/**
 * Resolves repository identity from `REPOSITORY_SLUG` (`owner/name`).
 * Returns `null` when the override is explicitly set but malformed, so
 * callers can fail closed instead of silently trusting an invalid value.
 * An unset (or blank) value resolves to this deployment's default.
 */
export function resolveRepositoryIdentity(
  env: ForkIdentityEnvironment = process.env,
): RepositoryIdentity | null {
  const override = env.REPOSITORY_SLUG?.trim();
  const slug = override || DEFAULT_REPOSITORY_SLUG;
  if (!GITHUB_REPOSITORY_SLUG_PATTERN.test(slug)) return null;
  return defaultRepositoryIdentity(slug);
}

/** Builds a workflow ref for `repository`'s default branch. */
export function buildWorkflowRef(
  repository: RepositoryIdentity,
  workflowFile: string,
  branchRef: string = WORKFLOW_TRUSTED_BRANCH_REF,
): string {
  return `${repository.slug}/.github/workflows/${workflowFile}@${branchRef}`;
}

function resolveWorkflowTrustConfig(
  repository: RepositoryIdentity,
  overrideRef: string | undefined,
  defaultWorkflowFile: string,
): WorkflowTrustConfig | null {
  const trimmedOverride = overrideRef?.trim();
  const workflowRef =
    trimmedOverride || buildWorkflowRef(repository, defaultWorkflowFile);
  const prefix = `${repository.slug}/.github/workflows/`;
  const suffix = `@${WORKFLOW_TRUSTED_BRANCH_REF}`;
  if (!workflowRef.startsWith(prefix) || !workflowRef.endsWith(suffix)) {
    return null;
  }
  const file = workflowRef.slice(
    prefix.length,
    workflowRef.length - suffix.length,
  );
  if (!WORKFLOW_FILE_NAME_PATTERN.test(file)) return null;
  return { repository: repository.slug, owner: repository.owner, workflowRef };
}

/**
 * Resolves the repository/workflow identity trusted to mutate contact
 * research state via GitHub Actions OIDC. Returns `null` if `REPOSITORY_SLUG`
 * or `CONTACT_RESEARCH_WORKFLOW_REF` is explicitly set but malformed (fail
 * closed: callers must treat a `null` configuration as "trust nothing").
 */
export function resolveContactResearchTrustConfig(
  env: ForkIdentityEnvironment = process.env,
): WorkflowTrustConfig | null {
  const repository = resolveRepositoryIdentity(env);
  if (!repository) return null;
  return resolveWorkflowTrustConfig(
    repository,
    env.CONTACT_RESEARCH_WORKFLOW_REF,
    CONTACT_RESEARCH_WORKFLOW_FILE,
  );
}

/**
 * Resolves the repository/workflow identity trusted to mutate contact audit
 * state via GitHub Actions OIDC. Returns `null` if `REPOSITORY_SLUG` or
 * `CONTACT_AUDIT_WORKFLOW_REF` is explicitly set but malformed (fail closed:
 * callers must treat a `null` configuration as "trust nothing").
 */
export function resolveContactAuditTrustConfig(
  env: ForkIdentityEnvironment = process.env,
): WorkflowTrustConfig | null {
  const repository = resolveRepositoryIdentity(env);
  if (!repository) return null;
  return resolveWorkflowTrustConfig(
    repository,
    env.CONTACT_AUDIT_WORKFLOW_REF,
    CONTACT_AUDIT_WORKFLOW_FILE,
  );
}

export function loadAppConfig(env: ForkIdentityEnvironment = process.env): AppConfig {
  const repository = resolveRepositoryIdentity(env) ?? DEFAULT_REPOSITORY_IDENTITY;
  return {
    appName: DEFAULT_APP_NAME,
    appShortName: DEFAULT_APP_SHORT_NAME,
    appDescription: DEFAULT_APP_DESCRIPTION,
    pwaDescription: DEFAULT_PWA_DESCRIPTION,
    marketName: DEFAULT_MARKET_NAME,
    timeZone: DEFAULT_TIME_ZONE,
    repository,
    outreachDispatch: DEFAULT_OUTREACH_DISPATCH,
    edmtrain: { locationIds: DEFAULT_EDMTRAIN_LOCATION_IDS },
  };
}

/** Central config singleton, resolved once from `process.env` at import. */
export const appConfig: AppConfig = loadAppConfig();

/** Builds a `github.com/<repo>/actions/workflows/<file>` link for display. */
export function workflowActionsUrl(
  workflowRef: string,
  repository: RepositoryIdentity = appConfig.repository,
): string {
  const prefix = `${repository.slug}/.github/workflows/`;
  const file = workflowRef.startsWith(prefix)
    ? workflowRef.slice(prefix.length).split("@")[0]
    : workflowRef;
  return `${repository.url}/actions/workflows/${file}`;
}

/** Builds a `github.com/<repo>/actions/runs/<id>` link for display. */
export function workflowActionsRunUrl(
  runId: string | number,
  repository: RepositoryIdentity = appConfig.repository,
): string {
  return `${repository.url}/actions/runs/${runId}`;
}
