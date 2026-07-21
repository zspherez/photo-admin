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
  FESTIVAL_TEMPLATE_HTML,
  FESTIVAL_TEMPLATE_SUBJECT,
  FOLLOW_UP_TEMPLATE_NAME,
  normalizeLegacyOutreachSnapshot,
  normalizeLegacyRateTemplateHtml,
  normalizeLegacyRateTemplateVariable,
  normalizeTemplateContent,
  originalTemplatePurposeForShow,
  supportedTemplateVars,
  SUPPORTED_TEMPLATE_VARS,
  unsupportedTemplateVars,
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

test("festival variables use event metadata with natural manual fallbacks", async () => {
  const readSetting = async (key: string) =>
    ({
      portfolio_url: "https://portfolio.example",
      sender_name: "Photographer",
      sender_email: "photo@example.com",
      sender_phone: "555-0100",
      sender_city: "New York",
    })[key] ?? "";
  const edmtrain = await buildVarsForShow(
    {
      artistName: "Artist",
      venueName: "Festival Grounds",
      eventName: "Summer Sound",
      city: "Queens",
      state: "NY",
      countryCode: "US",
      showDate: new Date("2026-08-01T00:00:00.000Z"),
      managerName: "Manager",
    },
    readSetting,
  );
  const manual = await buildVarsForShow(
    {
      artistName: "Artist",
      venueName: "Waterfront Park",
      eventName: " Unknown ",
      city: "Brooklyn",
      state: "NY",
      showDate: new Date("2026-08-01T00:00:00.000Z"),
      managerName: null,
    },
    readSetting,
  );

  assert.equal(edmtrain.festival_name, "Summer Sound");
  assert.equal(edmtrain.location, "Queens, NY");
  assert.equal(edmtrain.location_clause, " in Queens, NY");
  assert.equal(manual.festival_name, "Waterfront Park");
  assert.equal(manual.location, "Brooklyn, NY");
  assert.equal(manual.location_clause, " in Brooklyn, NY");
  assert.equal(manual.manager_name, "there");
  assert.doesNotMatch(
    applyTemplate(FESTIVAL_TEMPLATE_SUBJECT, manual),
    /\s{2,}| at $|undefined|null/,
  );
  assert.doesNotMatch(
    applyHtmlTemplate(FESTIVAL_TEMPLATE_HTML, manual),
    /undefined|null|\{\{/,
  );
});

test("festival locations ignore provider sentinels and avoid duplicate punctuation", async () => {
  const readSetting = async () => "";
  const unknownCity = await buildVarsForShow(
    {
      artistName: "Artist",
      venueName: "Festival Grounds",
      eventName: "Summer Sound",
      city: "  UnKnOwN ",
      state: "NY",
      countryName: "United States",
      showDate: new Date("2026-08-01T00:00:00.000Z"),
      managerName: null,
    },
    readSetting,
  );
  const countryOnly = await buildVarsForShow(
    {
      artistName: "Artist",
      venueName: "Festival Grounds",
      eventName: "Summer Sound",
      city: "Unknown",
      state: "unknown",
      countryName: "Canada",
      showDate: new Date("2026-08-01T00:00:00.000Z"),
      managerName: null,
    },
    readSetting,
  );
  const venueOnly = await buildVarsForShow(
    {
      artistName: "Artist",
      venueName: "Festival Grounds",
      eventName: "Summer Sound",
      city: "Unknown",
      state: "TBD",
      countryName: "not available",
      showDate: new Date("2026-08-01T00:00:00.000Z"),
      managerName: null,
    },
    readSetting,
  );
  const manualVenueFallback = await buildVarsForShow(
    {
      artistName: "Artist",
      venueName: "Waterfront Park",
      eventName: null,
      city: " Unknown ",
      state: null,
      countryName: null,
      showDate: new Date("2026-08-01T00:00:00.000Z"),
      managerName: null,
    },
    readSetting,
  );

  assert.equal(unknownCity.location, "NY");
  assert.equal(unknownCity.location_clause, " in NY");
  assert.equal(countryOnly.location, "Canada");
  assert.equal(countryOnly.location_clause, " in Canada");
  assert.equal(venueOnly.location, "Festival Grounds");
  assert.equal(venueOnly.location_clause, " at Festival Grounds");
  assert.equal(manualVenueFallback.location, "Waterfront Park");
  assert.equal(manualVenueFallback.location_clause, "");

  const rendered = applyHtmlTemplate(
    FESTIVAL_TEMPLATE_HTML,
    manualVenueFallback,
  );
  assert.equal(rendered.match(/Waterfront Park/g)?.length, 1);
  assert.match(
    rendered,
    /set at Waterfront Park on Saturday, August 1\.<\/p>/,
  );
  assert.doesNotMatch(rendered, /\bUnknown\b|August 1\s+(?:in|at)\s*[.,<]/i);
});

test("festival selection and variable validation are purpose-aware", () => {
  assert.equal(
    originalTemplatePurposeForShow({ isFestival: true }),
    "festival",
  );
  assert.equal(
    originalTemplatePurposeForShow({ isFestival: false }),
    "original",
  );
  assert.equal(supportedTemplateVars("original").includes("festival_name"), false);
  assert.equal(supportedTemplateVars("festival").includes("festival_name"), true);
  assert.deepEqual(
    unsupportedTemplateVars(
      { subject: "{{artist}} {{festival_name}}", htmlBody: "<p>{{location}}</p>" },
      "original",
    ),
    ["festival_name", "location"],
  );
  assert.deepEqual(
    unsupportedTemplateVars(
      { subject: "{{artist}} {{festival_name}}", htmlBody: "<p>{{location}}</p>" },
      "festival",
    ),
    [],
  );
  assert.deepEqual(
    unsupportedTemplateVars(
      {
        subject: FESTIVAL_TEMPLATE_SUBJECT,
        htmlBody: FESTIVAL_TEMPLATE_HTML,
      },
      "festival",
    ),
    [],
  );
  assert.doesNotMatch(
    `${FESTIVAL_TEMPLATE_SUBJECT} ${FESTIVAL_TEMPLATE_HTML}`,
    /\{\{\s*rate\s*\}\}|\brate card\b|custom price|\$[0-9]/i,
  );
});

test("legacy saved templates and old default content normalize generically", () => {
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

  const oldDefault = DEFAULT_TEMPLATE_HTML
    .replace(
      "Here's a brief summary of my deliverables, and I'm happy to work with you to meet your needs!",
      "Gave a brief summary of my rates/deliverables below, and I'm happy to work with you to meet your needs!",
    )
    .replace(
      "    <p>My minimum deliverables include 25 photos and 3-5 clips night of show; complete gallery with 50+ additional photos and 7-10 additional clips the following day.</p>",
      `    <p>My minimum deliverables include 25 photos and 3-5 clips night of show; complete gallery with 50+ additional photos and 7-10 additional clips the following day.</p>
    <p>My standard {{sender_city}} show rate is {{rate}} for photo/video, or $200 for just photo.</p>`,
    );
  assert.notEqual(oldDefault, DEFAULT_TEMPLATE_HTML);
  assert.match(
    oldDefault,
    /Gave a brief summary of my rates\/deliverables below/,
  );
  assert.match(
    oldDefault,
    /My standard \{\{sender_city\}\} show rate is \{\{rate\}\} for photo\/video, or \$200 for just photo\./,
  );
  const normalized = normalizeTemplateContent({
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
    normalizeTemplateContent({
      subject: "{{artist}}",
      htmlBody: fixedRateDefault,
    }).htmlBody,
    DEFAULT_TEMPLATE_HTML,
  );
  assert.doesNotMatch(DEFAULT_TEMPLATE_HTML, /\{\{\s*rate\s*\}\}|\$[0-9]/i);
});

test("ambiguous rendered rate placement fails closed instead of guessing", () => {
  assert.deepEqual(
    normalizeLegacyOutreachSnapshot({
      subject: "$650Artist",
      html: "<p>Keep me.</p>",
      trustedTemplateSubject: "{{rate}}{{artist}}",
    }),
    {
      outcome: "requires_manual_review",
      subject: "$650Artist",
      html: "<p>Keep me.</p>",
    },
  );
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
    /where: \{ purpose: "follow_up" \}/,
  );
  assert.match(
    source,
    /const original = await ensureDefaultTemplate\(\)[\s\S]*update: \{\},[\s\S]*persistNormalizedTemplate\(template, normalizeTemplateContent\)/,
  );
  assert.match(
    source,
    /name: FOLLOW_UP_TEMPLATE_NAME,[\s\S]*purpose: "follow_up"/,
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
  assert.match(source, /"Normal show outreach"/);
  assert.match(source, /"Festival outreach"/);
  assert.match(source, /"Follow-up"/);
  assert.match(source, /key=\{`\$\{template\.name\}:\$\{template\.updatedAt/);
});
