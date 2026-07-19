#!/usr/bin/env bash
set -euo pipefail

: "${APP_BASE_URL:?Set APP_BASE_URL to the deployed photo-admin origin}"
if [[ -z "${CONTACT_RESEARCH_AGENT_TOKEN:-}" ]] &&
  [[ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ||
    -z "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]]; then
  echo "Set CONTACT_RESEARCH_AGENT_TOKEN or run with GitHub Actions OIDC" >&2
  exit 2
fi

limit="${CONTACT_RESEARCH_LIMIT:-3}"
if [[ ! "${limit}" =~ ^[1-9][0-9]*$ ]] || (( limit > 10 )); then
  echo "CONTACT_RESEARCH_LIMIT must be an integer from 1 to 10" >&2
  exit 2
fi

mcp_config="$(mktemp)"
cleanup() {
  rm -f "${mcp_config}"
}
trap cleanup EXIT
MCP_CONFIG_PATH="${mcp_config}" node <<'NODE'
const fs = require("node:fs");
const required = (name) => process.env[name] ?? "";
const config = {
  mcpServers: {
    "contact-research": {
      type: "stdio",
      command: process.execPath,
      args: ["scripts/contact-research-mcp.mjs"],
      env: {
        APP_BASE_URL: required("APP_BASE_URL"),
        CONTACT_RESEARCH_AGENT_TOKEN: required(
          "CONTACT_RESEARCH_AGENT_TOKEN"
        ),
        ACTIONS_ID_TOKEN_REQUEST_URL: required(
          "ACTIONS_ID_TOKEN_REQUEST_URL"
        ),
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: required(
          "ACTIONS_ID_TOKEN_REQUEST_TOKEN"
        ),
      },
      tools: ["*"],
    },
  },
};
fs.writeFileSync(process.env.MCP_CONFIG_PATH, JSON.stringify(config), {
  mode: 0o600,
});
NODE

copilot \
  --agent contact-research \
  --additional-mcp-config "@${mcp_config}" \
  --allow-all-tools \
  --allow-all-urls \
  --no-ask-user \
  --no-auto-update \
  --no-remote \
  --prompt \
  "Claim and process up to ${limit} contact research jobs. Follow the agent workflow exactly."
