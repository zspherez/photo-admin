# photo-admin

A personal admin tool for a concert/festival photographer: ingest upcoming
shows, score them against what I actually listen to, manage artist team
contacts, and send templated outreach emails — all from a single Next.js app.

This is built around my own workflow (EDMTrain for shows, Spotify + Stats.fm
for listening signals, Resend for sending). It's not a generic product, but the
code is hopefully readable enough to fork.

## What's in here

- **`/dashboard`** — ranked list of upcoming shows for artists I listen to, with
  per-contact send/preview/customize actions.
- **`/research`** — evidence-backed contact candidates proposed by a local
  Copilot agent and held for approval.
- **`/contact-audit`** — review-only verification history for active manager
  contacts, including sources and plausible alternatives.
- **`/shows`, `/festivals`, `/artists`, `/outreach`** — listing/detail views.
- **`/settings`** — general config, Spotify connect, Stats.fm token, email
  template editor, contact import.
- **`/api/cron/sync-shows`, `/api/cron/sync-listens`,
  `/api/cron/contact-research`, `/api/cron/refresh-top-playlist`,
  `/api/cron/send-scheduled`** —
  authenticated scheduled jobs split between Vercel Cron and GitHub Actions.
- **`/api/resend/webhook`** — receives delivery/bounce/open events from Resend.

## Stack

- Next.js 16 (App Router), React 19
- Postgres + Prisma 6
- TailwindCSS 4
- Resend (transactional email)
- Vercel (hosting + daily cron), GitHub Actions (scheduled production jobs)

## Prerequisites

- Node.js 22.x (the project runtime; it supports the quoted native test glob
  and satisfies Next.js 16.2.6)
- A Postgres database (Supabase, Neon, etc. — anything Prisma can talk to)
- Accounts/API keys for the integrations you want to use (see below)

## Setup

```bash
git clone <this repo>
cd photo-admin
cp .env.example .env
# Fill in DATABASE_URL and DIRECT_URL before installing. Prisma generation
# runs during npm install. Also choose protected auth or explicit local open mode.
npm install
npm run db:setup
npm run dev
```

`npm install` runs `prisma generate` through `postinstall`. `db:setup`
regenerates the client, applies committed migrations, and runs the idempotent
Unicode normalized-name backfill against the database named in `.env`; it is
intentionally separate from generic builds.

CI must likewise provide `DATABASE_URL` and `DIRECT_URL` before a normal
`npm ci`. Jobs that do not use Prisma can run `npm ci --ignore-scripts`; jobs
that do should run `npm run db:generate` explicitly after supplying datasource
variables.

App is at <http://127.0.0.1:3000>. Protected mode requires both
`ADMIN_PASSWORD` and `ADMIN_SESSION_SECRET`. To deliberately run without a
login during local development, leave `ADMIN_PASSWORD` blank and set
`ALLOW_INSECURE_OPEN_MODE=true`; that flag is ignored in production.

After first boot, visit **Settings → General** to fill in your name, email,
phone, city, and portfolio URL — these are substituted into the default email
template (see below).

EDMTrain eligibility is geography-based, not venue-name-based. Regular shows
must resolve inside NYC; unknown geography fails closed. Festivals outside NYC
remain eligible at least seven calendar days before the event, while past or
near-term non-NYC/unknown festivals are non-actionable. The venue-blocklist
removal migration deletes its obsolete setting and reclassifies legacy
EDMTrain `blocked` rows from cached geography and those same festival rules.

## Required vs optional env

The full list is in `.env.example`. Minimum to boot:

