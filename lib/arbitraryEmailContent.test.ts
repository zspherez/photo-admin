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

  for (const encoded of [
    '=3Cp=3EHello=20world=3C/p=3E',
    '=3Cdiv=3E=48=65=6C=6C=6F=20=74=65=61=6D=3C/div=3E',
    '<a href=3D"https://example.com">Link</a>',
    '<img SRC=3d"https://example.com/photo.jpg">',
    '<div Style=3D"color:red">Styled</div>',
    '<span CLASS=3d"example">Classed</span>',
  ]) {
    assert.equal(normalizeArbitraryEmailContent(encoded).ok, false);
  }
  for (const ordinary of [
    "<p>Use the literal values =3D and x=3D in this explanation.</p>",
    "<p>Equation: total=3C + tax=20.</p>",
    "<p>Literal tokens =3Ctag=3E remain text.</p>",
    "<p>ASCII bytes: =41 =42 =43 =44 =45 =46 =47 =48.</p>",
    '<p>Documentation: href=3D"https://example.com", STYLE=3d"color:red".</p>',
    "<p>Tokens: =3G =0Z = and =4.</p>",
    "<p>Occasional hex-like values: =41 then =42.</p>",
    "=3Cdiv=3E",
  ]) {
    assert.equal(normalizeArbitraryEmailContent(ordinary).ok, true);
  }
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
    <img src="https://tracker.example/max-width.gif" style="max-width: 1px !important" alt="">
    <img src="https://tracker.example/max-height.gif" style="max-height: .5px" alt="">
    <img src="https://tracker.example/mixed.gif" style="height: 600px; max-width: 1px" alt="">
    <img src="https://tracker.example/width.gif" style="width: .5px" alt="">
    <img src="https://tracker.example/attribute.gif" max-width=".5px" alt="">
    <img src="data:image/png;base64,AAAA" alt="embedded">
    <img src="https://images.example/photo.jpg" style="width: 100%; min-width: 0; min-height: .5px; max-width: 600px" alt="Gallery">
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
    /src="https:\/\/images\.example\/photo\.jpg" alt="Gallery"/,
  );
  assert.match(
    result.content.html,
    /width: 100%; min-width: 0; min-height: \.5px; max-width: 600px/,
  );
});

test("inline sibling whitespace is preserved while block indentation is removed", () => {
  const result = normalizeArbitraryEmailContent(`
    <div>
      <span>Hello</span> <span>world</span><span>!</span>
      <p>
        <a href="https://example.com/read">Read</a> <em>this</em>, <strong>please</strong>.
      </p>
      <div>
        <span>Nested</span>
        <span>inline</span>
      </div>
    </div>
  `);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(
    result.content.html,
    /<span>Hello<\/span> <span>world<\/span><span>!<\/span><p><a[^>]+>Read<\/a> <em>this<\/em>, <strong>please<\/strong>\.<\/p><div><span>Nested<\/span> <span>inline<\/span><\/div>/,
  );
  assert.match(result.content.text, /Hello world!\n\nRead/);
  assert.match(
    result.content.text,
    /Read \(https:\/\/example\.com\/read\) this, please\./,
  );
  assert.match(result.content.text, /please\.\n\nNested inline/);
  assert.doesNotMatch(result.content.html, />\s{2,}</);
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
