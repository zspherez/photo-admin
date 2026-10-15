import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  festivalShowTemplateKey,
  parseFestivalShowTemplate,
  validateFestivalShowTemplate,
} from "./festivalShowTemplate";
import { applyHtmlTemplate, applyTemplate, buildVarsForShow } from "./template";

test("festival overrides are scoped to a show and reject corrupt or unsupported saved content", () => {
  assert.notEqual(festivalShowTemplateKey("festival-a"), festivalShowTemplateKey("festival-b"));
  assert.deepEqual(
    parseFestivalShowTemplate(JSON.stringify({
      subject: "  {{artist}} at {{festival_name}} ",
      htmlBody: "<p>Hi from {{sender_name}}</p>",
    })),
    { subject: "{{artist}} at {{festival_name}}", htmlBody: "<p>Hi from {{sender_name}}</p>" },
  );
  for (const value of [
    "not json",
    "null",
    '{"subject":"Hi"}',
    '{"subject":"","htmlBody":"<p>Hello</p>"}',
    '{"subject":"Hi {{unknown}}","htmlBody":"<p>Hello</p>"}',
    '{"subject":"Hi {{manager_name}}","htmlBody":"<p>Hello</p>"}',
    '{"subject":"Hi {{{artist}}}","htmlBody":"<p>Hello</p>"}',
  ]) {
    assert.throws(() => parseFestivalShowTemplate(value));
  }
  assert.throws(
    () => validateFestivalShowTemplate({ subject: "Hi", htmlBody: " " }),
    /subject and body are required/,
  );
});

test("one saved festival template renders each artist separately with supported variables", async () => {
  const template = parseFestivalShowTemplate(JSON.stringify({
    subject: "{{artist}} at {{festival_name}}",
    htmlBody: "<p>Hi from {{sender_name}}, about {{artist}} at {{festival_name}}</p>",
  }));
  const recipients = [
    { artistName: "Artist One & Co", managerName: "Alice & Bob" },
    { artistName: "Artist Two", managerName: "Chris" },
  ];
  const rendered = await Promise.all(recipients.map(async (recipient) => {
    const vars = await buildVarsForShow({
      ...recipient,
      showDate: new Date("2026-10-30T00:00:00Z"),
      venueName: "Park",
      eventName: "Autumn Fest",
    }, async (key) => key === "sender_name" ? "Josh" : "");
    return {
      subject: applyTemplate(template.subject, vars),
      html: applyHtmlTemplate(template.htmlBody, vars),
    };
  }));
  assert.deepEqual(rendered, [
    { subject: "Artist One & Co at Autumn Fest", html: "<p>Hi from Josh, about Artist One &amp; Co at Autumn Fest</p>" },
    { subject: "Artist Two at Autumn Fest", html: "<p>Hi from Josh, about Artist Two at Autumn Fest</p>" },
  ]);
});

test("regular festival paths read the override before rendering, without changing follow-up or retry snapshots", () => {
  const send = readFileSync("lib/sendOutreach.ts", "utf8");
  const original = send.slice(send.indexOf("async function prepareOriginalOutreach"), send.indexOf("async function prepareFollowUpOutreach"));
  const customize = readFileSync("app/dashboard/customize/[showId]/[contactId]/page.tsx", "utf8");
  const festival = readFileSync("app/festivals/[showId]/page.tsx", "utf8");
  assert.match(original, /multiArtistFestival[\s\S]*ensureFestivalMultiArtistTemplate\(\)[\s\S]*ensureOriginalTemplateForShow\(show\)/);
  assert.match(original, /readFestivalShowTemplate\(show, capturedTemplate\.value\)/);
  assert.ok(original.indexOf("readFestivalShowTemplate(show, capturedTemplate.value)") < original.indexOf("buildVarsForShow("));
  assert.match(original, /sendability\.mode === "retry"/);
  assert.match(original, /subject: normalizedSubjectOverride \|\| applyTemplate\(template\.subject, vars\)/);
  assert.match(original, /html: normalizedHtmlOverride[\s\S]*renderTrackedEmailHtml\(\s*template\.htmlBody,\s*vars/);
  assert.match(customize, /readFestivalShowTemplate\(show, capturedTemplate\.value\)/);
  assert.match(customize, /followUpMode\s*\?\s*followUpTemplateContentForShow\(/);
  assert.match(customize, /recipientSnapshotState === "verified"/);
  assert.match(festival, /<FestivalBulkOutreachForm[\s\S]*action=\{bulkSend\}/);
  assert.match(festival, /scheduleFestivalManagerOutreach\([\s\S]*coveredArtistIds: job\.group\.artistIds/);
  assert.doesNotMatch(
    send.slice(send.indexOf("async function prepareFollowUpOutreach"), send.indexOf("async function currentAttempt")),
    /readFestivalShowTemplate/,
  );
});
