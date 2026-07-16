// Drives stats.fm's Spotify-OAuth signin in a headless browser using a
// stored sp_dc cookie, extracts the resulting identityToken JWT, and POSTs
// it to the photo-admin app's rotate endpoint. Intended for the recurring
// scheduled GitHub Actions job — see .github/workflows/rotate-statsfm-token.yml.
//
// Required env:
//   SPOTIFY_SP_DC          — long-lived Spotify session cookie value
//   STATSFM_ROTATE_URL     — e.g. https://photo-admin.vercel.app/api/cron/rotate-statsfm-token
//   CRON_SECRET            — bearer token expected by the rotate endpoint
//
// Optional env:
//   PLAYWRIGHT_HEADFUL=1   — run with a visible browser for local debugging

import { chromium, type BrowserContext } from "playwright";

const SP_DC = process.env.SPOTIFY_SP_DC;
const ROTATE_URL = process.env.STATSFM_ROTATE_URL;
const CRON_SECRET = process.env.CRON_SECRET;

if (!SP_DC) throw new Error("Missing SPOTIFY_SP_DC");
if (!ROTATE_URL) throw new Error("Missing STATSFM_ROTATE_URL");
if (!CRON_SECRET) throw new Error("Missing CRON_SECRET");

async function extractIdentityToken(context: BrowserContext): Promise<string> {
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);

  // Kick off stats.fm's "Sign in with Spotify" flow.
  await page.goto("https://stats.fm/api/auth/spotify", { waitUntil: "domcontentloaded" });

  // Spotify's OAuth screen lands with show_dialog=true even when previously
  // consented, so click "Agree" if present. Try a few selector variants.
  if (page.url().includes("accounts.spotify.com")) {
    const acceptSelectors = [
      "button[data-testid='auth-accept']",
      "button#auth-accept",
      "button[type='submit'][data-testid*='accept']",
      "button:has-text('Agree')",
      "button:has-text('Accept')",
    ];
    for (const sel of acceptSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        break;
      }
    }
  }

  // Wait until we land back on stats.fm (after the callback chain).
  await page.waitForURL(/https:\/\/stats\.fm\//, { timeout: 30_000 });

  // identityToken is set on .stats.fm by api.stats.fm's callback redirect.
  const cookies = await context.cookies(["https://stats.fm/", "https://api.stats.fm/"]);
  const identity = cookies.find((c) => c.name === "identityToken");
  if (!identity?.value) {
    throw new Error(`identityToken cookie not found after signin. Final URL: ${page.url()}`);
  }
  return identity.value;
}

async function main() {
  const browser = await chromium.launch({
    headless: process.env.PLAYWRIGHT_HEADFUL !== "1",
  });
  let token: string;
  try {
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: "sp_dc",
        value: SP_DC!,
        domain: ".spotify.com",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "None",
      },
    ]);
    token = await extractIdentityToken(context);
  } finally {
    await browser.close();
  }

  const res = await fetch(ROTATE_URL!, {
    method: "POST",
    signal: AbortSignal.timeout(60_000),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${CRON_SECRET}`,
    },
    body: JSON.stringify({ token }),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`Rotate endpoint ${res.status}: ${bodyText}`);
  }
  console.log("Rotated:", bodyText);
}

main().catch((e) => {
  console.error("Rotation failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
