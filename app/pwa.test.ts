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
const globalStyles = fs.readFileSync(
  path.join(root, "app/globals.css"),
  "utf8",
);
const layoutSource = fs.readFileSync(
  path.join(root, "app/layout.tsx"),
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

test("mobile text controls are touch-sized without resizing selection controls", () => {
  assert.doesNotMatch(globalStyles, /input:not\(\[type="hidden"\]\)/);
  assert.match(globalStyles, /input:not\(\[type\]\)/);
  assert.match(globalStyles, /\[type="text"\]/);
  assert.match(globalStyles, /\[type="password"\]/);
  assert.match(globalStyles, /select,\s+textarea \{\s+min-height: 2\.75rem/);
  assert.doesNotMatch(globalStyles, /\[type="checkbox"\][\s\S]*min-height/);
  assert.doesNotMatch(globalStyles, /\[type="radio"\][\s\S]*min-height/);
});

test("translucent iOS status indicators always sit over a dark safe area", () => {
  assert.match(layoutSource, /statusBarStyle: "black-translucent"/);
  assert.match(
    globalStyles,
    /\.app-header-safe::before \{[\s\S]*height: env\(safe-area-inset-top\);[\s\S]*background: #09090b;/,
  );
  assert.match(layoutSource, /prefers-color-scheme: light[\s\S]*#ffffff/);
  assert.match(layoutSource, /prefers-color-scheme: dark[\s\S]*#09090b/);
});
