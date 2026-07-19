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
broker_metrics="${broker_dir}/metrics.json"
broker_pid=""
broker_privileged=false
broker_running() {
  if [[ "${broker_privileged}" == "true" ]]; then
    sudo -n kill -0 "${broker_pid}" 2>/dev/null
  else
    kill -0 "${broker_pid}" 2>/dev/null
  fi
}
stop_broker() {
  if [[ "${broker_privileged}" == "true" ]]; then
    sudo -n kill "${broker_pid}" 2>/dev/null || true
  else
    kill "${broker_pid}" 2>/dev/null || true
  fi
}
cleanup() {
  if [[ -n "${broker_pid}" ]] && broker_running; then
    stop_broker
    wait "${broker_pid}" 2>/dev/null || true
  fi
  rm -f "${broker_socket}" "${broker_log}" "${broker_metrics}"
  rmdir "${broker_dir}" 2>/dev/null || true
}
trap cleanup EXIT

export CONTACT_RESEARCH_BROKER_SOCKET="${broker_socket}"
export CONTACT_RESEARCH_BROKER_METRICS_FILE="${broker_metrics}"
export PATH="${PWD}/scripts:${PATH}"
if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  broker_privileged=true
  broker_group="$(id -gn)"
  node_bin="$(command -v node)"
  chgrp "${broker_group}" "${broker_dir}"
  chmod 0770 "${broker_dir}"
  sudo -n \
    --preserve-env=APP_BASE_URL,CONTACT_RESEARCH_AGENT_TOKEN,ACTIONS_ID_TOKEN_REQUEST_URL,ACTIONS_ID_TOKEN_REQUEST_TOKEN,CONTACT_RESEARCH_BROKER_SOCKET,CONTACT_RESEARCH_BROKER_METRICS_FILE \
    -u nobody \
    -g "${broker_group}" \
    "${node_bin}" scripts/contact-research-broker.mjs >"${broker_log}" 2>&1 &
else
  node scripts/contact-research-broker.mjs >"${broker_log}" 2>&1 &
fi
broker_pid="$!"

for _ in {1..100}; do
  if [[ -S "${broker_socket}" ]]; then
    break
  fi
  if ! broker_running; then
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

set +e
copilot \
  --agent contact-research \
  --available-tools=bash \
  --allow-tool='shell(contact-research-agent-tool)' \
  --secret-env-vars=GITHUB_TOKEN,ACTIONS_ID_TOKEN_REQUEST_URL,ACTIONS_ID_TOKEN_REQUEST_TOKEN,CONTACT_RESEARCH_AGENT_TOKEN \
  --no-ask-user \
  --no-auto-update \
  --no-remote \
  --prompt \
  "Claim and process up to ${limit} contact research jobs. Follow the agent workflow exactly."
copilot_status="$?"
set -e

if (( copilot_status != 0 )); then
  echo "Copilot research agent exited with status ${copilot_status}" >&2
  exit "${copilot_status}"
fi

if [[ ! -s "${broker_metrics}" ]]; then
  echo "contact research broker did not report tool metrics" >&2
  exit 1
fi
metrics="$(
  node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write([
      value.claimCalls,
      value.claimedJobs,
      value.submissions,
    ].join(" "));
  ' "${broker_metrics}"
)"
read -r claim_calls claimed_jobs submissions <<<"${metrics}"
if (( claim_calls < 1 )); then
  echo "research agent did not call the claim tool" >&2
  exit 1
fi
if (( submissions != claimed_jobs )); then
  echo "research agent completed ${submissions} of ${claimed_jobs} claimed job(s)" >&2
  exit 1
fi
echo "Research agent completed ${submissions} of ${claimed_jobs} claimed job(s)"
