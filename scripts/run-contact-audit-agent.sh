#!/usr/bin/env bash
set -euo pipefail

: "${APP_BASE_URL:?Set APP_BASE_URL to the deployed photo-admin origin}"
if [[ -z "${CONTACT_AUDIT_AGENT_TOKEN:-}" ]] &&
  [[ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ||
    -z "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]]; then
  echo "Set CONTACT_AUDIT_AGENT_TOKEN or run with GitHub Actions OIDC" >&2
  exit 2
fi

workers="${CONTACT_AUDIT_WORKERS:-4}"
if [[ ! "${workers}" =~ ^[1-9][0-9]*$ ]] || (( workers > 10 )); then
  echo "CONTACT_AUDIT_WORKERS must be an integer from 1 to 10" >&2
  exit 2
fi

runtime_dir="${PWD}/.ca-run-${GITHUB_RUN_ID:-local}-$$"
mkdir -p "${runtime_dir}"
broker_socket="${runtime_dir}/broker.sock"
broker_log="${runtime_dir}/broker.log"
broker_metrics="${runtime_dir}/metrics.json"
broker_pid=""
broker_running() {
  kill -0 "${broker_pid}" 2>/dev/null
}
cleanup() {
  if [[ -n "${broker_pid}" ]] && broker_running; then
    kill "${broker_pid}" 2>/dev/null || true
    wait "${broker_pid}" 2>/dev/null || true
  fi
  rm -rf "${runtime_dir}"
}
trap cleanup EXIT

export CONTACT_AUDIT_BROKER_SOCKET="${broker_socket}"
export CONTACT_AUDIT_BROKER_METRICS_FILE="${broker_metrics}"
export CONTACT_AGENT_BROKER_METRICS_FILE="${broker_metrics}"
export CONTACT_RESEARCH_AGENT_NAME="contact-audit"
export CONTACT_RESEARCH_AGENT_TOOL="contact-audit-agent-tool"
export PATH="${PWD}/scripts:${PATH}"
node scripts/contact-audit-broker.mjs >"${broker_log}" 2>&1 &
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
  echo "contact audit broker did not start" >&2
  cat "${broker_log}" >&2
  exit 1
fi

session_state() {
  node -e '
    const fs = require("node:fs");
    const metrics = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const state = metrics.sessions?.[process.argv[2]] ?? {};
    process.stdout.write([
      state.claimed === true ? 1 : 0,
      state.completed === true ? 1 : 0,
      state.empty === true ? 1 : 0,
      state.stale === true ? 1 : 0,
    ].join(" "));
  ' "${broker_metrics}" "$1"
}

worker_loop() {
  local worker_id="$1"
  local completed=0
  local usage_dir="${CONTACT_AUDIT_USAGE_DIR:-}"
  if [[ -n "${usage_dir}" ]]; then
    mkdir -p "${usage_dir}"
    local lane="${CONTACT_AUDIT_LANE:-local}"
    export CONTACT_AGENT_USAGE_FILE="${usage_dir}/lane-${lane}-worker-${worker_id}.jsonl"
  fi

  while true; do
    export CONTACT_AUDIT_AGENT_SESSION="worker-${worker_id}-$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
    export CONTACT_AGENT_SESSION="${CONTACT_AUDIT_AGENT_SESSION}"
    local claim_json
    claim_json="$(contact-audit-agent-tool claim 1)"
    local job_json
    job_json="$(
      CLAIM_JSON="${claim_json}" node -e '
        const value = JSON.parse(process.env.CLAIM_JSON);
        if (!Array.isArray(value.jobs) || value.jobs.length === 0) {
          process.exit(10);
        }
        process.stdout.write(JSON.stringify(value.jobs[0]));
      '
    )" || {
      local parse_status="$?"
      if (( parse_status == 10 )); then
        printf '%s\n' "${completed}" >"${runtime_dir}/worker-${worker_id}.count"
        return 0
      fi
      return "${parse_status}"
    }

    set +e
    node scripts/run-contact-research-copilot.mjs \
      "Complete this already-claimed contact audit job: ${job_json}. Review every contactRoster entry, identify the isTarget contact, and inventory every rosterEntryId in rosterReview. Existing roster contacts are stored context, never new alternatives. Use the top-level jobId and submit exactly one review-only result. Do not call claim. Invoke only direct contact-audit-agent-tool commands: no cd, files, cat, printf, Python, pipes, redirection, command substitution, or combined shell commands. Pass the final JSON inline to validate-result and submit-result."
    local copilot_status="$?"
    set -e

    read -r claimed submitted empty stale <<<"$(session_state "${CONTACT_AUDIT_AGENT_SESSION}")"
    if (( stale == 1 )); then
      continue
    fi
    if (( copilot_status != 0 )); then
      echo "Worker ${worker_id} Copilot session exited with status ${copilot_status}" >&2
      return "${copilot_status}"
    fi
    if (( empty != 0 || claimed != 1 || submitted != 1 )); then
      echo "Worker ${worker_id} did not complete its claimed contact audit" >&2
      return 1
    fi
    completed=$((completed + 1))
  done
}

pids=()
for (( worker = 1; worker <= workers; worker += 1 )); do
  worker_loop "${worker}" &
  pids+=("$!")
done

failed=0
for pid in "${pids[@]}"; do
  if ! wait "${pid}"; then
    failed=1
  fi
done
if (( failed != 0 )); then
  exit 1
fi

completed=0
for count_file in "${runtime_dir}"/worker-*.count; do
  [[ -f "${count_file}" ]] || continue
  completed=$((completed + $(<"${count_file}")))
done
echo "Contact audit agent pool completed ${completed} job(s)"
