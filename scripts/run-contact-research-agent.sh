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
broker_running() {
  kill -0 "${broker_pid}" 2>/dev/null
}
cleanup() {
  if [[ -n "${broker_pid}" ]] && broker_running; then
    kill "${broker_pid}" 2>/dev/null || true
    wait "${broker_pid}" 2>/dev/null || true
  fi
  rm -f "${broker_socket}" "${broker_log}" "${broker_metrics}"
  rmdir "${broker_dir}" 2>/dev/null || true
}
trap cleanup EXIT

export CONTACT_RESEARCH_BROKER_SOCKET="${broker_socket}"
export CONTACT_RESEARCH_BROKER_METRICS_FILE="${broker_metrics}"
export PATH="${PWD}/scripts:${PATH}"
node scripts/contact-research-broker.mjs >"${broker_log}" 2>&1 &
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

read_metrics() {
  if [[ ! -s "${broker_metrics}" ]]; then
    echo "0 0 0"
    return
  fi
  node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write([
      value.claimCalls,
      value.claimedJobs,
      value.submissions,
    ].join(" "));
  ' "${broker_metrics}"
}

completed=0
for (( index = 1; index <= limit; index += 1 )); do
  read -r before_claims before_jobs before_submissions <<<"$(read_metrics)"
  export CONTACT_RESEARCH_AGENT_SESSION="job-${index}-$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"

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
    "Claim exactly one contact research job and complete it. Use the top-level jobId, never an artist ID. Do not call claim more than once."
  copilot_status="$?"
  set -e

  if (( copilot_status != 0 )); then
    echo "Copilot research agent exited with status ${copilot_status}" >&2
    exit "${copilot_status}"
  fi

  read -r after_claims after_jobs after_submissions <<<"$(read_metrics)"
  claim_delta=$((after_claims - before_claims))
  job_delta=$((after_jobs - before_jobs))
  submission_delta=$((after_submissions - before_submissions))
  if (( claim_delta != 1 )); then
    echo "research session made ${claim_delta} successful claim calls instead of 1" >&2
    exit 1
  fi
  if (( job_delta == 0 )); then
    if (( submission_delta != 0 )); then
      echo "empty research session unexpectedly submitted a result" >&2
      exit 1
    fi
    break
  fi
  if (( job_delta != 1 || submission_delta != 1 )); then
    echo "research session completed ${submission_delta} of ${job_delta} claimed job(s)" >&2
    exit 1
  fi
  completed=$((completed + 1))
done

echo "Research agent completed ${completed} job(s)"
