import assert from "node:assert/strict";
import test from "node:test";
import {
  applyHtmlTemplate,
  applyTemplate,
  buildVarsForShow,
  DEFAULT_TEMPLATE_HTML,
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
