import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium, devices } from "playwright";

const port = 3211;
const origin = `http://localhost:${port}`;
const server = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "dev",
    "--webpack",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ADMIN_PASSWORD: "mobile-pwa-test-password",
      ADMIN_SESSION_SECRET: "mobile-pwa-test-session-secret-with-adequate-length",
      ALLOW_INSECURE_OPEN_MODE: "false",
      NEXT_PUBLIC_ENABLE_PWA_TEST: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let serverOutput = "";
server.stdout.on("data", (chunk) => {
  serverOutput += String(chunk);
});
server.stderr.on("data", (chunk) => {
  serverOutput += String(chunk);
});

async function waitForServer() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Next.js exited early.\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${origin}/login`);
      if (response.ok) return;
    } catch {
      // Keep polling while the development server starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Next.js.\n${serverOutput}`);
}

async function run() {
  await waitForServer();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      ...devices["iPhone 13"],
      serviceWorkers: "allow",
    });
    const page = await context.newPage();
    await page.goto(`${origin}/login?next=%2Fmanifest.webmanifest`);

    assert.equal(
      await page.locator('meta[name="mobile-web-app-capable"]').getAttribute("content"),
      "yes",
    );
    assert.equal(
      await page.locator('meta[name="apple-mobile-web-app-status-bar-style"]').getAttribute("content"),
      "black-translucent",
    );
    assert.ok(await page.locator('link[rel="manifest"]').getAttribute("href"));

    const viewport = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      passwordHeight: document.querySelector<HTMLInputElement>("#password")?.getBoundingClientRect().height,
    }));
    assert.ok(
      viewport.documentWidth <= viewport.viewportWidth,
      JSON.stringify(viewport),
    );
    assert.ok(
      (viewport.passwordHeight ?? 0) >= 43.5,
      JSON.stringify(viewport),
    );

    await page.locator("#password").fill("mobile-pwa-test-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/manifest.webmanifest");
    assert.ok(
      (await context.cookies()).some(
        (cookie) => cookie.name === "admin_session" && cookie.httpOnly,
      ),
    );

    const manifest = await page.evaluate(async () =>
      fetch("/manifest.webmanifest").then((response) => response.json()),
    );
    assert.equal(manifest.display, "standalone");
    assert.equal(manifest.scope, "/");

    await page.goto(`${origin}/login`);
    await page.evaluate(() => navigator.serviceWorker.ready);
    const cachedUrls = await page.evaluate(async () => {
      const keys = await caches.keys();
      const requests = await Promise.all(
        keys.map(async (key) => (await caches.open(key)).keys()),
      );
      return requests.flat().map((request) => new URL(request.url).pathname);
    });
    assert.ok(cachedUrls.includes("/offline.html"));
    assert.ok(!cachedUrls.some((url) => url === "/login" || url.startsWith("/api/")));

    await page.goto(`${origin}/mobile-pwa-client-smoke`);
    const mobileNavigation = page.getByRole("navigation", {
      name: "Mobile navigation",
    });
    await mobileNavigation.waitFor();

    const controlSizes = await page.evaluate(() => {
      const host = document.createElement("div");
      host.innerHTML = `
        <input data-control="text" type="text">
        <select data-control="select"><option>One</option></select>
        <textarea data-control="textarea"></textarea>
        <input data-control="checkbox" type="checkbox" class="h-4 w-4">
        <input data-control="radio" type="radio" class="h-4 w-4">
        <input data-control="range" type="range">
      `;
      document.body.append(host);
      return Object.fromEntries(
        Array.from(host.querySelectorAll<HTMLElement>("[data-control]")).map(
          (control) => {
            const rect = control.getBoundingClientRect();
            return [
              control.dataset.control!,
              { width: rect.width, height: rect.height },
            ];
          },
        ),
      );
    });
    for (const name of ["text", "select", "textarea"]) {
      assert.ok(controlSizes[name].height >= 43.5, `${name}: ${JSON.stringify(controlSizes[name])}`);
    }
    for (const name of ["checkbox", "radio"]) {
      assert.ok(controlSizes[name].width <= 17, `${name}: ${JSON.stringify(controlSizes[name])}`);
      assert.ok(controlSizes[name].height <= 17, `${name}: ${JSON.stringify(controlSizes[name])}`);
    }
    assert.ok(controlSizes.range.height < 43.5, JSON.stringify(controlSizes.range));

    const moreMenu = mobileNavigation.locator("details");
    await moreMenu.locator("summary").click();
    assert.equal(
      await moreMenu.evaluate(
        (details) => (details as HTMLDetailsElement).open,
      ),
      true,
    );
    await page.evaluate(() => {
      document.addEventListener(
        "click",
        (event) => {
          if ((event.target as Element).closest(".mobile-nav-sheet a")) {
            event.preventDefault();
          }
        },
        { capture: true, once: true },
      );
    });
    await moreMenu.locator(".mobile-nav-sheet a").first().click();
    assert.equal(
      await moreMenu.evaluate(
        (details) => (details as HTMLDetailsElement).open,
      ),
      false,
    );

    await moreMenu.locator("summary").click();
    assert.equal(
      await moreMenu.evaluate(
        (details) => (details as HTMLDetailsElement).open,
      ),
      true,
    );
    await page.evaluate(() => {
      window.history.pushState({}, "", "/mobile-pwa-client-smoke-next");
    });
    await page.waitForFunction(
      () =>
        !document.querySelector<HTMLDetailsElement>(
          'nav[aria-label="Mobile navigation"] details',
        )?.open,
    );

    await context.close();
  } finally {
    await browser.close();
  }
}

run()
  .then(() => {
    console.log("Mobile PWA Playwright smoke passed.");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    server.kill("SIGTERM");
  });