| Var | Required? | What it does |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection (pooled — runtime queries) |
| `DIRECT_URL` | yes | Postgres connection (direct — Prisma migrate) |
| `APP_BASE_URL` | yes | Used in OAuth redirects, etc. |
| `ADMIN_PASSWORD` | production/protected mode | Gates the app behind a login. Production fails closed when it is missing. |
| `ADMIN_SESSION_SECRET` | production/protected mode | Signs expiring admin session cookies. Generate it independently from the password, for example with `openssl rand -base64 32`. Rotating either value revokes existing sessions. |
| `ALLOW_INSECURE_OPEN_MODE` | local open mode only | Set exactly `true` to opt into no-auth local development when `ADMIN_PASSWORD` is blank. It is ignored when `NODE_ENV=production`. |
| `RESEND_API_KEY` | for sending | Get one at <https://resend.com/api-keys>. The sending domain must be verified. |
| `RESEND_FROM_EMAIL` | for sending | The verified `From:` sender, as `you@example.com` or `Name <you@example.com>`. Malformed values are rejected before a provider attempt is created. |
| `RESEND_WEBHOOK_SECRET` | for webhooks | `whsec_...` from Resend → Webhooks. The webhook route fails closed when this is blank. |
| `CRON_SECRET` | for scheduled jobs | Bearer token Vercel Cron and the scheduled GitHub Actions workflow present on `/api/cron/*`. Cron routes fail closed when this is blank. |
| `CONTACT_RESEARCH_AGENT_TOKEN` | optional local contact research | Dedicated bearer token for an explicitly configured local/development worker. Production agent mutation endpoints ignore it and require workflow-scoped GitHub Actions OIDC. |
| `CONTACT_AUDIT_AGENT_TOKEN` | optional local contact audit | Dedicated bearer token for an explicitly configured local/development audit worker. Production agent mutation endpoints ignore it and require workflow-scoped GitHub Actions OIDC. |
| `EDMTRAIN_API_KEY` | for show sync | Request a key at <https://edmtrain.com/api>. |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | for Spotify | Create an app at <https://developer.spotify.com/dashboard>. Redirect URI is `${APP_BASE_URL}/api/spotify/callback`. Spotify rejects `http://localhost`, so use `http://127.0.0.1:3000` locally. |
| `STATSFM_TOKEN` | for Stats.fm | No public API — grab a session token from DevTools (Application → Local Storage → `token`) after logging into stats.fm. |
| `GOOGLE_CREDENTIALS_JSON` / `GOOGLE_CREDENTIALS_PATH` | for Sheet sync and release adoption | Service-account credentials for Google Sheets contact sync. Configure `GOOGLE_CREDENTIALS_JSON` independently in Vercel Production and as the protected GitHub release secret. |
| `SPREADSHEET_ID` | initial Sheet setup | Fallback spreadsheet used until a successful sync stores the configured spreadsheet and tab in the database. |
| `SHEETS_SPREADSHEET_ID` / `SHEETS_TAB` | first protected Sheet cutover | Explicit target accepted by `db:adopt-sheet-contacts`. Set both as protected GitHub `production` environment variables or secrets when production database settings do not yet exist. These do not override the running app. |
| `SHEETS_TARGET_CHANGE_CONFIRMATION` | direct adoption-script target replacement only | Set exactly `CONFIRM` for an intentional direct `db:adopt-sheet-contacts` target replacement. The protected workflow uses its one-run `sheet_target_change_confirmation` dispatch input instead of a persistent flag. |
| `SEND_TEST_OVERRIDE` | optional | Reroutes every outbound send to this address (subject prefixed with `[TEST → original]`). The Settings UI also exposes this and wins over the env value. |

### Google Sheets contact sync is writable

Contact sync is not read-only. It creates the `photo_admin_id` header when
missing and fills stable IDs into contact rows so later syncs can reconcile
renames, email changes, and deletions. The service account therefore needs
**Editor** access to the target sheet. Back up a sheet before the first sync if
it is maintained by another system.

A successful sync from **Settings → Contacts** stores both
`sheets_spreadsheet_id` and `sheets_tab` in the database. The protected
production release adopts and verifies contacts against that exact target.
For the first cutover, protected `SHEETS_SPREADSHEET_ID` and `SHEETS_TAB`
bootstrap variables are authoritative. Before pausing, the release service
account authenticates and reads the target header, which must include
`artist`/`artist name` and `email`. If an override differs from an existing database target, the release also
requires the operator to enter `CONFIRM` in the workflow's
`sheet_target_change_confirmation` input for that run.

The target settings are changed only in the same successful database
transaction that completes contact reconciliation and verification. Sheet
ownership keys include both spreadsheet ID and tab, so equal tab names in
different spreadsheets cannot collide. Existing tab-only keys are adopted
into the spreadsheet-scoped format when the stored target is unchanged. On an
intentional target switch, matching contacts transfer to explicit new-target
keys; unmatched old-target contacts are upgraded to explicit old-target keys
and quarantined rather than deleted.
If the overrides are absent, both existing database settings must already be
complete. `SPREADSHEET_ID` is only the interactive setup fallback and is never
a protected-release bootstrap.

## Contact research agent

The hosted app automatically queues every non-festival artist with a show in
the upcoming 90-day NYC window and no active email contact. Contact roles are
treated as legacy metadata because this app stores manager contacts only.
Listening signals,
popularity, interest, and show proximity affect priority but no longer exclude
artists. Festival pages can explicitly queue every matched lineup artist who
still needs a manager. The repository custom agent submits candidates to
`/research`; it cannot approve contacts or send email.

The default automation is `.github/workflows/contact-research.yml`. Every hour
it calls a lightweight authenticated preflight. Empty queues stop before
checkout, dependency installation, or any Copilot request. When work exists,
GitHub Actions runs Copilot CLI with a three-artist batch. The custom agent's
per-artist research limit and the workflow's 45-minute timeout bound each run.
Scheduled runs are enabled when the workflow reaches the default branch.

