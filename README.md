# photo-admin

Private operations software for concert and festival photography outreach.

photo-admin brings upcoming shows, listening signals, artist recommendations,
manager-contact research, contact audits, templates, and email delivery into
one Next.js app. It is tailored to one photographer's workflow, not packaged as
a general-purpose SaaS product.

Research and recommendations never send outreach automatically. An operator
reviews contact changes and chooses when to queue or send email.

The app can also be installed as a network-only PWA. Private pages and
mutations are not cached offline; see [docs/mobile-pwa.md](docs/mobile-pwa.md).

## Main pages

| Page | Purpose |
|---|---|
| **Shows** (`/dashboard`) | Review matched and NYC shows; send, queue, or customize outreach. |
| **Recommendations** (`/recommendations`) | Review trajectory, momentum, exploration, and portfolio suggestions. |
| **Research** (`/research`) | Review manager candidates, exhausted searches, skips, and direct-outreach proposals. |
| **Audit** (`/contact-audit`) | Review an artist's stored roster, evidence, and proposed changes together. |
| **Emails** (`/emails`, `/outreach`) | Inspect show outreach, custom email, and delivery history. |
| **Contacts** (`/contacts`) | Browse stored artist contacts. |
| **Festivals** (`/festivals`) | Manage festival lineups and outreach. |
| **All shows / Sync** (`/shows`) | Inspect every synced show and run a manual sync. |
| **Settings** (`/settings`) | Configure identity, integrations, templates, contacts, agents, and queues. |

## Contact research and audit

Research finds public, evidence-backed artist-management contacts for artists
without an active email. Audits re-check active contacts against current public
artist and management sources.

Audit review is artist-level. For each artist, the operator may:

- **Append** a proposed contact while keeping the current roster.
- **Replace selected contacts** by adding the proposal and quarantining only
  the selected old contacts.
- **Deactivate selected stale contacts** without adding a replacement.
- **Reject** the proposal and leave the roster unchanged.

Replacement does not rewrite an existing identity. Quarantined contacts,
outreach history, decision records, and selected-contact snapshots are
preserved. Shared manager or management-company addresses remain valid when
they are new for the artist being audited.

Both contact research and contact audit poll every 10 minutes. Each poll first
checks its durable queue and cheaply no-ops when no work is queued. A durable,
idempotent full audit is also enqueued monthly; it waits behind any active
audit rather than losing or duplicating the request. Research eligibility
discovery refreshes hourly; the 10-minute poll only drains existing work.

Both agents are pinned to GPT-5.6 Sol (`gpt-5.6-sol`) with maximum reasoning
effort. They may use only public professional manager or management-company
sources. Booking, publicity, label, promoter, venue, and press contacts are
excluded. Agents do not bypass logins, paywalls, CAPTCHAs, robots restrictions,
or credentials, and their output remains review-only.

Production agent mutations use workflow-scoped GitHub Actions OIDC. Static
`CONTACT_RESEARCH_AGENT_TOKEN` and `CONTACT_AUDIT_AGENT_TOKEN` values are for
explicit local or development use only.

## View-only access

Set an optional, distinct `READ_ONLY_PASSWORD` to provide a second login.
Read-only users can navigate pages and use filters, but cannot save, sync,
queue, schedule, send, or connect integrations. Mutation checks are enforced
server-side through the signed HttpOnly session.

Email template previews are redacted for read-only users and replaced with
Lorem ipsum content rather than exposing stored outreach copy.

Interested people can reach out to the repository owner for a test view-only
login. No private contact details are published here.

## Local setup

Requirements:

- Node.js 22.x
- Postgres
- Credentials only for the integrations you intend to use

```bash
git clone <this repo>
cd photo-admin
cp .env.example .env

# Set DATABASE_URL and DIRECT_URL first.
npm install
npm run db:setup
npm run dev
```

Open <http://127.0.0.1:3000>.

Protected mode requires `ADMIN_PASSWORD` plus an independent
`ADMIN_SESSION_SECRET`. For explicit local-only open mode, leave
`ADMIN_PASSWORD` blank and set `ALLOW_INSECURE_OPEN_MODE=true`; production
ignores open mode. After first boot, configure sender and portfolio details in
**Settings -> General**, then connect the integrations you need.

## Essential environment groups

The complete reference is [.env.example](.env.example).

| Group | Essential variables |
|---|---|
| Core | `DATABASE_URL`, `DIRECT_URL`, `APP_BASE_URL`, `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`, optional `READ_ONLY_PASSWORD` |
| Email | `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RESEND_WEBHOOK_SECRET`, optional `SEND_TEST_OVERRIDE` |
| Shows/listening | `EDMTRAIN_API_KEY`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `STATSFM_TOKEN` |
| Google Sheets | `GOOGLE_CREDENTIALS_JSON` or `GOOGLE_CREDENTIALS_PATH`; `SPREADSHEET_ID`; `SHEETS_SPREADSHEET_ID`; `SHEETS_TAB` |
| Automation | `CRON_SECRET`; local-only contact agent tokens named above |
| Trajectory | `TRAJECTORY_INGEST_AUTH_MODE`, `TRAJECTORY_INGEST_GITHUB_REPOSITORY`, `TRAJECTORY_INGEST_GITHUB_WORKFLOW_REF`, `TRAJECTORY_INGEST_RECEIPT_SECRET`, and fallback-only `TRAJECTORY_INGEST_HMAC_SECRET` |

Sheet sync is writable and needs Editor access. Back up the Sheet before its
first writable sync.

## Production release safety

`.github/workflows/release-production.yml` accepts an exact full commit SHA
reachable from `main` plus `confirmation=RELEASE`. It tests, type-checks,
lints, builds, proves the staged runtime and database bindings, runs migrations
and Sheet adoption, promotes the deployment, and verifies compatibility.

The workflow pauses production only after the exact revision is staged and
proven. Its main-only watchdog can recover only a target already proven safe.
Use durable project-scoped Vercel CI tokens; temporary OAuth tokens expire.

Configure **`production-recovery`** separately:

- Do **not** configure required reviewers; recovery must not wait for a second
  approval after a failed reviewed release.
- Choose **Selected branches and tags**, allow only the branch rule `main`,
  and add no tag rules.
- Set `RECOVERY_ENVIRONMENT_GUARD=production-recovery-main-only-v1`.
- Keep only dedicated recovery Vercel project, organization, and token values
  there. Delete every repository-level duplicate recovery credential.

GitHub API permissions cannot enforce an environment's
deployment branch policy, so verify it manually in repository settings.

To release, push the revision to `main`, copy its exact full SHA, and dispatch
**Release production** with `confirmation=RELEASE`.

## Common commands

```bash
npm run dev
npm test
npm run typecheck
npm run lint
npm run build

npm run db:setup
npm run db:generate
npm run db:migrate:deploy
npm run db:verify-targets
npm run db:verify-release-compatibility
npm run db:adopt-sheet-contacts

npm run contact-research:agent
npm run contact-audit:agent
npm run trajectory:production:verify
npm run trajectory:feedback:export -- --output-dir <directory>
npm run rotate:statsfm-token
```

`npm test` runs serially and replaces inherited database URLs with unreachable
loopback test URLs while clearing production credentials. `scripts/smoke.ts`
performs real writes and must be used only with a disposable test database; it
refuses production targets.

## Repository map

```text
app/               Pages, route handlers, and Server Actions
components/        Shared UI
lib/               Domain logic and integration safety
prisma/            Schema and explicit SQL migrations
scripts/           Workers, importers, and operational tools
.github/agents/    Contact research and audit policies
.github/workflows/ Schedules and protected releases
```
