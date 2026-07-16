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
- **`/shows`, `/festivals`, `/artists`, `/outreach`** — listing/detail views.
- **`/settings`** — general config, Spotify connect, Stats.fm token, email
  template editor, contact import.
- **`/api/cron/sync-shows`, `/api/cron/sync-listens`** — daily Vercel Cron jobs.
- **`/api/resend/webhook`** — receives delivery/bounce/open events from Resend.

## Stack

- Next.js 16 (App Router), React 19
- Postgres + Prisma 6
- TailwindCSS 4
- Resend (transactional email)
- Vercel (hosting + cron)

## Prerequisites

- Node 20+
- A Postgres database (Supabase, Neon, etc. — anything Prisma can talk to)
- Accounts/API keys for the integrations you want to use (see below)

## Setup

```bash
git clone <this repo>
cd photo-admin
npm install
cp .env.example .env
# fill in .env (see "Required vs optional env" below)
npx prisma migrate deploy
npm run dev
```

App is at <http://localhost:3000>. If `ADMIN_PASSWORD` is set, you'll hit a
login screen; otherwise it's open.

After first boot, visit **Settings → General** to fill in your name, email,
phone, city, and portfolio URL — these are substituted into the default email
template (see below).

## Required vs optional env

The full list is in `.env.example`. Minimum to boot:

| Var | Required? | What it does |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection (pooled — runtime queries) |
| `DIRECT_URL` | yes | Postgres connection (direct — Prisma migrate) |
| `APP_BASE_URL` | yes | Used in OAuth redirects, etc. |
| `ADMIN_PASSWORD` | recommended | Gates the app behind a login. Hashed at runtime. Blank = open mode. |
| `RESEND_API_KEY` | for sending | Get one at <https://resend.com/api-keys>. The sending domain must be verified. |
| `RESEND_FROM_EMAIL` | for sending | The verified `From:` address. |
| `RESEND_WEBHOOK_SECRET` | recommended | `whsec_...` from Resend → Webhooks. Verifies inbound delivery events. |
| `CRON_SECRET` | for Vercel Cron | Bearer token Vercel Cron presents on `/api/cron/*`. Generate any random string. |
| `EDMTRAIN_API_KEY` | for show sync | Request a key at <https://edmtrain.com/api>. |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | for Spotify | Create an app at <https://developer.spotify.com/dashboard>. Redirect URI is `${APP_BASE_URL}/api/spotify/callback`. Spotify rejects `http://localhost`, so use `http://127.0.0.1:3000` locally. |
| `STATSFM_TOKEN` | for Stats.fm | No public API — grab a session token from DevTools (Application → Local Storage → `token`) after logging into stats.fm. |
| `GOOGLE_CREDENTIALS_JSON` / `GOOGLE_CREDENTIALS_PATH` + `SPREADSHEET_ID` | optional | Service-account credentials for importing contacts from Google Sheets. The sheet must be shared with the service account's email. |
| `SEND_TEST_OVERRIDE` | optional | Reroutes every outbound send to this address (subject prefixed with `[TEST → original]`). The Settings UI also exposes this and wins over the env value. |

## Email template

The default outreach template is defined in `lib/template.ts` and seeded into
the DB on first request. It references these variables, all populated from
**Settings → General** or the Contact/Show rows:

- `{{artist}}`, `{{venue}}`, `{{date}}`, `{{rate}}`, `{{manager_name}}`
- `{{sender_name}}`, `{{sender_email}}`, `{{sender_phone}}`, `{{sender_city}}`,
  `{{portfolio_url}}`

Edit the template at **Settings → Email template**. "Reset to default" reverts
to the seed.

## Deploying to Vercel

1. Push the repo to GitHub and import it into Vercel.
2. Add every env var from `.env.example` you're using.
3. Wire up Postgres (Vercel Postgres, Supabase, or Neon all work) and set
   `DATABASE_URL` + `DIRECT_URL`.
4. The crons in `vercel.json` (`sync-shows` daily at 11:00 UTC, `sync-listens`
   at 12:00 UTC) fire automatically — make sure `CRON_SECRET` is set so they
   authenticate.
5. For Resend webhooks, point `https://<your-domain>/api/resend/webhook` at
   the Resend dashboard and set `RESEND_WEBHOOK_SECRET`.

## Scripts

```bash
npm run dev        # next dev
npm run build      # prisma generate + migrate deploy + next build
npm run lint
npx tsx scripts/smoke.ts   # one-shot sanity check of all integrations
```

## Notes for forks

This was carved out of my workflow as a photographer — the default email
template, the EDMTrain-as-source-of-truth choice, the "score artist by recent
listens" approach all reflect that. The DB schema and the page layouts will
serve any "match upcoming events against your taste, then email someone about
it" pipeline, but expect to edit `lib/edmtrain.ts`, the listen-signal sources,
and the template to fit your domain.
