# Mobile PWA

Photo Admin ships as an installable progressive web app for its private admin
workflows. On iPhone, open the production site in Safari, sign in, use
**Share → Add to Home Screen**, and launch the new Photo Admin icon.

## Why a PWA

A PWA preserves the existing authenticated Next.js application and all of its
show, research, audit, recommendation, email, and settings workflows. It can be
installed without an App Store release, updates with the web deployment, works
on iPhone and other devices, and keeps the existing same-origin HttpOnly
session cookie. Standalone metadata, safe-area layout, mobile navigation, touch
targets, and editor/list adaptations make it app-like without maintaining a
second client.

An App Clip is not a fit for the current product. App Clips are native,
invocation-driven slices intended for one brief task. This admin needs a signed
in user to move among many dense, related workflows. A Clip would require an
iOS target, Apple Developer/App Store configuration, associated domains,
native authentication/session integration, and duplicate API-facing UI while
still handing most work back to the web app.

## Offline and cache policy

The service worker is intentionally narrow:

| Request | Strategy |
| --- | --- |
| Authenticated pages and React Server Component requests | Network only |
| `/api/*` and all mutations | Network only |
| Cross-origin requests | Network only |
| Hashed `/_next/static/*`, logo, and app icons | Cache first |
| Navigation while offline | Generic offline shell only |

The cache never stores rendered admin pages, API responses, contact data,
research results, email content, or mutation requests. Proxy responses for
authenticated pages and APIs also carry `Cache-Control: private, no-store`.
Signing in from the standalone app uses the existing same-origin secure
HttpOnly cookie and redirects back to the requested route.

## Mobile workflow notes

- The bottom bar keeps Shows, Research, Audit, and Emails one tap away; all
  other sections and logout are in **More**.
- Forms use iPhone-safe input sizing and larger touch targets. Email editor
  controls remain reachable while editing, and send/save controls stay above
  the Home indicator and mobile navigation.
- Infinite show and recommendation lists retain automatic loading and manual
  fallback controls, with bottom spacing for the installed-app navigation.
- Email history becomes labeled cards on narrow screens rather than requiring
  a wide table.
- Camera/file capture was not added because the current app has no useful
  upload workflow or file mutation endpoint to receive a capture.

## App Clip feasibility later

An App Clip could be worthwhile only after a narrow, location- or QR-triggered
task exists, such as checking into an assigned show or capturing and uploading
a credential/photo to a defined backend workflow. Before implementation, add a
native iOS host app and Clip target, associated-domain invocation URLs, a
short-lived API authentication exchange, native upload endpoints, and an
App-Store-managed release process. The PWA should remain the full admin client;
the Clip would deep-link into or hand off to it after the single task.

## Validation

```bash
npm test
npm run lint
npm run typecheck
npm run test:mobile
```

`test:mobile` starts a development server and uses Playwright’s iPhone profile
to verify standalone metadata, mobile sizing, service-worker registration,
the static-only cache, and login session issuance. It does not run a production
build or contact production services.
