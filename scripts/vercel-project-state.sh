#!/usr/bin/env bash
set -euo pipefail

operation="${1:-}"
case "${operation}" in
  pause|unpause) ;;
  *)
    echo "Usage: scripts/vercel-project-state.sh pause|unpause" >&2
    exit 2
    ;;
esac

: "${VERCEL_TOKEN:?VERCEL_TOKEN is required}"
: "${VERCEL_ORG_ID:?VERCEL_ORG_ID is required}"
: "${VERCEL_PROJECT_ID:?VERCEL_PROJECT_ID is required}"

curl_bin="${CURL_BIN:-curl}"
max_attempts="${VERCEL_STATE_MAX_ATTEMPTS:-3}"
retry_delay="${VERCEL_STATE_RETRY_DELAY_SECONDS:-5}"
if [[ ! "${max_attempts}" =~ ^[1-9][0-9]*$ ]] \
  || [[ ! "${retry_delay}" =~ ^[0-9]+$ ]]; then
  echo "Invalid Vercel state retry configuration" >&2
  exit 2
fi

endpoint="https://api.vercel.com/v1/projects/${VERCEL_PROJECT_ID}/${operation}?teamId=${VERCEL_ORG_ID}"
printf -v authorization_header '%s: %s %s' \
  "Authorization" \
  "Bearer" \
  "${VERCEL_TOKEN}"
attempt=1
while (( attempt <= max_attempts )); do
  response=""
  if response="$(
    "${curl_bin}" \
      --silent \
      --show-error \
      --connect-timeout 15 \
      --max-time 60 \
      --request POST \
      --header "${authorization_header}" \
      --header "Content-Type: application/json" \
      --write-out $'\n__PHOTO_ADMIN_HTTP_STATUS__:%{http_code}' \
      "${endpoint}"
  )"; then
    curl_status=0
  else
    curl_status=$?
  fi

  marker="${response##*$'\n'}"
  if [[ "${marker}" == __PHOTO_ADMIN_HTTP_STATUS__:* ]]; then
    http_status="${marker#*:}"
    body="${response%$'\n'*}"
  else
    http_status="000"
    body="${response}"
  fi

  if (( curl_status == 0 )) && [[ "${http_status}" =~ ^2[0-9]{2}$ ]]; then
    echo "Vercel project ${operation} request succeeded."
    exit 0
  fi

  body_lower="$(printf '%s' "${body}" | tr '[:upper:]' '[:lower:]')"
  if [[ "${operation}" == "pause" ]] \
    && [[ "${http_status}" == "400" || "${http_status}" == "409" ]] \
    && [[ "${body_lower}" =~ already[[:space:]_-]*paused|currently[[:space:]_-]*paused ]]; then
    echo "Vercel project is already paused."
    exit 0
  fi
  if [[ "${operation}" == "unpause" ]] \
    && [[ "${http_status}" == "400" || "${http_status}" == "409" ]] \
    && [[ "${body_lower}" =~ not([[:space:]_-]+currently)?[[:space:]_-]*paused|already[[:space:]_-]*(unpaused|running|active) ]]; then
    echo "Vercel project is already running."
    exit 0
  fi

  retryable=false
  if (( curl_status != 0 )); then
    case "${curl_status}" in
      6|7|18|28|35|52|55|56|92) retryable=true ;;
    esac
  else
    case "${http_status}" in
      408|425|429|500|502|503|504) retryable=true ;;
    esac
  fi

  if [[ "${retryable}" != "true" ]] || (( attempt >= max_attempts )); then
    echo "Vercel project ${operation} request failed (curl ${curl_status}, HTTP ${http_status})." >&2
    exit 1
  fi

  echo "Vercel project ${operation} attempt ${attempt} failed transiently; retrying." >&2
  sleep "${retry_delay}"
  attempt=$((attempt + 1))
done