Configure the repository Actions secret `APP_BASE_URL`. Hosted research uses a
short-lived GitHub Actions OIDC token pinned to this repository, main branch,
workflow file, scheduled/manual event, and the
`photo-admin-contact-research` audience; no shared app bearer or Copilot PAT is
needed. Copilot CLI
authenticates separately with the workflow's short-lived `GITHUB_TOKEN`. For
organization repositories, enable **Allow use of Copilot CLI billed to the
organization** and keep the workflow's `copilot-requests: write` and
`id-token: write` permissions.

The same worker can still be run locally:

```bash
export APP_BASE_URL="https://your-photo-admin.example"
export CONTACT_RESEARCH_AGENT_TOKEN="..."
export CONTACT_RESEARCH_LIMIT=3
npm run contact-research:agent
```

The worker accepts manager/management contacts only. It checks artist websites,
Instagram, Facebook, SoundCloud, linked Linktrees, and manager-focused Google
searches before using Booking Agent Info solely to identify a manager. It then
uses public company-domain patterns as a bounded Hunter-style fallback. Its
narrow localhost broker provides keyless public search and fixed-host page
reading while keeping queue credentials out of the agent's process.

A blurred or paywalled Booking Agent Info manager email is treated as a lead,
not an automatic exhausted result. The worker may use the visible manager
identity and company to independently infer the manager email from public
company addresses or use an official management-company inbox. It still never
submits the booking-agent or publicist contact.

This is automated **Copilot CLI on GitHub Actions**, not Copilot cloud agent.
A credential-isolated localhost broker provides queue calls plus bounded
read-only web research; private-network targets, oversized responses, and
unsafe redirects are blocked. Copilot autonomously chooses searches, follows
evidence, and submits results through the broker.
Copilot cloud agent currently does not map the custom-agent `web` alias, while
its default Playwright MCP can access only localhost.

The workflow uses a shared database queue rather than fixed per-run quotas.
Up to 10 Actions lanes each run four independent agents; every agent claims one
artist with `FOR UPDATE SKIP LOCKED`, writes the result immediately, then claims
another until the queue is empty. Each artist log ends with its AI-credit usage,
and the workflow summary reports total and average AIC per researched artist.

Each `/research` card also has persistent owner instructions. Explicit skip or
do-not-research notes cause the next worker to close the job without browsing.
When a manager/company is identified, the agent ranks matching emails from both
the active contact list and non-rejected prior research candidates by manager
name, email local-part, company, domain, and stored evidence before falling back
to a generic inbox.

## Existing contact audit

Open **Audit** in the app and choose **Queue full contact audit**. The request
is stored durably and the GitHub Actions workflow polls every 10 minutes, so
startup can take up to roughly one polling interval. Repeated clicks keep the
same pending or running request. One requested audit snapshots every active
contact exactly once, then Copilot verifies each snapshot against current
public artist and management sources. Results are stored separately from
contacts as `current`, `changed`, `stale`, `ambiguous`, or `unverified`, with
source URLs, reasoning, confidence, verification time, and evidence-backed
manager alternatives.

The audit is strictly review-only: neither the workflow nor its API can edit,
replace, approve, or deactivate a contact. The review surface links to the
normal contact editor only after showing the saved evidence. The agent retains
the manager-only policy, excludes booking/publicist contacts, and never
bypasses credentials, paywalls, robots restrictions, or CAPTCHAs.

The workflow is `.github/workflows/contact-audit.yml`. Its 10-minute schedule
is a lightweight no-op unless an explicit app request is pending or a requested
run needs recovery; it exits before checkout, dependency installation, or
Copilot use when idle. `workflow_dispatch` remains available for diagnostics
and recovery, but it also requires an app request and does not create audits on
its own. Configure the same `APP_BASE_URL` Actions secret used by contact
research. Hosted workers authenticate to the app with a short-lived OIDC token
pinned to this repository, main branch, exact workflow file, audience, and
either the scheduled or manual-dispatch event.

In production, the research `prepare`, `claim`, `known-contacts`, and `result`
routes and the audit `prepare`, `claim`, `known-contacts`, `attempt`, and
`result` routes accept only those workflow-specific OIDC tokens. `CRON_SECRET`
is reserved for `/api/cron/*` and release runtime verification; it is never an
agent claim or result credential. Dedicated `CONTACT_*_AGENT_TOKEN` values are
local/development-only and must be configured explicitly.

The page shows pending, running, completed, and failure/retry metadata. Failed
worker attempts release their claims and keep the same request and audit run
queued, so the next poll resumes the existing snapshot. After completion, the
button can create a new request. This queue is independent of the manager
research queue.

Deploying the request queue while a legacy contact audit is already running
adopts that existing run into the request lifecycle. Its run ID, snapshot jobs,
active claims, and GitHub workflow continue unchanged; neither the migration
nor the first scheduled poll creates a second snapshot or cancels the active
workflow.

