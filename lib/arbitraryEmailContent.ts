import { load, type CheerioAPI } from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { appendUtmParametersToHtml } from "@/lib/emailUtm";

const MAX_EMAIL_HTML_LENGTH = 1_000_000;

const REMOVED_TAGS = [
  "script",
  "style",
  "noscript",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "form",
  "input",
  "button",
  "select",
  "option",
  "textarea",
  "video",
  "audio",
  "source",
  "track",
  "canvas",
  "svg",
  "math",
  "template",
  "link",
  "base",
  "meta",
  "title",
] as const;

const ALLOWED_TAGS = new Set([
  "a",
  "address",
  "b",
  "blockquote",
  "br",
  "code",
  "del",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
]);

const SAFE_STYLE_PROPERTIES = new Set([
  "background-color",
  "border",
  "border-bottom",
  "border-bottom-color",
  "border-bottom-style",
  "border-bottom-width",
  "border-collapse",
  "border-color",
  "border-left",
  "border-left-color",
  "border-left-style",
  "border-left-width",
  "border-right",
  "border-right-color",
  "border-right-style",
  "border-right-width",
  "border-spacing",
  "border-style",
  "border-top",
  "border-top-color",
  "border-top-style",
  "border-top-width",
  "border-width",
  "color",
  "display",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "height",
  "letter-spacing",
  "line-height",
  "margin",
  "margin-bottom",
  "margin-left",
  "margin-right",
  "margin-top",
  "max-height",
  "max-width",
  "min-height",
  "min-width",
  "padding",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "padding-top",
  "text-align",
  "text-decoration",
  "text-transform",
  "vertical-align",
  "white-space",
  "width",
]);

const SAFE_DISPLAY_VALUES = new Set([
  "block",
  "inline",
  "inline-block",
  "list-item",
  "table",
  "table-cell",
  "table-row",
]);

const BLOCK_CONTAINER_TAGS = new Set([
  "body",
  "div",
  "ol",
  "table",
  "tbody",
  "tfoot",
  "thead",
  "tr",
  "ul",
]);

const TEXT_BLOCK_TAGS = [
  "address",
  "blockquote",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "pre",
];

export interface NormalizedArbitraryEmailContent {
  html: string;
  text: string;
}

export type NormalizeArbitraryEmailContentResult =
  | { ok: true; content: NormalizedArbitraryEmailContent }
  | { ok: false; error: string };

function looksLikeQuotedPrintableSource(value: string): boolean {
  if (/content-transfer-encoding\s*:\s*quoted-printable/i.test(value)) {
    return true;
  }

  const assignments = value.match(/=3D/gi)?.length ?? 0;
  const encodedBytes = value.match(/=[0-9a-f]{2}/gi)?.length ?? 0;
  const softBreaks = value.match(/=\r?\n/g)?.length ?? 0;
  const encodedUtf8 = /(?:=[c-f][0-9a-f])(?:=[89ab][0-9a-f]){1,3}/i.test(value);
  return (
    (assignments >= 2 && (softBreaks >= 1 || encodedBytes >= 6)) ||
    (softBreaks >= 2 && encodedBytes >= 3) ||
    (assignments >= 1 && encodedUtf8)
  );
}

function sanitizeUrl(value: string, kind: "link" | "image"): string | null {
  const trimmed = value.trim();
  if (
    !trimmed ||
    /[\u0000-\u001f\u007f]/.test(trimmed) ||
    /%(?:0a|0d|00)/i.test(trimmed)
  ) {
    return null;
  }

  if (kind === "link" && trimmed.startsWith("#")) return trimmed;
  if (
    kind === "link" &&
    (/^mailto:[^@\s]+@[^@\s]+$/i.test(trimmed) ||
      /^tel:\+?[0-9().\-\s]{3,}$/i.test(trimmed))
  ) {
    return trimmed;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !url.hostname
  ) {
    return null;
  }
  return url.toString();
}

function isHiddenStyle(style: string): boolean {
  const compact = style.toLowerCase().replace(/\s+/g, "");
  return (
    /(?:^|;)display:none(?:;|$)/.test(compact) ||
    /(?:^|;)visibility:(?:hidden|collapse)(?:;|$)/.test(compact) ||
    /(?:^|;)opacity:0(?:\.0*)?(?:;|$)/.test(compact) ||
    /(?:^|;)mso-hide:all(?:;|$)/.test(compact) ||
    /(?:^|;)color:transparent(?:;|$)/.test(compact) ||
    (/(?:^|;)font-size:0(?:px|pt|em|rem|%)?(?:;|$)/.test(compact) &&
      /(?:^|;)line-height:0(?:px|pt|em|rem|%)?(?:;|$)/.test(compact)) ||
    (/(?:^|;)width:0(?:px|pt|em|rem|%)?(?:;|$)/.test(compact) &&
      /(?:^|;)height:0(?:px|pt|em|rem|%)?(?:;|$)/.test(compact)) ||
    (/max-height:0(?:px|pt|em|rem|%)?/.test(compact) &&
      /overflow:hidden/.test(compact))
  );
}

