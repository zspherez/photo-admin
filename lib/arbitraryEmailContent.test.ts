import assert from "node:assert/strict";
import test from "node:test";
import { load } from "cheerio";
import { normalizeArbitraryEmailContent } from "./arbitraryEmailContent";

test("deeply nested Apple Mail-like documents become one canonical UTF-8 document", () => {
  const result = normalizeArbitraryEmailContent(`
    <!DOCTYPE html>
    <html><head>
      <meta charset="windows-1252">
      <meta http-equiv="content-type" content="text/html; charset=us-ascii">
      <style>.Apple-converted-space { white-space: pre; }</style>
    </head><body>
      <div class="AppleMailSignature">
        <html><head><meta charset="utf-8"></head><body>
          <p style="font-family: Helvetica; color: #222" onclick="track()">
            Hello <span class="Apple-converted-space">&nbsp;</span><strong>team</strong>.
          </p>
          <blockquote type="cite"><p>Earlier message</p></blockquote>
        </body></html>
      </div>
    </body></html>
  `);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.content.html.startsWith("<!doctype html>\n"));
  assert.equal((result.content.html.match(/<html\b/g) ?? []).length, 1);
  assert.equal((result.content.html.match(/<head\b/g) ?? []).length, 1);
  assert.equal((result.content.html.match(/<body\b/g) ?? []).length, 1);
  assert.equal((result.content.html.match(/<meta charset=/g) ?? []).length, 1);
  assert.equal((result.content.html.match(/name="viewport"/g) ?? []).length, 1);
  assert.doesNotMatch(result.content.html, /AppleMail|onclick|<style/i);
  assert.match(result.content.html, /font-family: Helvetica; color: #222/);
  assert.match(result.content.text, /Hello\s+team\./);
  assert.match(result.content.text, /Earlier message/);
});

test("Gmail and Word wrappers, duplicate document tags, and malformed nesting are repaired", () => {
  const result = normalizeArbitraryEmailContent(`
    <html><head><meta charset="utf-8"></head><body class="gmail_quote">
      <!--[if mso]><xml>Word settings</xml><![endif]-->
      <div id="docs-internal-guid"><p class="MsoNormal">First<o:p></o:p></p>
      <body><meta charset="utf-16"><p><strong>Second<p>Third</div>
    </body></html>
  `);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const $ = load(result.content.html);
  assert.equal($("html").length, 1);
  assert.equal($("head").length, 1);
  assert.equal($("body").length, 1);
  assert.equal($("meta[charset]").length, 1);
  assert.equal($("o\\:p, xml").length, 0);
  assert.doesNotMatch(result.content.html, /gmail_quote|MsoNormal|docs-internal/);
  assert.match(result.content.text, /First/);
  assert.match(result.content.text, /Second/);
  assert.match(result.content.text, /Third/);
});

test("quoted-printable message source is rejected instead of rendered or manually encoded", () => {
  const result = normalizeArbitraryEmailContent(
    [
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      '<div style=3D"font-family:Arial">It=E2=80=99s ready=',
      " now.</div>",
    ].join("\r\n"),
  );
  assert.deepEqual(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /quoted-printable message source/i);
    assert.match(result.error, /Resend/);
  }

  const sourceWithoutHeaders = normalizeArbitraryEmailContent(
    '<div style=3D"font-family:Arial">It=E2=80=99s ready=<br>\r\nnow</div>',
  );
  assert.equal(sourceWithoutHeaders.ok, false);
  const ordinaryEqualsText = normalizeArbitraryEmailContent(
    "<p>Use the literal values =3D and x=3D in this explanation.</p>",
  );
  assert.equal(ordinaryEqualsText.ok, true);
});

test("unsafe content and hidden tracking are removed while safe formatting and visible images remain", () => {
  const result = normalizeArbitraryEmailContent(`
    <script>alert(1)</script>
    <form><input value="secret"><button>Submit</button></form>
    <iframe src="https://evil.example"></iframe>
    <p onmouseover="steal()" style="color: red; background-image: url(https://evil.example/x); position: fixed">
      Safe <em>message</em>
      <a href="javascript:alert(1)">bad link</a>
      <a href="https://example.com/path">good link</a>
    </p>
    <img src="https://tracker.example/open.gif" width="1" height="1" alt="">
    <img src="data:image/png;base64,AAAA" alt="embedded">
    <img src="https://images.example/photo.jpg" width="600" alt="Gallery">
    <div style="display:none">hidden preheader tracker</div>
  `);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.doesNotMatch(
    result.content.html,
    /script|form|input|button|iframe|onmouseover|javascript:|data:image|tracker\.example|hidden preheader/i,
  );
  assert.match(result.content.html, /style="color: red"/);
  assert.match(
    result.content.html,
    /href="https:\/\/example\.com\/path" rel="noopener noreferrer"/,
  );
  assert.match(
    result.content.html,
    /src="https:\/\/images\.example\/photo\.jpg" alt="Gallery" width="600"/,
  );
});

test("plain text preserves Unicode, paragraphs, lists, links, and signatures with UTM parity", () => {
  const result = normalizeArbitraryEmailContent(
    `
      <p>“Hello”—café.</p>
      <p>Highlights:</p>
      <ul>
        <li>First item</li>
        <li><a href="https://example.com/work?utm_source=existing">Portfolio</a></li>
      </ul>
      <div>— Josh<br>Photographer</div>
    `,
    [
      ["utm_source", "replacement"],
      ["utm_medium", "email"],
    ],
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.content.text, /“Hello”—café\./);
  assert.match(result.content.text, /• First item/);
  assert.match(
    result.content.text,
    /Portfolio \(https:\/\/example\.com\/work\?utm_source=existing&utm_medium=email\)/,
  );
  assert.match(result.content.text, /— Josh\nPhotographer/);
  assert.match(
    result.content.html,
    /utm_source=existing&amp;utm_medium=email/,
  );
  assert.doesNotMatch(result.content.html, /utm_source=replacement/);

  const repeated = normalizeArbitraryEmailContent(result.content.html, [
    ["utm_source", "replacement"],
    ["utm_medium", "email"],
  ]);
  assert.deepEqual(repeated, result);
});

test("empty or entirely unsafe content returns a clear validation error", () => {
  assert.deepEqual(normalizeArbitraryEmailContent(" \n "), {
    ok: false,
    error: "Enter an email body",
  });
  assert.deepEqual(normalizeArbitraryEmailContent("<script>only content</script>"), {
    ok: false,
    error: "Email body has no visible, safe content after normalization",
  });
});
