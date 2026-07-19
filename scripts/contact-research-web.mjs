import * as cheerio from "cheerio";
import ipaddr from "ipaddr.js";

const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 15_000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; PhotoAdminContactResearch/1.0; +https://admin.rehders.photos)";

export function isPrivateNetworkAddress(address) {
  try {
    let parsed = ipaddr.parse(address.replace(/^\[|\]$/g, ""));
    if (
      parsed.kind() === "ipv6" &&
      parsed.isIPv4MappedAddress()
    ) {
      parsed = parsed.toIPv4Address();
    }
    return parsed.range() !== "unicast";
  } catch {
    return true;
  }
}

export async function assertPublicHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("URL is invalid");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error("URL must be public HTTP(S)");
  }
  const hostname = url.hostname.toLowerCase();
  const addressLiteral = hostname.replace(/^\[|\]$/g, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("Private network URLs are not allowed");
  }
  if (
    ipaddr.isValid(addressLiteral) &&
    isPrivateNetworkAddress(addressLiteral)
  ) {
    throw new Error("Private network URLs are not allowed");
  }
  url.hash = "";
  return url;
}

async function readBoundedText(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_RESPONSE_BYTES
  ) {
    throw new Error("Response is too large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Response is too large");
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

async function fetchFixedHostText(value, hostname, options = {}) {
  let url = new URL(value);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (url.protocol !== "https:" || url.hostname !== hostname) {
      throw new Error("Research service redirected unexpectedly");
    }
    const response = await fetch(url, {
      headers: {
        accept: options.accept ?? "text/html,application/xhtml+xml",
        "user-agent": USER_AGENT,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(
        options.timeoutMs ?? REQUEST_TIMEOUT_MS
      ),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirects === MAX_REDIRECTS) {
        throw new Error("Redirect could not be followed safely");
      }
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) {
      throw new Error(`Public page returned ${response.status}`);
    }
    return {
      url: url.toString(),
      contentType: response.headers.get("content-type") ?? "",
      text: await readBoundedText(response),
    };
  }
  throw new Error("Redirect limit exceeded");
}

function decodedDuckDuckGoUrl(value) {
  const absolute = value.startsWith("//") ? `https:${value}` : value;
  try {
    const url = new URL(absolute, "https://duckduckgo.com");
    return url.searchParams.get("uddg") ?? url.toString();
  } catch {
    return absolute;
  }
}

export function parseDuckDuckGoResults(html, limit = 8) {
  const $ = cheerio.load(html);
  return $(".result")
    .toArray()
    .flatMap((element) => {
      const result = $(element);
      const anchor = result.find(".result__a").first();
      const title = anchor.text().replace(/\s+/g, " ").trim();
      const href = anchor.attr("href");
      if (!title || !href) return [];
      const snippet = result
        .find(".result__snippet")
        .first()
        .text()
        .replace(/\s+/g, " ")
        .trim();
      return [
        {
          title,
          url: decodedDuckDuckGoUrl(href),
          snippet,
        },
      ];
    })
    .slice(0, limit);
}

export async function searchWeb(query, limit = 8) {
  const searchUrl = new URL("https://html.duckduckgo.com/html/");
  searchUrl.searchParams.set("q", query);
  const response = await fetchFixedHostText(
    searchUrl.toString(),
    "html.duckduckgo.com"
  );
  const results = parseDuckDuckGoResults(response.text, limit);
  if (results.length === 0) throw new Error("Web search returned no results");
  return results;
}

export function extractReadablePage(html, pageUrl) {
  const $ = cheerio.load(html);
  $("script,style,noscript,svg,canvas,template").remove();
  const title = $("title").first().text().replace(/\s+/g, " ").trim();
  const root = $("body");
  root
    .find("address,article,aside,blockquote,br,div,footer,h1,h2,h3,h4,h5,h6,header,li,main,nav,p,section,tr")
    .each((_, element) => {
      $(element).append(" ");
    });
  const text = root.text().replace(/\s+/g, " ").trim().slice(0, 20_000);
  const emails = new Set(
    root
      .text()
      .match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []
  );
  const links = Array.from(
    new Map(
      $("a[href]")
        .toArray()
        .flatMap((element) => {
          const anchor = $(element);
          const label = anchor.text().replace(/\s+/g, " ").trim();
          const href = anchor.attr("href");
          if (!href) return [];
          try {
            const url = new URL(href, pageUrl);
            if (url.protocol === "mailto:") {
              const email = decodeURIComponent(url.pathname)
                .split(",")[0]
                .trim()
                .toLowerCase();
              if (email) emails.add(email);
              return [[
                `mailto:${email}`,
                { label, url: `mailto:${email}` },
              ]];
            }
            if (!["http:", "https:"].includes(url.protocol)) return [];
            url.hash = "";
            return [[url.toString(), { label, url: url.toString() }]];
          } catch {
            return [];
          }
        })
    ).values()
  ).slice(0, 50);
  return { title, text, emails: [...emails], links };
}

export function extractReaderPage(markdown, pageUrl) {
  const title =
    markdown.match(/^Title:\s*(.+)$/im)?.[1]?.trim() ?? "";
  const emails = Array.from(
    new Set(
      markdown.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []
    )
  );
  const links = Array.from(
    new Map(
      Array.from(
        markdown.matchAll(/\[([^\]]*)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g)
      ).flatMap((match) => {
        const label = match[1].replace(/\s+/g, " ").trim();
        const value = match[2];
        if (value.startsWith("mailto:")) {
          const email = value.slice("mailto:".length).split("?")[0].toLowerCase();
          if (email) emails.push(email);
          return [[`mailto:${email}`, { label, url: `mailto:${email}` }]];
        }
        try {
          const url = new URL(value, pageUrl);
          url.hash = "";
          return [[url.toString(), { label, url: url.toString() }]];
        } catch {
          return [];
        }
      })
    ).values()
  ).slice(0, 50);
  return {
    title,
    text: markdown.replace(/\s+/g, " ").trim().slice(0, 20_000),
    emails: Array.from(new Set(emails.map((email) => email.toLowerCase()))),
    links,
  };
}

export async function fetchReadablePage(value) {
  const target = await assertPublicHttpUrl(value);
  const readerUrl = `https://r.jina.ai/${target.toString()}`;
  const response = await fetchFixedHostText(readerUrl, "r.jina.ai", {
    accept: "text/plain,text/markdown",
    timeoutMs: 30_000,
  });
  return {
    url: target.toString(),
    ...extractReaderPage(response.text, target.toString()),
  };
}