function sanitizeStyle(style: string): string | null {
  const safe: string[] = [];
  for (const declaration of style.replace(/\/\*[\s\S]*?\*\//g, "").split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 1) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    if (
      !SAFE_STYLE_PROPERTIES.has(property) ||
      !value ||
      value.length > 200 ||
      /[\u0000-\u001f\u007f<>{}\\]/.test(value) ||
      /(?:url\s*\(|expression\s*\(|javascript:|data:|@import|behavior\s*:|-moz-binding)/i.test(
        value,
      )
    ) {
      continue;
    }
    if (
      property === "display" &&
      !SAFE_DISPLAY_VALUES.has(value.toLowerCase())
    ) {
      continue;
    }
    safe.push(`${property}: ${value}`);
  }
  return safe.length > 0 ? safe.join("; ") : null;
}

function safeIntegerAttribute(value: string | undefined): string | null {
  if (!value || !/^\d{1,4}$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return parsed >= 0 && parsed <= 9999 ? String(parsed) : null;
}

function safeSpanAttribute(value: string | undefined): string | null {
  const parsed = safeIntegerAttribute(value);
  return parsed && Number(parsed) >= 1 ? parsed : null;
}

function isTrackingImage(
  attributes: Record<string, string>,
  sanitizedStyle: string | null,
): boolean {
  const width = safeIntegerAttribute(attributes.width);
  const height = safeIntegerAttribute(attributes.height);
  if ((width && Number(width) <= 1) || (height && Number(height) <= 1)) {
    return true;
  }
  const compactStyle = sanitizedStyle?.toLowerCase().replace(/\s+/g, "") ?? "";
  return (
    /(?:^|;)width:(?:0(?:\.\d+)?|1(?:\.0*)?)(?:px|pt)?(?:;|$)/.test(
      compactStyle,
    ) ||
    /(?:^|;)height:(?:0(?:\.\d+)?|1(?:\.0*)?)(?:px|pt)?(?:;|$)/.test(
      compactStyle,
    )
  );
}

function setSafeAttributes($: CheerioAPI, element: Element): void {
  const node = $(element);
  const original = { ...element.attribs };
  const rawStyle = original.style ?? "";
  if (
    "hidden" in original ||
    original["aria-hidden"]?.toLowerCase() === "true" ||
    isHiddenStyle(rawStyle)
  ) {
    node.remove();
    return;
  }

  const sanitizedStyle = sanitizeStyle(rawStyle);
  if (
    element.tagName === "img" &&
    isTrackingImage(original, sanitizedStyle)
  ) {
    node.remove();
    return;
  }

  for (const name of Object.keys(original)) node.removeAttr(name);

  if (sanitizedStyle) node.attr("style", sanitizedStyle);
  if (/^(?:ltr|rtl|auto)$/i.test(original.dir ?? "")) {
    node.attr("dir", original.dir.toLowerCase());
  }
  if (/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(original.lang ?? "")) {
    node.attr("lang", original.lang);
  }

  if (element.tagName === "a") {
    const href = sanitizeUrl(original.href ?? "", "link");
    if (href) {
      node.attr("href", href);
      if (/^https?:/i.test(href)) node.attr("rel", "noopener noreferrer");
    }
    if (original.title?.trim()) node.attr("title", original.title.trim());
    return;
  }

  if (element.tagName === "img") {
    const src = sanitizeUrl(original.src ?? "", "image");
    if (!src) {
      node.remove();
      return;
    }
    node.attr("src", src);
    node.attr("alt", original.alt?.trim() ?? "");
    if (original.title?.trim()) node.attr("title", original.title.trim());
    const width = safeIntegerAttribute(original.width);
    const height = safeIntegerAttribute(original.height);
    if (width) node.attr("width", width);
    if (height) node.attr("height", height);
    return;
  }

  if (element.tagName === "ol") {
    const start = safeIntegerAttribute(original.start);
    if (start && Number(start) >= 1) node.attr("start", start);
  }
  if (element.tagName === "td" || element.tagName === "th") {
    const colspan = safeSpanAttribute(original.colspan);
    const rowspan = safeSpanAttribute(original.rowspan);
    if (colspan) node.attr("colspan", colspan);
    if (rowspan) node.attr("rowspan", rowspan);
  }
  if (["table", "td", "th"].includes(element.tagName)) {
    const width = safeIntegerAttribute(original.width);
    if (width) node.attr("width", width);
  }
  if (
    ["div", "p", "table", "td", "th"].includes(element.tagName) &&
    /^(?:left|right|center|justify)$/i.test(original.align ?? "")
  ) {
    node.attr("align", original.align.toLowerCase());
  }
}

function normalizeTextNodes($: CheerioAPI): void {
  $("body")
    .find("*")
    .addBack()
    .contents()
    .each((_, node: AnyNode) => {
      if (node.type !== "text") return;
      const parent = node.parent;
      if (!parent || parent.type !== "tag") return;
      const parentTag = parent.tagName.toLowerCase();
      if ($(parent).parents("pre, code").length > 0 || parentTag === "pre") return;
      const normalized = node.data.replace(/\s+/g, " ");
      if (!normalized.trim() && BLOCK_CONTAINER_TAGS.has(parentTag)) {
        $(node).remove();
      } else {
        node.data = normalized;
      }
    });
}

function sanitizeDocument(rawHtml: string): CheerioAPI {
  const $ = load(rawHtml);
  $("*")
    .contents()
    .filter((_, node) => node.type === "comment")
    .remove();
  $(REMOVED_TAGS.join(",")).remove();

  const elements = $("body *").toArray().reverse();
  for (const element of elements) {
    if (element.type !== "tag") continue;
    const tagName = element.tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tagName)) {
      $(element).replaceWith($(element).contents());
      continue;
    }
    setSafeAttributes($, element);
  }
  normalizeTextNodes($);
  return $;
}

function canonicalHtml($: CheerioAPI): string {
  const body = $("body").html()?.trim() ?? "";
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "</head>",
    "<body>",
    body,
    "</body>",
    "</html>",
  ].join("\n");
}

