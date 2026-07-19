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

broker_dir="$(mktemp -d)"
broker_socket="${broker_dir}/broker.sock"
broker_log="${broker_dir}/broker.log"
broker_pid=""
cleanup() {
  if [[ -n "${broker_pid}" ]] && kill -0 "${broker_pid}" 2>/dev/null; then
    kill "${broker_pid}" 2>/dev/null || true
    wait "${broker_pid}" 2>/dev/null || true
  fi
  rm -f "${broker_socket}" "${broker_log}"
  rmdir "${broker_dir}" 2>/dev/null || true
}
trap cleanup EXIT

export CONTACT_RESEARCH_BROKER_SOCKET="${broker_socket}"
node scripts/contact-research-broker.mjs >"${broker_log}" 2>&1 &
broker_pid="$!"

for _ in {1..100}; do
  if [[ -S "${broker_socket}" ]]; then
    break
  fi
  if ! kill -0 "${broker_pid}" 2>/dev/null; then
    cat "${broker_log}" >&2
    exit 1
  fi
  sleep 0.1
done
if [[ ! -S "${broker_socket}" ]]; then
  echo "contact research broker did not start" >&2
  cat "${broker_log}" >&2
  exit 1
fi

copilot \
  --agent contact-research \
  --available-tools=bash \
  --allow-tool='shell(scripts/contact-research-agent-tool.mjs:*)' \
  --secret-env-vars=GITHUB_TOKEN,ACTIONS_ID_TOKEN_REQUEST_URL,ACTIONS_ID_TOKEN_REQUEST_TOKEN,CONTACT_RESEARCH_AGENT_TOKEN \
  --no-ask-user \
  --no-auto-update \
  --no-remote \
  --prompt \
  "Claim and process up to ${limit} contact research jobs. Follow the agent workflow exactly."
