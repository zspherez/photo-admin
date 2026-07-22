import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import manifest from "./manifest";

const root = process.cwd();
const serviceWorker = fs.readFileSync(
  path.join(root, "public/sw.js"),
  "utf8",
);
const offlineShell = fs.readFileSync(
  path.join(root, "public/offline.html"),
  "utf8",
);

test("manifest defines an installable standalone admin app", () => {
  const value = manifest();

  assert.equal(value.display, "standalone");
  assert.equal(value.scope, "/");
  assert.match(String(value.start_url), /^\/dashboard/);
  assert.ok(value.icons?.some((icon) => icon.sizes === "192x192"));
  assert.ok(value.icons?.some((icon) => icon.sizes === "512x512"));
  assert.ok(value.icons?.some((icon) => icon.purpose === "maskable"));
});

test("service worker caches static assets but keeps pages and APIs network-only", () => {
  assert.match(serviceWorker, /request\.mode === "navigate"/);
  assert.match(serviceWorker, /fetch\(request\)\.catch/);
  assert.match(serviceWorker, /caches\.match\("\/offline\.html"/);
  assert.match(serviceWorker, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(serviceWorker, /url\.pathname\.startsWith\("\/_next\/static\/"\)/);
  assert.doesNotMatch(serviceWorker, /cache\.put\(request[\s\S]*navigate/);
  assert.doesNotMatch(serviceWorker, /\/dashboard|\/research|\/contact-audit/);
});

test("offline shell states that private data is not available offline", () => {
  assert.match(
    offlineShell,
    /Admin pages, account\s+data, and mutations are never stored/,
  );
  assert.match(offlineShell, /location\.reload\(\)/);
});

test("all declared PWA icons exist", () => {
  for (const file of [
    "public/icons/icon-192.png",
    "public/icons/icon-512.png",
    "public/icons/icon-maskable-512.png",
    "app/apple-icon.png",
  ]) {
    assert.ok(fs.statSync(path.join(root, file)).size > 100, file);
  }
});
