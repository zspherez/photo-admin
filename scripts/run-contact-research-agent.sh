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

exec copilot \
  --agent contact-research \
  --allow-all-tools \
  --allow-all-urls \
  --no-ask-user \
  --no-auto-update \
  --no-remote \
  --prompt \
  "Claim and process up to ${limit} contact research jobs. Follow the agent workflow exactly."
