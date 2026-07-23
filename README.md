# photo-admin

Private workflow software for concert and festival photography outreach.

It combines upcoming shows, listening history, artist recommendations, manager
contact research, contact audits, and email delivery in one Next.js app. The
project is tailored to a personal workflow rather than designed as a generic
SaaS product.

The app is also installable as a network-only PWA. Private admin pages and
mutations are never cached offline. See [docs/mobile-pwa.md](docs/mobile-pwa.md).

## How the workflow fits together

1. **Shows are synced** from EDMTrain and filtered for actionable geography and
   dates.
2. **Listening signals and trajectory recommendations** help prioritize shows.
3. **Manager research** finds evidence-backed management contacts for artists
   without an active email.
4. **Contact audits** re-check stored contacts against current public sources.
5. **You review every contact change** before it affects outreach.
6. **Emails are sent or queued manually** and tracked through Resend events.

Nothing in the research, audit, or recommendation workflows sends outreach
automatically.

## Main pages

| Page | Purpose |
|---|---|
| **Shows** (`/dashboard`) | Matched and all-NYC shows with Send, Queue, and Customize actions. |
| **Recommendations** (`/recommendations`) | Suggested trajectory, momentum, exploration, and portfolio opportunities. |
| **Research** (`/research`) | Review manager candidates, exhausted work, skips, and direct-outreach proposals. |
| **Audit** (`/contact-audit`) | One decision card per artist with the full stored roster, evidence, and proposed contacts. |
| **Emails** (`/emails`, `/outreach`) | One navigation section for show outreach and custom email history. |
| **Contacts** (`/contacts`) | Browse stored artist contacts. |
| **Festivals** (`/festivals`) | Festival lineups and outreach workflows. |
| **All shows / Sync** (`/shows`) | Inspect all synced shows and run manual show syncs. |
| **Settings** (`/settings`) | Identity, integrations, templates, contacts, agent rules, and queue controls. |

## Contact audit decisions

A full audit snapshots every active contact and the complete roster for each
artist. Copilot verifies each contact against current public artist and
management sources. The review page then groups all findings and proposals into
one card per artist.

For a proposed manager contact, you can:

- **Append** it and keep every existing contact.
- **Replace selected contacts** by adding the new contact and quarantining any
  selected subset (or all) of the old contacts.
- **Deactivate selected stale contacts** when no replacement is needed.
- **Reject** the proposed change and keep the roster unchanged.

Replacement never rewrites an existing contact identity. Old contacts and
their outreach history remain intact; selected contacts are quarantined and
the new contact is created separately. Artist-level decisions and selected
contact snapshots are immutable.

An email already stored for another artist is still a valid new alternative
when it is not stored for the artist being audited. Shared managers and
management-company addresses are expected.

## Automation schedule

| Workflow | Schedule | Behavior |
|---|---|---|
| Contact research | Hourly | Refreshes and drains manager-research work. |
| Contact audit poller | Every 10 minutes | Cheap no-op unless an audit request is pending or running. |
| Full contact re-audit | Monthly, first day at 15:17 UTC | Durably enqueues one idempotent audit request for that month. |
| Scheduled outreach | Weekdays at 9 AM ET | Sends due approved outreach; a four-hour recovery cadence handles retries. |
| Top playlist refresh | Daily | Rebuilds the managed Spotify playlist after listen sync. |
| Stats.fm token rotation | Monday, Thursday, and Saturday | Refreshes the Stats.fm token before expiry. |
| Trajectory producer | Daily/manual in the private producer repository | Generates and dry-runs recommendations; apply remains explicitly confirmed. |

Manual workflow dispatches remain available. A manual contact-audit dispatch
creates and starts a full audit. Monthly requests use a unique `monthly:YYYY-MM`
key and wait behind an audit already running.

## Contact research and audit safety

- Only public professional manager or management-company contacts are allowed.
- Booking agents, publicists, labels, promoters, venues, and press contacts are
  excluded.
- Agents never bypass logins, paywalls, robots restrictions, CAPTCHAs, or
  credentials.
- Production mutation endpoints require workflow-scoped GitHub Actions OIDC.
  Static agent tokens are local/development-only.
- Research and audit output is concise, evidence-backed, and review-only.
- Existing roster contacts are evaluated as context, not silently replaced.
- Official artist/team pages publishing an exact management email are strong
  evidence and do not require weaker third-party corroboration.

## Recommendations

The trajectory model is advisory, not canonical truth. Imports require:

- a trusted producer identity;
- an exact contract and raw SHA-256 digest;
- fresh timestamps and validity dates;
- exact EDMTrain artist/show mappings;
- a successful dry-run receipt before apply;
- explicit apply confirmation.

Recommendations never send email. Feedback and post-show outcomes are stored
append-only and exported without contact PII or message content.

## Email behavior

- Normal shows, festivals, and follow-ups use separate editable templates.
- Custom emails can be sent immediately or queued for the next dispatch.
- Recipient sets and rendered message content are snapshotted before sending.
- Suppression, retry policy, credential scope, idempotency, and uncertain
  provider outcomes are checked at send time.
- Resend webhooks record delivery, opens, clicks, bounces, and complaints.