For a local audit worker:

```bash
export APP_BASE_URL="https://your-photo-admin.example"
export CONTACT_AUDIT_AGENT_TOKEN="..."
npm run contact-audit:agent
```

## Email templates

Normal-show and festival outreach have distinct editable templates defined in
`lib/template.ts`. They are provisioned idempotently and selected from the
show's `isFestival` value before an immutable outreach snapshot is created.
Follow-ups remain a separate template. The templates reference these variables,
populated from **Settings → General** or the Contact/Show rows:

- `{{artist}}`, `{{venue}}`, `{{date}}`, `{{manager_name}}`
- `{{sender_name}}`, `{{sender_email}}`, `{{sender_phone}}`, `{{sender_city}}`,
  `{{portfolio_url}}`
- Festival outreach also supports `{{festival_name}}` (event name, falling back
  to venue), `{{location}}` (city/region, with a venue fallback), and
  `{{location_clause}}` (a safe optional ` in …`/` at …` phrase for natural
  punctuation).

Edit and preview each template independently at **Settings → Email template**.
"Reset to default" restores the selected normal or festival seed; follow-up
reset copies the current normal-show template. Existing saved normal templates
are preserved. Legacy rate placeholders are stripped when templates are loaded,
saved, previewed, or rendered, and unchanged legacy seeds are upgraded
automatically. Existing contact custom-price data and the legacy default-rate
setting remain stored for Sheet and database compatibility, but outreach email
templates no longer use them. Pending legacy scheduled snapshots are normalized
before their first provider attempt; an existing immutable provider request
that still contains legacy pricing is blocked for manual review instead of
being retried.

## Deploying to Vercel

