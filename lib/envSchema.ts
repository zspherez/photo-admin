/**
 * Single source of truth for this app's environment variables.
 *
 * `.env.example` and `docs/environment.md` are generated (and checked for
 * drift) from this list by `scripts/generate-env-docs.ts` — see
 * `npm run env:generate` / `npm run env:check`. `npm run setup:check` also
 * reads this schema to separate required core configuration from optional
 * integrations without ever printing secret values.
 *
 * This module is dependency-free (no Zod) by design: the repository's only
 * Zod dependency is a devDependency used solely by tooling, not a direct
 * runtime dependency, so a small typed array is more consistent with the
 * rest of the codebase's hand-written parsers/validators.
 */

export type EnvVarGroup =
  | "database"
  | "app"
  | "fork-identity"
  | "contact-agents"
  | "trajectory"
  | "spotify"
  | "statsfm"
  | "edmtrain"
  | "resend"
  | "send-behavior"
  | "google-sheets";

export interface EnvVarGroupInfo {
  readonly heading: string;
  /**
   * "core" groups are essential for running the app at all; "optional"
   * groups are independent integrations a fork can adopt incrementally.
   */
  readonly kind: "core" | "optional";
}

export const ENV_VAR_GROUPS: Record<EnvVarGroup, EnvVarGroupInfo> = {
  database: { heading: "Database (Postgres)", kind: "core" },
  app: { heading: "App", kind: "core" },
  "fork-identity": {
    heading: "Fork identity (optional overrides)",
    kind: "optional",
  },
  "contact-agents": { heading: "Contact research agent", kind: "optional" },
  trajectory: { heading: "Artist trajectory promotion", kind: "optional" },
  spotify: { heading: "Spotify OAuth", kind: "optional" },
  statsfm: { heading: "Stats.fm Plus", kind: "optional" },
  edmtrain: { heading: "EDMTrain", kind: "optional" },
  resend: { heading: "Resend (transactional email)", kind: "optional" },
  "send-behavior": { heading: "Send-time behavior", kind: "optional" },
  "google-sheets": {
    heading: "Google Sheets (optional one-way contact export)",
    kind: "optional",
  },
};

export interface EnvVarDefinition {
  readonly key: string;
  readonly group: EnvVarGroup;
  /** Never print this value; only report whether it is set/valid. */
  readonly secret: boolean;
  readonly summary: string;
  /** Extra `# `-prefixed comment lines rendered above the variable. */
  readonly notes?: readonly string[];
  /** Exact default placed in the generated `.env.example`. */
  readonly defaultValue: string;
}

