#!/usr/bin/env bash
set -euo pipefail

deployment_url="${1:-}"
expected_sha="${2:-}"
if [[ ! "${deployment_url}" =~ ^https://[A-Za-z0-9.-]+/?$ ]]; then
  echo "A valid Vercel deployment URL is required" >&2
  exit 2
fi
if [[ ! "${expected_sha}" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "A full release commit SHA is required" >&2
  exit 2
fi

: "${VERCEL_TOKEN:?VERCEL_TOKEN is required}"
: "${VERCEL_ORG_ID:?VERCEL_ORG_ID is required}"
: "${VERCEL_PROJECT_ID:?VERCEL_PROJECT_ID is required}"

curl_bin="${CURL_BIN:-curl}"
max_attempts="${VERCEL_DEPLOYMENT_VERIFY_MAX_ATTEMPTS:-6}"
retry_delay="${VERCEL_DEPLOYMENT_VERIFY_RETRY_SECONDS:-10}"
if [[ ! "${max_attempts}" =~ ^[1-9][0-9]*$ ]] \
  || [[ ! "${retry_delay}" =~ ^[0-9]+$ ]]; then
  echo "Invalid Vercel deployment verification retry configuration" >&2
  exit 2
fi

deployment_host="${deployment_url#https://}"
deployment_host="${deployment_host%/}"
expected_sha_lower="$(printf '%s' "${expected_sha}" | tr '[:upper:]' '[:lower:]')"
endpoint="https://api.vercel.com/v13/deployments/${deployment_host}?teamId=${VERCEL_ORG_ID}"
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
      --request GET \
      --header "${authorization_header}" \
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
    if parse_result="$(
      printf '%s' "${body}" |
        EXPECTED_SHA="${expected_sha_lower}" \
        EXPECTED_PROJECT_ID="${VERCEL_PROJECT_ID}" \
        node -e '
          let input = "";
          process.stdin.setEncoding("utf8");
          process.stdin.on("data", (chunk) => (input += chunk));
          process.stdin.on("end", () => {
            let deployment;
            try {
              deployment = JSON.parse(input);
            } catch {
              process.exit(12);
            }
            const releaseCommit = deployment.meta?.releaseCommit;
            if (
              deployment.projectId !== process.env.EXPECTED_PROJECT_ID ||
              deployment.target !== "production" ||
              typeof releaseCommit !== "string" ||
              releaseCommit.toLowerCase() !== process.env.EXPECTED_SHA
            ) {
              process.exit(12);
            }
            if (deployment.readyState === "READY") {
              process.stdout.write("ready");
              return;
            }
            if (
              ["ERROR", "CANCELED", "DELETED"].includes(
                deployment.readyState
              )
            ) {
              process.exit(11);
            }
            process.exit(10);
          });
        '
    )"; then
      if [[ "${parse_result}" == "ready" ]]; then
        echo "Verified ready production artifact for the exact release SHA."
        exit 0
      fi
    else
      parse_status=$?
      if (( parse_status == 11 )); then
        echo "Vercel deployment reached a terminal non-ready state." >&2
        exit 1
      fi
      if (( parse_status == 12 )); then
        echo "Vercel deployment identity, target, or release SHA did not match." >&2
        exit 1
      fi
    fi
  else
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
    if [[ "${retryable}" != "true" ]]; then
      echo "Vercel deployment verification failed (curl ${curl_status}, HTTP ${http_status})." >&2
      exit 1
    fi
  fi

  if (( attempt >= max_attempts )); then
    break
  fi
  echo "Vercel deployment is not ready yet; retrying." >&2
  sleep "${retry_delay}"
  attempt=$((attempt + 1))
done

echo "Vercel deployment did not become ready within the verification window." >&2
exit 1
