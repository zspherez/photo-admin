import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  EMAIL_UTM_DEFAULTS,
  appendEmailUtmToHtml,
  normalizeArtistUtmContent,
  renderTrackedEmailHtml,
  resolveEmailUtmSettings,
  type EmailUtmSettings,
} from "./emailUtm";

const DEFAULTS: EmailUtmSettings = { ...EMAIL_UTM_DEFAULTS };

test("UTM tracking preserves existing query parameters, HTML entities, and fragments", () => {
  assert.equal(
    appendEmailUtmToHtml(
      '<a href="https://example.com/gallery?ref=email&amp;view=grid#photos">Gallery</a>',
      "original",
      "The Artist",
      DEFAULTS,
    ),
    '<a href="https://example.com/gallery?ref=email&amp;view=grid&amp;utm_source=photo_admin&amp;utm_medium=email&amp;utm_campaign=outreach&amp;utm_content=the-artist#photos">Gallery</a>',
  );
});

test("explicit UTM parameters win while missing parameters are added", () => {
  const html = appendEmailUtmToHtml(
    '<a href="https://example.com/?utm_source=authored&amp;utm_campaign=&amp;utm_content=custom">Link</a>',
    "original",
    "Ignored Artist",
    DEFAULTS,
  );

  assert.match(html, /utm_source=authored/);
  assert.match(html, /utm_campaign=/);
  assert.match(html, /utm_content=custom/);
  assert.match(html, /utm_medium=email/);
  assert.doesNotMatch(html, /utm_source=photo_admin/);
  assert.doesNotMatch(html, /utm_campaign=outreach/);
  assert.doesNotMatch(html, /utm_content=ignored-artist/);
});

test("single and double quoted hrefs and uppercase web schemes are tracked", () => {
  const html = appendEmailUtmToHtml(
    `<a href='HTTP://Example.com/one'>One</a><a HREF="HTTPS://example.com/two">Two</a>`,
    "follow_up",
    "Artist",
    DEFAULTS,
  );

  assert.match(
    html,
    /href='http:\/\/example\.com\/one\?utm_source=photo_admin&amp;utm_medium=email&amp;utm_campaign=follow_up&amp;utm_content=artist'/,
  );
  assert.match(
    html,
    /HREF="https:\/\/example\.com\/two\?utm_source=photo_admin&amp;utm_medium=email&amp;utm_campaign=follow_up&amp;utm_content=artist"/,
  );
});

test("non-web, relative, and invalid links remain unchanged", () => {
  const html = [
    '<a href="mailto:hello@example.com">Mail</a>',
    '<a href="tel:+15555555555">Call</a>',
    '<a href="sms:+15555555555">Text</a>',
    '<a href="#details">Anchor</a>',
    '<a href="/gallery">Relative</a>',
    '<a href="https://[invalid">Invalid</a>',
  ].join("");

  assert.equal(
    appendEmailUtmToHtml(html, "original", "Artist", DEFAULTS),
    html,
  );
});

test("valid unquoted web hrefs are safely quoted and tracked", () => {
  assert.equal(
    appendEmailUtmToHtml(
      "<a href=https://example.com/gallery>Gallery</a>",
      "original",
      "Artist",
      DEFAULTS,
    ),
    '<a href="https://example.com/gallery?utm_source=photo_admin&amp;utm_medium=email&amp;utm_campaign=outreach&amp;utm_content=artist">Gallery</a>',
  );
});

test("malformed HTML and text content are safely unchanged", () => {
  const malformed = 'Text https://example.com <a href="https://example.com';
  assert.equal(
    appendEmailUtmToHtml(malformed, "original", "Artist", DEFAULTS),
    malformed,
  );
});

test("artist UTM content uses Unicode-aware lowercase slug normalization", () => {
  assert.equal(
    normalizeArtistUtmContent("  BJÖRK 東京 + مرحبا / １２３  "),
    "björk-東京-مرحبا-123",
  );
  const html = appendEmailUtmToHtml(
    '<a href="https://example.com">Link</a>',
    "original",
    "Beyoncé 東京",
    DEFAULTS,
  );
  assert.match(html, /utm_content=beyonc%C3%A9-%E6%9D%B1%E4%BA%AC/);
});

test("blank settings omit only their corresponding parameters", () => {
  const settings = resolveEmailUtmSettings({
    utm_source: "",
    utm_medium: " ",
    utm_campaign_original: "",
    utm_campaign_follow_up: "",
  });
  const withArtist = appendEmailUtmToHtml(
    '<a href="https://example.com">Link</a>',
    "original",
    "Artist Name",
    settings,
  );
  assert.equal(
    withArtist,
    '<a href="https://example.com/?utm_content=artist-name">Link</a>',
  );

  assert.equal(
    appendEmailUtmToHtml(
      '<a href="https://example.com">Link</a>',
      "original",
      "   ",
      settings,
    ),
    '<a href="https://example.com">Link</a>',
  );
  assert.deepEqual(resolveEmailUtmSettings({}), DEFAULTS);
});

test("original and follow-up campaigns are isolated", () => {
  const settings = {
    ...DEFAULTS,
    utm_campaign_original: "first-touch",
    utm_campaign_follow_up: "second-touch",
  };
  const source = '<a href="https://example.com">Link</a>';

  assert.match(
    appendEmailUtmToHtml(source, "original", "Artist", settings),
    /utm_campaign=first-touch/,
  );
  assert.match(
    appendEmailUtmToHtml(source, "follow_up", "Artist", settings),
    /utm_campaign=second-touch/,
  );
});

test("safe template substitution happens before final UTM URL generation", () => {
  const html = renderTrackedEmailHtml(
    '<a href="{{portfolio_url}}">{{artist}}</a>',
    {
      portfolio_url: "https://example.com/work?view=all&sort=new",
      artist: "<Artist & Co>",
    },
    "original",
    "Artist & Co",
    DEFAULTS,
  );

  assert.equal(
    html,
    '<a href="https://example.com/work?view=all&amp;sort=new&amp;utm_source=photo_admin&amp;utm_medium=email&amp;utm_campaign=outreach&amp;utm_content=artist-co">&lt;Artist &amp; Co&gt;</a>',
  );
});

test("send snapshots and settings previews share the tracked HTML renderer", () => {
  const sendSource = readFileSync(
    new URL("./sendOutreach.ts", import.meta.url),
    "utf8",
  );
  const previewSource = readFileSync(
    new URL("../app/settings/template/page.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    sendSource,
    /renderTrackedEmailHtml\([\s\S]*?"original"[\s\S]*?utmSettings[\s\S]*?finalHtml: prep\.html/,
  );
  assert.match(
    sendSource,
    /renderTrackedEmailHtml\([\s\S]*?"follow_up"[\s\S]*?utmSettings/,
  );
  assert.match(
    sendSource,
    /prepareResendRequest\(\{[\s\S]*?html: outreach\.finalHtml/,
  );
  assert.match(
    previewSource,
    /previewHtml = renderTrackedEmailHtml\([\s\S]*?templateUtmKind\(kind\),[\s\S]*?matched\.artist\.name,[\s\S]*?utmSettings/,
  );
});
