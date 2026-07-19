import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPublicHttpUrl,
  extractReadablePage,
  isPrivateNetworkAddress,
  parseDuckDuckGoResults,
} from "./contact-research-web.mjs";

test("web research blocks private network address ranges", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.1.1",
    "::1",
    "::ffff:7f00:1",
    "fd00::1",
    "fe80::1",
  ]) {
    assert.equal(isPrivateNetworkAddress(address), true, address);
  }
  assert.equal(isPrivateNetworkAddress("8.8.8.8"), false);
  assert.equal(isPrivateNetworkAddress("2606:4700:4700::1111"), false);
});

test("URL screening rejects bracketed private IPv6 literals", async () => {
  await assert.rejects(
    assertPublicHttpUrl("http://[::1]/"),
    /Private network URLs/
  );
  await assert.rejects(
    assertPublicHttpUrl("http://[::ffff:7f00:1]/"),
    /Private network URLs/
  );
});

test("DuckDuckGo search results decode target URLs", () => {
  const html = `
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fteam">Example Management</a>
      <div class="result__snippet">Official management team page.</div>
    </div>
  `;
  assert.deepEqual(parseDuckDuckGoResults(html), [
    {
      title: "Example Management",
      url: "https://example.com/team",
      snippet: "Official management team page.",
    },
  ]);
});

test("readable page extraction keeps footer and mailto management emails", () => {
  const page = extractReadablePage(
    `
      <html>
        <head><title>Artist Team</title><script>ignore()</script></head>
        <body>
          <main><h1>Management</h1><p>Managed by Example.</p></main>
          <footer>
            manager@example.com
            <a href="mailto:team@example.com">Email management</a>
            <a href="/contact">Contact</a>
          </footer>
        </body>
      </html>
    `,
    "https://artist.example/about"
  );
  assert.equal(page.title, "Artist Team");
  assert.match(page.text, /Managed by Example/);
  assert.deepEqual(page.emails.sort(), [
    "manager@example.com",
    "team@example.com",
  ]);
  assert.deepEqual(
    page.links.map((link) => link.url).sort(),
    [
      "https://artist.example/contact",
      "mailto:team@example.com",
    ]
  );
});
