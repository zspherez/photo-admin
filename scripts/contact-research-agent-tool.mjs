#!/usr/bin/env node

import { request } from "node:http";

const socketPath = process.env.CONTACT_RESEARCH_BROKER_SOCKET?.trim();
const sessionId = process.env.CONTACT_RESEARCH_AGENT_SESSION?.trim();

if (!socketPath || !sessionId) {
  throw new Error("contact research broker is not configured");
}

const [action, first, second] = process.argv.slice(2);
let input;
switch (action) {
  case "claim":
    input = { limit: Number(first ?? "3") };
    break;
  case "search":
    input = { query: first ?? "", limit: Number(second ?? "8") };
    break;
  case "fetch":
    input = { url: first ?? "" };
    break;
  case "known-contacts":
    try {
      input = JSON.parse(first ?? "");
    } catch {
      throw new Error("known-contacts requires one valid JSON argument");
    }
    break;
  case "validate-result":
    try {
      input = {
        action: first,
        payload: JSON.parse(second ?? ""),
      };
    } catch {
      throw new Error(
        "validate-result requires a submit action and one valid JSON argument"
      );
    }
    break;
  case "submit-candidates":
  case "submit-direct-outreach":
  case "submit-exhausted":
  case "submit-skipped":
    try {
      input = JSON.parse(first ?? "");
    } catch {
      throw new Error(`${action} requires one valid JSON argument`);
    }
    break;
  default:
    throw new Error(
      "usage: claim [limit] | search <query> [limit] | fetch <url> | known-contacts <json> | validate-result <submit-action> <json> | submit-candidates <json> | submit-direct-outreach <json> | submit-exhausted <json> | submit-skipped <json>"
    );
}

const payload = JSON.stringify(input);
const result = await new Promise((resolve, reject) => {
  const brokerRequest = request(
    {
      socketPath,
      path: `/${action}`,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
        "x-contact-research-session": sessionId,
      },
      timeout: 130_000,
    },
    (response) => {
      const chunks = [];
      let total = 0;
      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > 2_000_000) {
          response.destroy(new Error("broker response is too large"));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 500,
          text: Buffer.concat(chunks).toString("utf8"),
        });
      });
    }
  );
  brokerRequest.on("timeout", () => {
    brokerRequest.destroy(new Error("contact research broker timed out"));
  });
  brokerRequest.on("error", reject);
  brokerRequest.end(payload);
});
if (result.status < 200 || result.status >= 300) {
  throw new Error(
    `contact research tool returned ${result.status}: ${result.text.slice(0, 1_000)}`
  );
}
const value = result.text ? JSON.parse(result.text) : {};
process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