function plainTextFromDocument($: CheerioAPI): string {
  const body = $("body").clone();
  body.find("script, style").remove();
  body.find("img").each((_, element) => {
    const alt = $(element).attr("alt")?.trim();
    $(element).replaceWith(alt ?? "");
  });
  body.find("a").each((_, element) => {
    const link = $(element);
    const destination = link.attr("href")?.trim();
    const visible = link.text().trim();
    if (
      destination &&
      visible &&
      destination !== visible &&
      destination.toLowerCase() !== `mailto:${visible}`.toLowerCase()
    ) {
      link.append(` (${destination})`);
    }
  });
  body.find("br").replaceWith("\n");
  body.find("td, th").append("\t");
  body.find("li").each((_, element) => {
    const item = $(element);
    const list = item.parent();
    const depth = Math.max(0, item.parents("ul, ol").length - 1);
    let marker = "•";
    if (list.is("ol")) {
      const start = Number.parseInt(list.attr("start") ?? "1", 10) || 1;
      marker = `${start + item.prevAll("li").length}.`;
    }
    item.prepend(`${"  ".repeat(depth)}${marker} `).append("\n");
  });
  body.find(TEXT_BLOCK_TAGS.join(",")).append("\n\n");
  body.find("tr").append("\n");

  return body
    .text()
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeOnce(rawHtml: string): NormalizedArbitraryEmailContent {
  const document = sanitizeDocument(rawHtml);
  return {
    html: canonicalHtml(document),
    text: plainTextFromDocument(document),
  };
}

export function normalizeArbitraryEmailContent(
  rawHtml: string,
  utmParameters: readonly (readonly [string, string])[] = [],
): NormalizeArbitraryEmailContentResult {
  if (!rawHtml.trim()) return { ok: false, error: "Enter an email body" };
  if (rawHtml.length > MAX_EMAIL_HTML_LENGTH) {
    return { ok: false, error: "Email body is too large" };
  }
  if (rawHtml.includes("\0")) {
    return { ok: false, error: "Email body contains invalid characters" };
  }
  if (looksLikeQuotedPrintableSource(rawHtml)) {
    return {
      ok: false,
      error:
        "Email body appears to be quoted-printable message source. Paste the rendered rich content or decoded HTML instead; MIME encoding is handled by Resend.",
    };
  }

  let normalized: NormalizedArbitraryEmailContent;
  try {
    const sanitized = normalizeOnce(rawHtml);
    const trackedHtml = appendUtmParametersToHtml(
      sanitized.html,
      utmParameters,
    );
    normalized = normalizeOnce(trackedHtml);
  } catch {
    return {
      ok: false,
      error: "Email body could not be parsed and normalized safely",
    };
  }
  if (!normalized.text) {
    return {
      ok: false,
      error: "Email body has no visible, safe content after normalization",
    };
  }
  if (normalized.html.length > MAX_EMAIL_HTML_LENGTH) {
    return { ok: false, error: "Normalized email body is too large" };
  }
  return { ok: true, content: normalized };
}