Default UTM values are:

```text
utm_source=photo_admin
utm_medium=email
utm_campaign=outreach or follow_up
utm_content=<artist slug>
```

## Stack

- Next.js 16 and React 19
- Postgres and Prisma 6
- Tailwind CSS 4
- Resend
- Vercel
- GitHub Actions and GitHub Copilot CLI

## Local setup

Requirements:

- Node.js 22.x
- Postgres
- Integration credentials for the features you use

```bash
git clone <this repo>
cd photo-admin
cp .env.example .env

# Set DATABASE_URL and DIRECT_URL before installing.
npm install
npm run db:setup
npm run dev
```

Open <http://127.0.0.1:3000>.

Protected mode requires `ADMIN_PASSWORD` and an independent
`ADMIN_SESSION_SECRET`. For explicit local-only open mode, leave
`ADMIN_PASSWORD` blank and set `ALLOW_INSECURE_OPEN_MODE=true`. Open mode is
ignored in production.

After first boot, use **Settings -> General** for sender identity and portfolio
details, then connect the desired integrations.

## Environment variables

The complete list and descriptions are in [.env.example](.env.example).

Core:

- `DATABASE_URL` - pooled runtime Postgres URL.
- `DIRECT_URL` - direct migration Postgres URL.
- `APP_BASE_URL` - deployed or local app origin.
- `ADMIN_PASSWORD` and `ADMIN_SESSION_SECRET` - protected admin login.

Sending:

- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- `RESEND_WEBHOOK_SECRET`
- `SEND_TEST_OVERRIDE` (optional safe recipient override)

Shows and listening:

- `EDMTRAIN_API_KEY`
- `SPOTIFY_CLIENT_ID`
- `SPOTIFY_CLIENT_SECRET`
- `STATSFM_TOKEN`

Google Sheets:

- `GOOGLE_CREDENTIALS_JSON` or `GOOGLE_CREDENTIALS_PATH`
- `SPREADSHEET_ID` for initial interactive setup
- `SHEETS_SPREADSHEET_ID` and `SHEETS_TAB` for first protected cutover

Automation:

- `CRON_SECRET` for `/api/cron/*`
- `CONTACT_RESEARCH_AGENT_TOKEN` for explicit local research only
- `CONTACT_AUDIT_AGENT_TOKEN` for explicit local audit only

Trajectory:

- `TRAJECTORY_INGEST_AUTH_MODE`
- `TRAJECTORY_INGEST_GITHUB_REPOSITORY`
- `TRAJECTORY_INGEST_GITHUB_WORKFLOW_REF`
- `TRAJECTORY_INGEST_RECEIPT_SECRET`
- `TRAJECTORY_INGEST_HMAC_SECRET` only for the explicit HMAC fallback

## Google Sheets ownership

Sheet sync is writable. It adds a `photo_admin_id` column when needed and uses
stable row/slot identities for later reconciliation. The service account needs
Editor access.

Audit decisions preserve quarantined contact identities even if a Sheet row
later changes. If a row is changed to a replacement identity, sync releases
the old source identity and assigns the row to the new contact instead of
rewriting the quarantined contact and its outreach history.

Back up a Sheet before its first writable sync.

## Production release

Production uses `.github/workflows/release-production.yml`.

The workflow requires:

- an exact full commit SHA reachable from `main`;
- `confirmation=RELEASE`;
- the protected `production` environment;
- a separate `production-recovery` Vercel credential;
- matching `DATABASE_URL` and `DIRECT_URL` targets;
- successful tests, type-check, lint, build, staged runtime proof, migrations,
  Sheet adoption, promotion, and final compatibility checks.

The release builds and stages the exact revision before pausing production.
Migrations run only after staged code and database bindings are proven. A
main-only watchdog can recover only a target that is already proven safe.

Use durable project-scoped Vercel CI tokens for `VERCEL_TOKEN` and
`RECOVERY_VERCEL_TOKEN`; temporary OAuth tokens expire.

## Common commands

```bash
npm run dev
npm test
npm run typecheck
npm run lint

npm run db:generate
npm run db:migrate:deploy
npm run db:verify-targets
npm run db:verify-release-compatibility
npm run db:adopt-sheet-contacts
npm run db:setup

npm run trajectory:production:verify
npm run trajectory:feedback:export -- --output-dir <directory>
npm run rotate:statsfm-token
```

`npm test` runs test files serially to bound CPU, memory, and filesystem
pressure. Its bootstrap replaces inherited database URLs with unreachable
loopback test URLs and clears production credentials.

`scripts/smoke.ts` performs real writes and refuses production targets. Use it
only with a disposable test database.

## Repository layout

```text
app/                  Next.js pages, route handlers, and Server Actions
components/           Shared UI
lib/                  Domain logic and integration safety
prisma/               Schema and explicit SQL migrations
scripts/              Workers, importers, validation, and operational tools
.github/agents/        Manager research and contact audit agent policies
.github/workflows/     Scheduled jobs and protected releases
```

## Notes for forks

The default geography, templates, recommendation model, and contact policy
reflect one photographer's workflow. Expect to adapt EDMTrain eligibility,
listening sources, templates, and agent rules for another use case.