export const ENV_SCHEMA: readonly EnvVarDefinition[] = [
  {
    key: "DATABASE_URL",
    group: "database",
    secret: true,
    summary: "Pooled Postgres connection string used at runtime.",
    notes: [
      "Pooled connection used at runtime. Direct connection used by Prisma",
      "migrate (skip the pooler so DDL works). See https://www.prisma.io/docs/orm/overview/databases/postgresql",
    ],
    defaultValue: "******host:6543/postgres?pgbouncer=true&connection_limit=1",
  },
  {
    key: "DIRECT_URL",
    group: "database",
    secret: true,
    summary: "Direct (non-pooled) Postgres connection string for migrations.",
    defaultValue: "******host:5432/postgres",
  },
  {
    key: "APP_BASE_URL",
    group: "app",
    secret: false,
    summary: "Public base URL this deployment is served from.",
    defaultValue: "http://127.0.0.1:3000",
  },
  {
    key: "ADMIN_PASSWORD",
    group: "app",
    secret: true,
    summary: "Admin login password. Protected mode requires both this and ADMIN_SESSION_SECRET.",
    notes: [
      "Protected mode requires both values. Production fails closed if either is blank.",
    ],
    defaultValue: "",
  },
  {
    key: "READ_ONLY_PASSWORD",
    group: "app",
    secret: true,
    summary: "Optional second password for a signed read-only session.",
    notes: [
      "Optional second password for a signed read-only session. It must differ from",
      "ADMIN_PASSWORD. Read-only sessions can view every page but cannot save,",
      "sync, queue, schedule, send, or mutate integrations.",
    ],
    defaultValue: "",
  },
  {
    key: "ADMIN_SESSION_SECRET",
    group: "app",
    secret: true,
    summary: "Signs expiring admin session cookies.",
    notes: [
      "Signs expiring admin session cookies. Generate independently from the password",
      "(for example: openssl rand -base64 32). Rotating either value revokes sessions.",
    ],
    defaultValue: "",
  },
  {
    key: "ALLOW_INSECURE_OPEN_MODE",
    group: "app",
    secret: false,
    summary: "Explicit local-only escape hatch for running without authentication.",
    notes: [
      "Explicit local-only escape hatch for running without authentication.",
      "Set true only for local development; it is ignored when NODE_ENV=production.",
    ],
    defaultValue: "false",
  },
  {
    key: "CRON_SECRET",
    group: "app",
    secret: true,
    summary: "Shared secret Vercel Cron and GitHub Actions must present on /api/cron/*.",
    notes: [
      "****** Vercel Cron and GitHub Actions must present on /api/cron/*.",
      "Requests fail closed if blank.",
    ],
    defaultValue: "",
  },
  {
    key: "REPOSITORY_SLUG",
    group: "fork-identity",
    secret: false,
    summary: "Overrides the GitHub `owner/name` this deployment trusts and links to.",
    notes: [
      "Optional. Defaults to this deployment's own repository. Set to your fork's",
      "`owner/name` (e.g. \"your-org/your-fork\") to rebrand repository links and",
      "retarget the contact research/audit OIDC trust boundary below. Malformed",
      "values are rejected: the app fails closed rather than trusting an invalid repo.",
    ],
    defaultValue: "",
  },
  {
    key: "CONTACT_RESEARCH_WORKFLOW_REF",
    group: "fork-identity",
    secret: false,
    summary: "Overrides the exact workflow_ref trusted to run contact research via OIDC.",
    notes: [
      "Optional. Defaults to `<REPOSITORY_SLUG>/.github/workflows/contact-research.yml@refs/heads/main`.",
      "Must reference a `.yml`/`.yaml` file under that repository's `.github/workflows/`",
      "on `refs/heads/main`; malformed values are rejected (fail closed).",
    ],
    defaultValue: "",
  },
  {
    key: "CONTACT_AUDIT_WORKFLOW_REF",
    group: "fork-identity",
    secret: false,
    summary: "Overrides the exact workflow_ref trusted to run contact audits via OIDC.",
    notes: [
      "Optional. Defaults to `<REPOSITORY_SLUG>/.github/workflows/contact-audit.yml@refs/heads/main`.",
      "Must reference a `.yml`/`.yaml` file under that repository's `.github/workflows/`",
      "on `refs/heads/main`; malformed values are rejected (fail closed).",
    ],
    defaultValue: "",
  },
  {
    key: "CONTACT_RESEARCH_AGENT_TOKEN",
    group: "contact-agents",
    secret: true,
    summary: "Optional dedicated token for local/development contact research workers.",
    notes: [
      "Optional dedicated token for local/development workers only. Production agent",
      "mutation endpoints ignore static tokens and accept only workflow-scoped",
      "GitHub Actions OIDC.",
    ],
    defaultValue: "",
  },
  {
    key: "CONTACT_RESEARCH_LIMIT",
    group: "contact-agents",
    secret: false,
    summary: "Optional local worker batch size (1-10, default 3).",
    defaultValue: "3",
  },
  {
    key: "CONTACT_AUDIT_AGENT_TOKEN",
    group: "contact-agents",
    secret: true,
    summary: "Optional dedicated token for running the review-only contact audit worker locally.",
    notes: [
      "Optional dedicated token for running the review-only contact audit worker",
      "locally/development only. Production ignores it and uses GitHub Actions OIDC.",
    ],
    defaultValue: "",
  },
  {
    key: "TRAJECTORY_INGEST_AUTH_MODE",
    group: "trajectory",
    secret: false,
    summary: "Trajectory ingest auth mode: oidc (preferred), hmac, or oidc-or-hmac.",
    notes: [
      "Preferred production mode is oidc. Set the exact producer repository and",
      "workflow identity; only workflow_dispatch from refs/heads/main is accepted.",
    ],
    defaultValue: "oidc",
  },
  {
    key: "TRAJECTORY_INGEST_GITHUB_REPOSITORY",
    group: "trajectory",
    secret: false,
    summary: "Exact producer repository (owner/name) trusted for trajectory ingest OIDC.",
    defaultValue: "",
  },
  {
    key: "TRAJECTORY_INGEST_GITHUB_WORKFLOW_REF",
    group: "trajectory",
    secret: false,
    summary: "Exact workflow_ref trusted for trajectory ingest OIDC.",
    defaultValue: "",
  },
  {
    key: "TRAJECTORY_INGEST_RECEIPT_SECRET",
    group: "trajectory",
    secret: true,
    summary: "Photo-admin-only signing key for short-lived successful dry-run receipts.",
    defaultValue: "",
  },
  {
    key: "TRAJECTORY_INGEST_HMAC_SECRET",
    group: "trajectory",
    secret: true,
    summary: "Dedicated fallback secret for an explicitly selected hmac or oidc-or-hmac mode.",
    notes: [
      "Dedicated fallback for an explicitly selected hmac or oidc-or-hmac mode.",
      "Never reuse ADMIN_PASSWORD, ADMIN_SESSION_SECRET, CRON_SECRET, or provider keys.",
      "Use a random value of at least 32 bytes.",
    ],
    defaultValue: "",
  },
  {
    key: "SPOTIFY_CLIENT_ID",
    group: "spotify",
    secret: true,
    summary: "Spotify OAuth app client ID.",
    notes: [
      "Create an app at https://developer.spotify.com/dashboard",
      "Redirect URI must match exactly. Spotify rejects http://localhost; use 127.0.0.1.",
      "Registered redirect URI: ${APP_BASE_URL}/api/spotify/callback",
    ],
    defaultValue: "",
  },
  {
    key: "SPOTIFY_CLIENT_SECRET",
    group: "spotify",
    secret: true,
    summary: "Spotify OAuth app client secret.",
    defaultValue: "",
  },
  {
    key: "STATSFM_TOKEN",
    group: "statsfm",
    secret: true,
    summary: "Stats.fm session token (no public API).",
    notes: [
      "No public API. Grab the session token from stats.fm after logging in",
      "(DevTools → Application → Local Storage → \"token\", or an Authorization header).",
    ],
    defaultValue: "",
  },
  {
    key: "EDMTRAIN_API_KEY",
    group: "edmtrain",
    secret: true,
    summary: "EDMTrain API key.",
    notes: ["Request a key at https://edmtrain.com/api"],
    defaultValue: "",
  },
  {
    key: "RESEND_API_KEY",
    group: "resend",
    secret: true,
    summary: "Resend API key. Sending domain must be verified.",
    notes: [
      "Key from https://resend.com/api-keys. Sending domain must be verified.",
    ],
    defaultValue: "",
  },
  {
    key: "RESEND_FROM_EMAIL",
    group: "resend",
    secret: false,
    summary: "Sender address or \"Name <address>\" used for outgoing email.",
    notes: ["Use either you@yourdomain.com or Name <you@yourdomain.com>."],
    defaultValue: "you@yourdomain.com",
  },
  {
    key: "RESEND_WEBHOOK_SECRET",
    group: "resend",
    secret: true,
    summary: "Resend webhook signing secret (whsec_...).",
    notes: [
      "Webhook signing secret (whsec_...) from Resend → Webhooks. Required when the",
      "webhook is enabled; /api/resend/webhook fails closed if it is blank.",
    ],
    defaultValue: "",
  },
  {
    key: "SEND_TEST_OVERRIDE",
    group: "send-behavior",
    secret: false,
    summary: "Legacy env-based test override for redirecting sends.",
    notes: [
      "Legacy env-based test override. The Settings → General UI also exposes",
      "this and wins over the env when set (including explicit empty).",
    ],
    defaultValue: "",
  },
  {
    key: "GOOGLE_CREDENTIALS_JSON",
    group: "google-sheets",
    secret: true,
    summary: "Raw service-account JSON credentials (preferred on Vercel).",
    notes: [
      "Service account credentials. Provide ONE of:",
      "  GOOGLE_CREDENTIALS_JSON — raw JSON contents (preferred on Vercel)",
      "  GOOGLE_CREDENTIALS_PATH — path to the JSON key file on disk",
      "Share the destination spreadsheet with the service account as an Editor.",
      "Exports create immutable timestamped tabs and never import data into Postgres.",
    ],
    defaultValue: "",
  },
  {
    key: "GOOGLE_CREDENTIALS_PATH",
    group: "google-sheets",
    secret: false,
    summary: "Path to the service-account JSON key file on disk (alternative to the JSON var).",
    defaultValue: "",
  },
  {
    key: "GOOGLE_CONTACT_EXPORT_SPREADSHEET_ID",
    group: "google-sheets",
    secret: false,
    summary: "Destination spreadsheet ID for one-way contact exports.",
    defaultValue: "",
  },
];

export const ENV_VAR_GROUP_ORDER: readonly EnvVarGroup[] = [
  "database",
  "app",
  "fork-identity",
  "contact-agents",
  "trajectory",
  "spotify",
  "statsfm",
  "edmtrain",
  "resend",
  "send-behavior",
  "google-sheets",
];

export function envVarDefinition(key: string): EnvVarDefinition | undefined {
  return ENV_SCHEMA.find((entry) => entry.key === key);
}

export function envVarsByGroup(group: EnvVarGroup): EnvVarDefinition[] {
  return ENV_SCHEMA.filter((entry) => entry.group === group);
}