Production releases are intentionally not driven by a normal push to `main`.
`vercel.json` uses Vercel's
[`git.deploymentEnabled`](https://vercel.com/docs/project-configuration/git-configuration#git.deploymentenabled)
setting to disable Git deployments for `main`, while leaving branch/PR preview
deployments enabled.

### One-time Vercel setup

1. Import the repository and set the Vercel project's **Production Branch** to
   `main`. The production-branch choice is a dashboard setting and cannot be
   enforced by this repository.
2. Scope production `DATABASE_URL` and `DIRECT_URL` to **Production** only.
   Scope **different database credentials** to **Preview**. Never expose the
   production database to Preview; preview builds do not run migrations.
3. Add the other production and preview environment variables from
   `.env.example` with the same care. In particular, set `CRON_SECRET` in
   Production so Vercel Cron can authenticate.
4. For Resend webhooks, point
   `https://<your-domain>/api/resend/webhook` at the Resend dashboard and set
   `RESEND_WEBHOOK_SECRET`.

Apply schema changes to the preview database separately when a preview needs
them. `npm run build` only generates Prisma Client and builds Next.js; it never
runs `prisma migrate deploy`.

### Protected production releases

Create two [GitHub environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
under **Settings → Environments**. These settings are a required one-time
repository configuration; the workflow file cannot enforce an environment's
deployment branch policy.

Configure **`production`** as follows:

- Require a reviewer, enable **Prevent self-review**, disable protection-rule
  bypass if your GitHub plan supports it, then choose **Selected branches and
  tags** and add only the branch rule `main` (no tag rule).
- Add environment secrets `VERCEL_TOKEN`, `VERCEL_ORG_ID`,
  `VERCEL_PROJECT_ID`, `DATABASE_URL`, `DIRECT_URL`, `APP_BASE_URL`, and
  `CRON_SECRET`. Also add `GOOGLE_CREDENTIALS_JSON`; the protected release
  requires the raw service-account JSON explicitly and never relies on a
  pulled Vercel placeholder.
- `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` come from the linked Vercel project.
  Scope `VERCEL_TOKEN` to the owning Vercel team/project; it must be able to
  pull/build/deploy/promote, access protected staged deployments through
  `vercel curl`, and call the project pause/unpause APIs.
- The GitHub `DATABASE_URL` and `DIRECT_URL` secrets must identify the same
  production database used by Vercel. Vercel sensitive environment variables
  are write-only, so the workflow does not compare their pulled placeholder
  values. It hashes every `migration.sql` in the requested checkout and
  requires production's
  successfully applied migrations to be the exact ordered checksum-valid
  prefix. Database-only migrations, modified checksums, unresolved migration
  attempts, and a revision older than production all fail before pausing.
  Each database connection verification writes a fresh random nonce through
  `DATABASE_URL`, observes and deletes it through `DIRECT_URL`, and observes
  the deletion through `DATABASE_URL`.
- After exact-SHA staging, the workflow writes a separate unpredictable,
  ten-minute marker through the protected GitHub database connections. It
  then uses authenticated `vercel curl` against only the staged deployment's
  fixed `/api/release/runtime-verification` route. That route performs a
  constant-time `CRON_SECRET` check, verifies the configured `APP_BASE_URL`,
  reads only the fixed `Setting` key, rejects malformed/expired/wrong-SHA
  markers, and returns no database URL or secret. The returned nonce must
  match and is conditionally deleted before pause. A different staged runtime
  database, APP base URL, or cron secret therefore stops the release before
  pause or migration. The staged request uses authenticated `vercel curl`,
  avoiding asynchronous project-level bypass propagation.
- `APP_BASE_URL` must be the production HTTPS origin with no path, query, or
  fragment. `CRON_SECRET` must be a header-safe bearer secret. Their staged
  runtime values are proved operationally by the authenticated marker request,
  without printing either value.
- For the first Sheet cutover, add both `SHEETS_SPREADSHEET_ID` and
  `SHEETS_TAB` as protected `production` environment variables (or secrets).
  If a name is configured as both a variable and secret, their values must
  match. These one-time overrides can be removed after a successful release
  has verified the same values in `sheets_spreadsheet_id` and `sheets_tab`.
  Later releases can use the current production database settings instead. To
  intentionally replace an existing target, enter `CONFIRM` in the workflow's
  `sheet_target_change_confirmation` input for that release. A persistent
  environment flag cannot authorize a switch.
- Configure the same service account as `GOOGLE_CREDENTIALS_JSON` in both the
  Vercel **Production** environment (runtime sync) and the GitHub
  **`production`** environment secret (release preflight/adoption), then grant
  it Editor access to the configured Sheet. Vercel's write-only value cannot
  be pulled back into GitHub. `GOOGLE_CREDENTIALS_PATH` remains local-only for
  this release path.

Configure **`production-recovery`** separately:

- Do **not** configure required reviewers or a wait timer. This keeps one
  protected approval—the `production` job's approval—while allowing the
  watchdog to resume a safe target after that job exits.
- Under **Deployment branches and tags**, choose **Selected branches and
  tags**, add exactly the branch rule `main`, and add no tag rules. Do not use
  **No restriction** or **Protected branches only**.
- Add environment secrets `RECOVERY_VERCEL_TOKEN`,
  `RECOVERY_VERCEL_ORG_ID`, and `RECOVERY_VERCEL_PROJECT_ID` for the same
  Vercel project as `production`. The token must read deployments, promote an
  exact deployment, and unpause the project.
- Add the environment variable `RECOVERY_ENVIRONMENT_GUARD` with the exact
  value `production-recovery-main-only-v1`; do not define that variable at
  repository or organization scope.
- Delete every repository-level or other-environment copy of the three
  `RECOVERY_VERCEL_*` secrets, and delete any repository/organization copy of
  `RECOVERY_ENVIRONMENT_GUARD`. Environment fallback cannot prove where a value
  came from, so leaving broader copies would recreate the feature branch
  exposure.

On trusted `main`, the recovery preflight fails visibly when the guard or
credentials are absent, the identifiers are malformed, the token cannot read
the configured Vercel project, or the recovery project fingerprint differs
from `production`; this also catches GitHub auto-creating an empty environment
because the named environment was missing. GitHub does not expose the
effective environment branch policy to a normal workflow context, so the exact
`main`-only setting above must still be verified in repository Settings. It is
the security boundary against a feature branch that modifies this workflow.

To release, push the revision to `main`, open
**Actions → Release production → Run workflow**, select `main` in **Use
workflow from**, enter the full 40-character target commit SHA, and type
`RELEASE`. The serialized workflow:

1. rejects every repository/ref/workflow identity except
   `zspherez/photo-admin` at `refs/heads/main`, checks out trusted `main`
   without persisted credentials, and proves that both the workflow SHA and
   requested exact commit are in that main history;
2. enters `production-recovery` without review, validates its guard,
   credentials, project access, and project fingerprint, but checks out and
   executes no repository code;
3. enters the single reviewer-protected `production` job, checks out only the
   previously validated main commit, then generates Prisma Client and runs
   tests, TypeScript checks, and lint;
4. pulls only the Vercel project settings needed by the CLI, validates every
   required protected GitHub secret without printing it, verifies the
   requested migration checksum prefix, and proves both GitHub database URLs
   with a fresh write/read/delete nonce;
5. authenticates to Google Sheets, reads spreadsheet structure plus the exact
   tab header, and rejects missing access, partial configuration, invalid
   columns, or an override change without the one-run `CONFIRM` input;
6. builds the exact checkout and deploys it with
   `vercel deploy --prebuilt --prod --skip-domain`. This is a Production-env
   artifact, not a Preview deployment, but it receives no production alias.
   Its project, Production target, `releaseCommit` metadata, and READY state
   are verified with the protected token; the dedicated recovery preflight has
   already proved access to the same fingerprinted project. Before recovery is
   armed, a fresh expiring marker is written through the GitHub runtime/direct
   connections and must be returned by the authenticated fixed route on this
   exact staged deployment. This simultaneously proves the staged runtime
   database, `APP_BASE_URL`, and `CRON_SECRET`; the marker is deleted before
   continuing;
7. reads the verified pending-migration count. Code-only releases skip the
   maintenance window entirely; schema releases arm recovery, pause the
   project, and wait six minutes—longer than this app's reviewed five-minute
   route ceiling—so old requests and outreach claims drain;
8. for schema releases only, marks schema cutover started, applies the reviewed
   expand/bridge migrations, and runs the exact revision's idempotent
   normalized-name backfill;
9. requires all requested migrations to be applied with their original
   checksums, repeats the fresh cross-connection nonce proof, and executes
   exact-target Prisma queries across every new schema surface;
10. promotes only the already-verified artifact and re-verifies that exact
   deployment. The workflow never builds after the database cutover;
11. while production is still paused and the new target is already promoted,
   runs `db:adopt-sheet-contacts`. Existing contacts stayed active during the
   expand migration. The new code atomically reconciles the new target,
   migrates spreadsheet-scoped ownership, adopts exact legacy matches, then
   quarantines unresolved legacy/old-target ownership. A failed transaction
   leaves the prior target and contacts unchanged;
12. verifies the stored Sheet target, absence of active unowned Sheet contacts,
    exact migration history, fresh database nonce, and new-code schema queries,
    then idempotently unpauses. Normal independent schedules handle show sync,
    listen sync, contact-research queue refresh, and top-playlist refresh;
13. on any earlier failure, an `if: always()` step uses the already-approved
    production credentials, while the independent watchdog uses only
    `production-recovery` credentials and inline recovery logic—never a
    checked-out helper. Each unconditional recovery path independently
    recomputes the configured organization/project fingerprint, compares it
    with the sealed preflight fingerprint, and authenticates project access
    before inspecting a deployment or promoting, pausing, or unpausing.
    Failure to validate performs no production operation. A pre-schema failure
    may unpause the old compatible target. Once schema work starts, cleanup
    promotes/resumes only when the exact migration set, staged target,
    configured Sheet adoption, and spreadsheet-scoped ownership were verified;
    otherwise it deliberately leaves production paused with an error. GitHub
    may suppress jobs on a whole-workflow cancellation, so missing state also
    fails visibly instead of guessing.

The watchdog has a 60-minute job timeout with explicit stage bounds: 1 minute
for its trusted-context gate, 5 for Node setup, 1 for credential validation,
10 for the promotion CLI install, and 30 for recovery. Recovery's network
worst case is 22 minutes 50 seconds: sealed-project authentication is one
60-second request, each of two exact-deployment verification
loops is 6 × 60-second requests plus five 10-second delays (6 minutes 50
seconds), exact promotion is capped at 5 minutes, and idempotent unpause is 3 ×
60-second requests plus two 5-second delays (3 minutes 10 seconds). Thus the
recovery step retains 7 minutes 10 seconds after its complete network budget,
and the job retains 13 minutes after all sequential stage bounds. The install
and recovery steps use `always()` after the trusted-context gate so an earlier
operational failure remains visible without consuming the reserved recovery
opportunity.

Recovery inputs cannot select code or a command: the watchdog checks out
nothing, accepts the independently validated main SHA rather than the raw
dispatch input, rejects any other release-output SHA, permits only a strict
`*.vercel.app` deployment URL, and re-verifies project, Production target,
`releaseCommit`, and READY state before and after exact promotion. Repository
identity, `refs/heads/main`, and the trusted workflow ref are reasserted before
the recovery secrets are mapped into a step.

For this normalization and contact-adoption cutover, running
`prisma migrate deploy` directly in production without immediately running the
same revision's normalized-name backfill and configured Sheet adoption is
unsupported. Use the protected release for production. For non-production
databases, use `npm run db:setup`, or run `db:migrate:deploy` followed by
`db:backfill:normalized-artists` from the same checkout; run
`db:adopt-sheet-contacts` separately only when that database has a configured
Sheet target.

This follows Vercel's documented
[`vercel build` + `--prebuilt`](https://vercel.com/docs/cli/build),
[staged production promotion](https://vercel.com/docs/deployments/promoting-a-deployment#staging-and-promoting-a-production-deployment),
and [project pause/unpause](https://vercel.com/docs/projects/managing-projects#pausing-a-project)
mechanisms. The release, playlist-refresh, scheduled-outreach, and
token-rotation workflows use separate durable concurrency groups. A long
release therefore cannot occupy GitHub's single pending slot and replace an
unrelated scheduled run.

The cutover invariant is: **old code may resume only before schema cutover;
after schema cutover, only the exact staged SHA may resume**. `schema_started`
is armed before `prisma migrate deploy`; `schema_ready` is recorded only after
the exact requested history and new-code compatibility probes succeed, while
`ownership_ready` is recorded only after configured Sheet adoption and
spreadsheet-scoped ownership verification succeed.
Recovery with `schema_started=true` and `schema_ready=false` leaves the project
paused. Recovery after schema cutover also leaves production paused unless
`ownership_ready=true`; only then does it verify/promote the staged SHA before
unpausing. Promotion is never rolled back to the old deployment.

For recovery, inspect the failed step and watchdog log before changing project
state. If the watchdog intentionally left production paused, correct the
database migration/backfill or target compatibility failure and rerun the same
exact SHA; do not manually restore the old deployment after `schema_started`.
Keep both Sheet overrides when bootstrapping, and use the workflow's one-run
`CONFIRM` input only for an intentional replacement. Migration deploy,
backfill, exact deployment promotion, Sheet reconciliation, and pause/unpause
are idempotent. A whole-workflow cancellation or recovery API failure can still
require manual action, but the safe default is paused and visible.

### Scheduled jobs

All cron expressions use UTC. Vercel Hobby cron jobs can run only
[once per day and have per-hour timing precision](https://vercel.com/docs/cron-jobs/usage-and-pricing),
so the frequent outreach dispatcher runs in GitHub Actions instead.

| Route / workflow | Schedule | Purpose |
|---|---|---|
| Vercel `/api/cron/sync-shows` | Daily at 09:00 UTC | Import upcoming shows and festivals. |
| Vercel `/api/cron/sync-listens` | Daily at 11:00 UTC | Refresh listening and contact data. |
| GitHub Action `/api/cron/refresh-top-playlist` | Daily at 12:30 UTC | Refresh the top-tracks playlist after listening sync. |
| Vercel `/api/cron/contact-research` | Daily at 13:00 UTC | Queue actionable artists that still need a manager contact. |
| GitHub Action manager research | Hourly at minute 23 | Refresh and self-drain the full upcoming-show queue using up to 10 lanes with four independent agents each. Every artist result is written immediately. |
| GitHub Action `/api/cron/send-scheduled` | Once each weekday at 09:00 America/New_York, plus exceptional recovery every four hours at minute 17 UTC | Dispatch morning outreach; separately recover retries, stale claims, and missed runs. |
| Stats.fm token rotation GitHub Action | Mondays, Thursdays, and Saturdays at 03:17 UTC | Refresh the short-lived token every 2–3 days, away from listen sync. |

The show and listen syncs have an empty Hobby scheduling hour between them.
The listen sync can start as late as 11:59 UTC and run for five minutes, so the
12:30 playlist refresh still has at least 25 minutes of separation. The
playlist route is bounded to three minutes before outreach begins at 13:00.
Release, playlist refresh, manager research, outreach, and token rotation each
serialize only with another run of the same operation, so unrelated workflows
cannot replace one another in GitHub's single pending concurrency slot.

The scheduled workflows require GitHub repository secrets under
**Settings → Secrets and variables → Actions**:

- `APP_BASE_URL` — the production origin, such as `https://photo.example.com`,
  with no path.
- `CRON_SECRET` — exactly the same secret configured in the production Vercel
  environment, for workflows that call `/api/cron/*`. Contact research and
  audit mutation routes do not accept it.
The manager-research and contact-audit workers refresh workflow-specific OIDC
tokens for queue API requests, so long-running work does not depend on one
expiring token.

The normal outreach cadence is one dispatch during the weekday
09:00-09:59 America/New_York window, intended to pick up outreach prepared the
previous night. GitHub schedules UTC candidates at 13:00 and 14:00; an
`America/New_York` time-zone gate selects exactly one, so the local window stays
correct across daylight-saving changes.

The minute-17 four-hour schedule is exceptional recovery, not normal outreach
polling. It immediately handles due provider retries and stale claims, while a
never-claimed scheduled row becomes recovery-eligible after it is two hours
overdue. Thus a delayed or failed morning cron cannot strand a send, while new
normal scheduled outreach is not swept up by frequent all-day polling. This
keeps retries well inside Resend's 24-hour idempotency retention. The workflow
concurrency group, the endpoint's Serializable atomic claims, immutable
recipient snapshots, suppression rechecks, and provider idempotency keys make
overlapping or duplicate invocations safe.

The playlist workflow retries transport failures and retryable HTTP responses
for up to 60 minutes. The outreach workflow uses a shorter 15-minute
maintenance window because the exceptional four-hour schedule keeps every retry
well inside Resend's 24-hour idempotency retention. Backoff starts at one
minute and is capped at five minutes; non-retryable responses such as
authentication failures fail immediately. Each failed attempt retains its
response body in the Actions log.

After a successful outreach response, the workflow also keeps polling within
that 15-minute bound when the endpoint reports a bounded backlog or a pending
automatic retry. It waits until the reported `nextRetryAt` for at most five
minutes per wait and performs at most eight response-aware follow-up polls per
run. Terminal per-row failures remain sticky across those polls and fail the
workflow even if a later response has no due rows; handled automatic retries
continue polling first. If only retryable work remains when a bound expires,
the run exits successfully with a warning and the exceptional recovery
schedule resumes recovery.

Each 60-second dispatcher request admits new rows only during its first 20
seconds. The remaining 40 seconds reserve the full 30-second provider
transaction timeout plus database and response margin. A stale `sending`
attempt is never resubmitted automatically: recovery quarantines it for manual
review because provider acceptance may already have occurred.

During maintenance, the active outreach run keeps retrying while the latest
same-workflow trigger remains pending. GitHub may coalesce older pending
outreach triggers, but no work item lives in a workflow payload: every
invocation scans the durable due-outreach queue, and atomic claims plus
provider idempotency make retries safe. The successful active and pending runs
therefore drain the accumulated backlog after production resumes.

Check **Actions → Dispatch scheduled outreach** for run status and logs; GitHub sends
failure notifications according to each repository user's notification
settings. After correcting a failure, use **Run workflow** there to dispatch
the due backlog manually.

For a playlist failure, first confirm the prerequisite listening sync
completed successfully, then use **Actions → Refresh top playlist → Run
workflow**. During a normal release pause, the current daily run survives and
retries instead of losing the refresh until the next day. The route's
integration lease, stable managed-playlist identity, and full item replacement
make repeated calls safe.

The Stats.fm rotation workflow requires the `SPOTIFY_SP_DC`,
`STATSFM_ROTATE_URL`, and `CRON_SECRET` GitHub Actions secrets. It keeps
`npm ci`, uses the lockfile-pinned Playwright version, retries rotation three
times, and fails the Actions run after the final attempt so repository
notifications surface the problem. Manual **Run workflow** dispatch remains
available.

## Scripts

```bash
npm run dev        # next dev
npm run build      # db:generate + next build (no database migrations)
npm run db:generate
npm run db:verify-targets   # exact migration prefix + fresh cross-connection nonce
npm run db:verify-release-compatibility
npm run db:migrate:deploy
npm run db:backfill:normalized-artists
npm run db:adopt-sheet-contacts
npm run db:setup   # generate + migrate + normalized-name backfill
npm test           # Node test runner with TypeScript support
npm run typecheck
npm run lint
npm run rotate:statsfm-token
npx tsx scripts/smoke.ts   # write-capable local/disposable-target integration check
```

### Safe tests and live smoke checks

`npm test` replaces inherited database URLs with unreachable localhost test
URLs, disables dotenv file loading for the test process, and clears agent/cron
credentials. This prevents an ignored `.env` or Vercel production environment
from silently connecting unit tests to production. The release workflow's
localhost dummy URLs remain compatible with this guard.

`scripts/smoke.ts` performs real integration writes. It always refuses Vercel
and production environments and production-identified database targets.
Loopback targets must use a test-named database. A remote disposable target
requires both `DESTRUCTIVE_TEST_DATABASE_CONFIRMATION` set for that one
invocation to `CONFIRM_NONLOCAL_DATABASE_TEST_WRITE` and a positive target
identity: exact comma-separated `TEST_DATABASE_ALLOWED_HOSTS` plus
`TEST_DATABASE_ALLOWED_DATABASES`, or an exact
`TEST_DATABASE_ALLOWED_SHA256` fingerprint generated by
`databaseTargetFingerprint`. Unknown remote targets are refused even with the
confirmation. These values must identify only a disposable database; they can
never override production-environment or production-identity refusal.

For a live production smoke check, use authenticated read-only pages or fixed
read-only endpoints. If database-level validation is unavoidable, wrap it in a
transaction that is always rolled back and verify the rollback. Never claim an
agent job or submit synthetic candidates, notes, evidence, exhausted/skipped
outcomes, or audit findings as a smoke test. Production agent API validation
should stop after proving an unauthorized request is rejected or should run
the real GitHub workflow against genuine queued work.

## Notes for forks

This was carved out of my workflow as a photographer — the default email
template, the EDMTrain-as-source-of-truth choice, the "score artist by recent
listens" approach all reflect that. The DB schema and the page layouts will
serve any "match upcoming events against your taste, then email someone about
it" pipeline, but expect to edit `lib/edmtrain.ts`, the listen-signal sources,
and the template to fit your domain.
