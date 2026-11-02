import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./nav.tsx", import.meta.url), "utf8");

test("primary navigation keeps dashboard shows and manual show sync distinct", () => {
  assert.match(
    source,
    /\{ href: "\/dashboard", label: "Shows", match:/
  );
  assert.match(
    source,
    /\{ href: "\/shows", label: "All shows \/ Sync", match: \(p\) => p === "\/shows" \}/
  );
});

test("primary navigation does not expose the legacy New tab", () => {
  assert.doesNotMatch(source, /href: "\/new"/);
  assert.doesNotMatch(source, /label: "New"/);
});

test("primary navigation combines outreach and custom messages under Emails", () => {
  assert.doesNotMatch(source, /label: "Sent"/);
  assert.match(source, /href: "\/outreach",\s+label: "Emails"/);
  assert.match(source, /p === "\/outreach"/);
  assert.match(source, /p\.startsWith\("\/outreach\/"\)/);
});

test("mobile navigation exposes core workflows and an accessible overflow menu", () => {
  assert.match(source, /aria-label="Mobile navigation"/);
  assert.match(source, /const MOBILE_ITEMS = \[/);
  assert.match(source, /label: "Research"/);
  assert.match(source, /label: "Audit"/);
  assert.match(source, /label: "Emails"/);
  assert.match(source, /\{ href: "\/outreach", label: "Emails", icon: "emails" \}/);
  assert.match(source, /<summary/);
  assert.match(source, /All sections/);
});

test("desktop navigation groups secondary routes under More", () => {
  const secondary = source.match(/const DESKTOP_MORE_HREFS = new Set\(\[([\s\S]*?)\]\);/)?.[1];
  assert.ok(secondary);
  for (const href of ["/new-years-runs", "/contact-audit", "/shows", "/settings"]) {
    assert.ok(secondary.includes(`"${href}"`));
  }
  assert.match(source, /const DESKTOP_ITEMS = ITEMS\.filter/);
  assert.match(source, /const DESKTOP_MORE_ITEMS = ITEMS\.filter/);
  assert.match(source, /ref=\{desktopMenuRef\}/);
  assert.match(source, /DESKTOP_MORE_ITEMS\.map/);
  assert.match(source, /onClick=\{closeDesktopMenu\}/);
  assert.match(source, /DESKTOP_MORE_ITEMS\.some\(\(item\) => item\.match\(pathname\)\)/);
});

test("More menus close on selection and persistent pathname changes", () => {
  assert.match(source, /useRef<HTMLDetailsElement>/);
  assert.match(source, /ref=\{mobileMenuRef\}/);
  assert.match(source, /onClick=\{closeMobileMenu\}/);
  assert.match(
    source,
    /useEffect\(\(\) => \{\s*closeMobileMenu\(\);\s*closeDesktopMenu\(\);\s*\}, \[pathname\]\)/,
  );
});
