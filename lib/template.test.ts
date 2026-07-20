import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  applyHtmlTemplate,
  applyTemplate,
  buildVarsForShow,
  cloneTemplateContent,
  DEFAULT_TEMPLATE_HTML,
  extractVars,
  FOLLOW_UP_TEMPLATE_NAME,
  normalizeDefaultTemplateContent,
  normalizeLegacyRateTemplateHtml,
  normalizeLegacyRateTemplateVariable,
  normalizeTemplateContent,
  SUPPORTED_TEMPLATE_VARS,
} from "./template";

test("plain substitutions remain unescaped", () => {
  assert.equal(
    applyTemplate("Hi {{name}} — {{missing}}", { name: "A&B <Team>" }),
    "Hi A&B <Team> — "
  );
});

test("legacy rate variables are stripped even when callers provide a value", () => {
  const vars = { artist: "Artist", rate: "$650" };
  assert.equal(
    applyTemplate("{{artist}} — {{ rate }}", vars),
    "Artist — ",
  );
  assert.equal(
    applyHtmlTemplate("<p>{{RATE}}</p>", vars),
    "",
  );
  assert.equal(
    normalizeLegacyRateTemplateVariable("Rate: {{rate}}"),
    "Rate: ",
  );
  assert.equal(
    normalizeLegacyRateTemplateHtml(
      "<p>My rate is {{rate}} for photo/video, or $200 for photo.</p><p>Keep me.</p>",
    ),
    "<p>Keep me.</p>",
  );
  assert.equal(
    normalizeLegacyRateTemplateHtml(
      "<p>My standard NYC show rate is $650 for photo/video.</p><p>Keep me.</p>",
    ),
    "<p>Keep me.</p>",
  );
  assert.deepEqual(extractVars("{{artist}} {{ rate }}"), ["artist"]);
  assert.equal(
    (SUPPORTED_TEMPLATE_VARS as readonly string[]).includes("rate"),
    false,
  );
});

test("HTML substitutions are escaped without changing authored markup", () => {
  assert.equal(
    applyHtmlTemplate('<a href="{{url}}">{{label}}</a>', {
      url: 'https://example.com/?a=1&b="two"',
      label: '<img src=x onerror="alert(1)"> & Team',
    }),
    '<a href="https://example.com/?a=1&amp;b=&quot;two&quot;">&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; Team</a>'
  );
});

test("show variables do not read or expose legacy rate settings", async () => {
  const requestedKeys: string[] = [];
  const readSetting = async (key: string, fallback: string) => {
    requestedKeys.push(key);
    return fallback;
  };
  const vars = await buildVarsForShow(
    {
      artistName: "Artist",
      venueName: "Venue",
      showDate: new Date("2026-08-01T00:00:00.000Z"),
      managerName: null,
    },
    readSetting,
  );

  assert.equal(Object.hasOwn(vars, "rate"), false);
  assert.equal(requestedKeys.includes("default_rate"), false);
});

test("legacy saved templates and built-in defaults normalize without pricing", () => {
  assert.deepEqual(
    normalizeTemplateContent({
      subject: "{{artist}} {{ rate }}",
      htmlBody: "<p>Hello {{RATE}}</p>",
    }),
    {
      subject: "{{artist}} ",
      htmlBody: "",
    },
  );

  const oldDefault = `<html>
  <body>
    <p>Hey {{manager_name}} - wanted to shoot a quick message over regarding the {{artist}} show in {{sender_city}} in a few weeks. I am a multimedia creative specialist local to {{sender_city}} and would love to work together to capture this show!</p>
    <p>Gave a brief summary of my rates/deliverables below, and I'm happy to work with you to meet your needs!</p>
    <p>My minimum deliverables include 25 photos and 3-5 clips night of show; complete gallery with 50+ additional photos and 7-10 additional clips the following day.</p>
    <p>My standard {{sender_city}} show rate is {{rate}} for photo/video, or $200 for just photo.</p>
    <p>You can check out some examples of my previous work at <a href="{{portfolio_url}}">{{portfolio_url}}</a></p>
    <p>I look forward to hearing from you soon!</p>
    <p>Best,<br>
       {{sender_name}}<br>
       <a href="mailto:{{sender_email}}">{{sender_email}}</a> // {{sender_phone}} // <a href="{{portfolio_url}}">{{portfolio_url}}</a>
    </p>
  </body>
</html>`;
  const normalized = normalizeDefaultTemplateContent({
    subject: "{{artist}}",
    htmlBody: oldDefault,
  });
  assert.equal(normalized.htmlBody, DEFAULT_TEMPLATE_HTML);
  assert.doesNotMatch(normalized.htmlBody, /\brate\b|\$[0-9]/i);

  const fixedRateDefault = oldDefault
    .replace(
      "Gave a brief summary of my rates/deliverables below, and I'm happy to work with you to meet your needs!",
      "Gave a brief summary of my rates/deliverables below, and attached my full rate card to this email but I'm happy to work with you to meet your needs!",
    )
    .replace(
      "{{rate}} for photo/video, or $200 for just photo.",
      "$400 for photo/video, or $200 for just photo, more details in my rate card.",
    );
  assert.equal(
    normalizeDefaultTemplateContent({
      subject: "{{artist}}",
      htmlBody: fixedRateDefault,
    }).htmlBody,
    DEFAULT_TEMPLATE_HTML,
  );
  assert.doesNotMatch(DEFAULT_TEMPLATE_HTML, /\{\{\s*rate\s*\}\}|\$[0-9]/i);
});

test("follow-up template cloning is a one-time independent snapshot", () => {
  const original = {
    subject: "Current original",
    htmlBody: "<p>Current original</p>",
  };
  const followUp = cloneTemplateContent(original);
  original.subject = "Later original edit";
  original.htmlBody = "<p>Later original edit</p>";

  assert.deepEqual(followUp, {
    subject: "Current original",
    htmlBody: "<p>Current original</p>",
  });
  assert.equal(FOLLOW_UP_TEMPLATE_NAME, "follow_up");

  const source = readFileSync(new URL("./template.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /findUnique\(\{\s*where: \{ name: FOLLOW_UP_TEMPLATE_NAME \}/,
  );
  assert.match(
    source,
    /if \(existing\) \{[\s\S]*persistNormalizedTemplate\([\s\S]*existing,[\s\S]*normalizeDefaultTemplateContent,[\s\S]*\)[\s\S]*const original = await ensureDefaultTemplate\(\)/,
  );
  assert.match(
    source,
    /where: \{ name: FOLLOW_UP_TEMPLATE_NAME \},\s*update: \{\},\s*create:/,
  );
});

test("follow-up reset clones the current original template", () => {
  const source = readFileSync(
    new URL("../app/settings/template/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /kind === "follow_up"[\s\S]*cloneTemplateContent\(await ensureDefaultTemplate\(\)\)/,
  );
  assert.match(source, /searchParams: Promise<\{ kind\?: SearchParamValue \}>/);
  assert.match(source, /aria-label="Email template type"/);
  assert.match(source, /\? "Original" : "Follow-up"/);
  assert.match(source, /key=\{`\$\{template\.name\}:\$\{template\.updatedAt/);
});
