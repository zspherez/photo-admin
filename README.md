# photo-admin

Private operations software for concert and festival photography outreach.

This Next.js app combines shows, recommendations, management-contact research,
audits, templates, and email delivery for one photographer. Nothing sends
outreach automatically. Its network-only PWA never caches private pages or
mutations; see [docs/mobile-pwa.md](docs/mobile-pwa.md).

## Main pages

| Page | Purpose |
|---|---|
| **Shows** (`/dashboard`) | Review shows; customize, queue, or send outreach. |
| **Recommendations** (`/recommendations`) | Review trajectory, momentum, exploration, and portfolio suggestions. |
| **Research** (`/research`) | Review manager candidates, skips, exhausted searches, and direct-outreach proposals. |
| **Audit** (`/contact-audit`) | Review an artist's roster, evidence, and proposed changes. |
| **Emails** (`/emails`, `/outreach`) | Inspect outreach and delivery history. |
| **Contacts** (`/contacts`) | Browse artist contacts. |
| **Festivals** (`/festivals`) | Manage lineups and outreach. |
| **All shows / Sync** (`/shows`) | Inspect synced shows and run a manual sync. |
| **Settings** (`/settings`) | Configure identity, integrations, templates, agents, and queues. |

## Contact research and audit

Research finds public, evidence-backed management contacts for artists without
an active email. Audits re-check active contacts against public sources.

Audit review is artist-level. The operator can:

- **Append** a proposal while keeping the current roster.
- **Replace selected contacts** by adding the proposal and quarantining only
  those selected.
- **Deactivate selected stale contacts** without a replacement.
- **Reject** the proposal without changing the roster.

Replacement does not rewrite identities. Quarantined contacts, history, and
decisions remain available. Shared addresses are valid when new for the artist.

Contact research and audit queues poll every 10 minutes and no-op cheaply when
idle. Research discovery runs hourly. A durable, idempotent full audit is
enqueued monthly and waits behind any active audit.

Both agents are pinned to `gpt-5.6-sol` with maximum reasoning effort. They use
public professional management sources, never bypass access controls, and
exclude booking, publicity, label, promoter, venue, and press contacts.

Production mutations use workflow-scoped GitHub Actions OIDC. Static agent
tokens are for explicit local or development use only.

## View-only access

Set a distinct `READ_ONLY_PASSWORD` for a second login. Users may navigate and
filter, but cannot save, sync, queue, schedule, send, or connect integrations.
This no-mutation boundary is enforced server-side through the signed session.

Template previews are redacted with Lorem ipsum so stored outreach copy is not
exposed. Contact the repository owner for a test view-only login.

## Local setup

Requires Node.js 22.x, Postgres, and credentials only for integrations in use.

```bash
git clone <this repo>
cd photo-admin
cp .env.example .env
# Set DATABASE_URL and DIRECT_URL.
npm install
npm run db:setup
npm run dev
```

Open <http://127.0.0.1:3000>.

Protected mode requires `ADMIN_PASSWORD` and `ADMIN_SESSION_SECRET`. Local-only
open mode uses a blank password plus `ALLOW_INSECURE_OPEN_MODE=true`.

## Essential environment groups

See [.env.example](.env.example) for every variable.

| Group | Essentials |
|---|---|
| Core | Database URLs, `APP_BASE_URL`, admin password/session secret, optional `READ_ONLY_PASSWORD` |
| Email | Resend API key, sender, webhook secret, optional test override |
| Shows/listening | EDMTrain key, Spotify client credentials, stats.fm token |
| Google Sheets | Google credentials, spreadsheet IDs, tab |
| Automation | `CRON_SECRET`; local-only contact agent tokens |
| Trajectory | Ingest auth mode, GitHub repository/workflow ref, receipt secret, fallback HMAC secret |

Sheet sync requires Editor access; back up the Sheet before its first write.

## Production release safety

The release workflow accepts an exact full SHA reachable from `main` plus
`confirmation=RELEASE`. It validates code, runtime, and database bindings,
runs migrations and Sheet adoption, promotes, and verifies compatibility.

Production pauses only after the revision is proven. Recovery is main-only and
limited to proven targets. Use durable project-scoped Vercel CI tokens.

Configure **`production-recovery`** separately:

- Do **not** configure required reviewers; recovery must not wait for another
  approval after a failed reviewed release.
- Choose **Selected branches and tags**, allow only the branch rule `main`,
  and add no tag rules.
- Set `RECOVERY_ENVIRONMENT_GUARD=production-recovery-main-only-v1`.
- Keep dedicated recovery Vercel values there. Delete every repository-level
  duplicate recovery credential.

GitHub API permissions cannot enforce an environment's
deployment branch policy, so verify it manually in repository settings.

To release, push the revision to `main`, copy its exact full SHA, then dispatch
**Release production** with `confirmation=RELEASE`.

## Common commands

```bash
npm run dev
npm test
npm run typecheck
npm run lint
npm run build
npm run db:setup
npm run db:verify-targets
npm run db:verify-release-compatibility
npm run contact-research:agent
npm run contact-audit:agent
npm run trajectory:production:verify
```

`npm test` uses unreachable test database URLs and clears production
credentials. `scripts/smoke.ts` writes data and refuses production targets.
