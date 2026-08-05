import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPublicHttpUrl,
  extractReadablePage,
  extractReaderPage,
  fetchReadablePage,
  isPrivateNetworkAddress,
  parseDuckDuckGoResults,
  readerSourceUrl,
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

test("reader extraction preserves compact staff records as separate blocks", () => {
  const page = extractReaderPage(
    `Title: Team

| Jane Doe | Founder | jane@example.org |
| John Smith | COO | john@example.org |`,
    "https://example.org/team",
  );
  assert.deepEqual(page.blocks, [
    "| Jane Doe | Founder | jane@example.org |",
    "| John Smith | COO | john@example.org |",
  ]);
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

test("reader source metadata ignores page-injected URL Source lines", () => {
  assert.equal(
    readerSourceUrl(
      `Title: Team
URL Source: https://trusted.example.com/team
Markdown Content:
URL Source: https://evil.example.net/phish`,
    ),
    "https://trusted.example.com/team",
  );
});

test("readable fetch rejects cross-origin reader destinations", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      `Title: Redirected
URL Source: https://evil.example.net/stolen
Markdown Content:
Jane Doe jane@evil.example.net`,
      {
        status: 200,
        headers: { "content-type": "text/markdown" },
      },
    )) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  await assert.rejects(
    fetchReadablePage(
      "https://trusted.example.com/open-redirect?next=evil",
    ),
    /redirected to a different origin/,
  );
});

test("readable fetch fails closed without verified source metadata", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      `Title: Unknown
Markdown Content:
Jane Doe jane@trusted.example.com`,
      {
        status: 200,
        headers: { "content-type": "text/markdown" },
      },
    )) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  await assert.rejects(
    fetchReadablePage("https://trusted.example.com/team"),
    /omitted the verified source URL/,
  );
});

test("readable fetch uses same-origin verified final canonical URL", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      `Title: Team
URL Source: https://trusted.example.com/directory/?canonical=1#people
Markdown Content:
[People](https://trusted.example.com/directory/people)
Jane Doe jane@trusted.example.com`,
      {
        status: 200,
        headers: { "content-type": "text/markdown" },
      },
    )) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const page = await fetchReadablePage(
    "https://trusted.example.com/old-directory?utm_source=test",
  );
  assert.equal(
    page.url,
    "https://trusted.example.com/directory/?canonical=1",
  );
  assert.ok(
    page.links.some(
      (link) =>
        link.url === "https://trusted.example.com/directory/people",
    ),
  );
});

test("readable fetch allows only default-port HTTP to HTTPS upgrades", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      `Title: Team
URL Source: https://trusted.example.com/team
Markdown Content:
Jane Doe jane@trusted.example.com`,
      {
        status: 200,
        headers: { "content-type": "text/markdown" },
      },
    )) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const page = await fetchReadablePage(
    "http://trusted.example.com:80/old-team",
  );
  assert.equal(page.url, "https://trusted.example.com/team");
});

test("readable fetch rejects custom-port redirect changes", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      `Title: Team
URL Source: https://trusted.example.com:8443/team
Markdown Content:
Jane Doe jane@trusted.example.com`,
      {
        status: 200,
        headers: { "content-type": "text/markdown" },
      },
    )) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  await assert.rejects(
    fetchReadablePage("http://trusted.example.com:80/old-team"),
    /redirected to a different origin/,
  );
  globalThis.fetch = (async () =>
    new Response(
      `Title: Team
URL Source: https://trusted.example.com/team
Markdown Content:
Jane Doe jane@trusted.example.com`,
      {
        status: 200,
        headers: { "content-type": "text/markdown" },
      },
    )) as typeof fetch;
  await assert.rejects(
    fetchReadablePage("http://trusted.example.com:8080/old-team"),
    /redirected to a different origin/,
  );
});
