import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  applyHtmlTemplate,
  applyTemplate,
  buildVarsForShow,
  cloneTemplateContent,
  DEFAULT_TEMPLATE_HTML,
  FOLLOW_UP_TEMPLATE_NAME,
} from "./template";

test("plain substitutions remain unescaped", () => {
  assert.equal(
    applyTemplate("Hi {{name}} — {{missing}}", { name: "A&B <Team>" }),
    "Hi A&B <Team> — "
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

test("show variables use the default rate for null or blank custom prices", async () => {
  const requestedKeys: string[] = [];
  const readSetting = async (key: string, fallback: string) => {
    requestedKeys.push(key);
    return key === "default_rate" ? " $400 " : fallback;
  };
  const baseContext = {
    artistName: "Artist",
    venueName: "Venue",
    showDate: new Date("2026-08-01T00:00:00.000Z"),
    managerName: null,
  };

  const nullPrice = await buildVarsForShow(
    { ...baseContext, customPrice: null },
    readSetting,
  );
  const blankPrice = await buildVarsForShow(
    { ...baseContext, customPrice: "   " },
    readSetting,
  );

  assert.equal(nullPrice.rate, "$400");
  assert.equal(blankPrice.rate, "$400");
  assert.ok(requestedKeys.includes("default_rate"));
});

test("the default template uses the built-in rate fallback", async () => {
  const vars = await buildVarsForShow(
    {
      artistName: "Artist",
      venueName: "Venue",
      showDate: new Date("2026-08-01T00:00:00.000Z"),
      customPrice: null,
      managerName: null,
    },
    async (_key, fallback) => fallback,
  );

  assert.equal(vars.rate, "$400");
  assert.match(DEFAULT_TEMPLATE_HTML, /\{\{rate\}\}/);
});

test("a nonblank custom price wins over the default rate", async () => {
  const vars = await buildVarsForShow(
    {
      artistName: "Artist",
      venueName: "Venue",
      showDate: new Date("2026-08-01T00:00:00.000Z"),
      customPrice: "  $650  ",
      managerName: "Manager",
    },
    async (key, fallback) => key === "default_rate" ? "$400" : fallback,
  );

  assert.equal(vars.rate, "$650");
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
    /if \(existing\) return existing;[\s\S]*const original = await ensureDefaultTemplate\(\)/,
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
