#!/usr/bin/env bash
set -euo pipefail

deployment_url="${1:-}"
release_sha="${2:-}"
if [[ ! "${deployment_url}" =~ ^https://[A-Za-z0-9-]+\.vercel\.app/?$ ]]; then
  echo "A valid staged Vercel deployment URL is required" >&2
  exit 2
fi
if [[ ! "${release_sha}" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "A full release commit SHA is required" >&2
  exit 2
fi

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${DIRECT_URL:?DIRECT_URL is required}"
: "${APP_BASE_URL:?APP_BASE_URL is required}"
: "${CRON_SECRET:?CRON_SECRET is required}"
: "${VERCEL_TOKEN:?VERCEL_TOKEN is required}"

if [[ ! "${APP_BASE_URL}" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/?$ ]]; then
  echo "APP_BASE_URL must be a production HTTPS origin" >&2
  exit 2
fi

npm_bin="${NPM_BIN:-npm}"
vercel_bin="${VERCEL_BIN:-vercel}"
release_sha_lower="$(printf '%s' "${release_sha}" | tr '[:upper:]' '[:lower:]')"
release_nonce=""
cleanup_required=false

cleanup_marker() {
  if [[ "${cleanup_required}" != "true" ]]; then
    return 0
  fi
  if RELEASE_RUNTIME_VERIFICATION_NONCE="${release_nonce}" \
    "${npm_bin}" --silent run db:release-runtime-verification -- cleanup \
      >/dev/null; then
    cleanup_required=false
    return 0
  fi
  return 1
}

finish() {
  local status=$?
  if (( BASH_SUBSHELL > 0 )); then
    return "${status}"
  fi
  trap - EXIT
  set +e
  if [[ "${cleanup_required}" == "true" ]] && ! cleanup_marker; then
    echo "::error::The expiring release runtime verification marker could not be cleaned." >&2
    if (( status == 0 )); then
      status=1
    fi
  fi
  exit "${status}"
}
trap finish EXIT

release_nonce="$(
  trap - EXIT
  "${npm_bin}" --silent run db:release-runtime-verification -- \
    create "${release_sha}"
)"
if [[ ! "${release_nonce}" =~ ^[A-Za-z0-9_-]{43}$ ]]; then
  echo "::error::The release runtime verification marker could not be prepared." >&2
  exit 1
fi
cleanup_required=true

authorization_header="Authorization: ******"
printf -v authorization_header '%s: %s %s' \
  "Authorization" \
  "Bearer" \
  "${CRON_SECRET}"

response=""
if response="$(
  trap - EXIT
  "${vercel_bin}" curl \
    "/api/release/runtime-verification" \
    --deployment "${deployment_url}" \
    --yes \
    -- \
    --fail-with-body \
    --silent \
    --show-error \
    --connect-timeout 15 \
    --max-time 60 \
    --request GET \
    --header "${authorization_header}" \
    --header "Accept: application/json" \
    --header "X-Photo-Admin-Release-App-Base-URL: ${APP_BASE_URL}" \
    --header "X-Photo-Admin-Release-SHA: ${release_sha}" \
    --write-out $'\n__PHOTO_ADMIN_HTTP_STATUS__:%{http_code}'
)"; then
  curl_status=0
else
  curl_status=$?
fi

marker="${response##*$'\n'}"
if [[ "${marker}" == __PHOTO_ADMIN_HTTP_STATUS__:* ]]; then
  http_status="${marker#*:}"
  body="${response%$'\n'*}"
  body="${body##*$'\n'}"
else
  http_status="000"
  body=""
fi

if (( curl_status != 0 )) || [[ "${http_status}" != "200" ]]; then
  echo "::error::Staged runtime verification request failed (curl ${curl_status}, HTTP ${http_status})." >&2
  exit 1
fi

if ! printf '%s' "${body}" |
  EXPECTED_NONCE="${release_nonce}" \
    EXPECTED_RELEASE_SHA="${release_sha_lower}" \
    node -e '
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => (input += chunk));
      process.stdin.on("end", () => {
        let result;
        try {
          result = JSON.parse(input);
        } catch {
          process.exit(1);
        }
        const keys =
          result && typeof result === "object"
            ? Object.keys(result).sort()
            : [];
        if (
          keys.join(",") !== "expiresAt,nonce,releaseSha,version" ||
          result.version !== 1 ||
          result.nonce !== process.env.EXPECTED_NONCE ||
          result.releaseSha !== process.env.EXPECTED_RELEASE_SHA ||
          !Number.isSafeInteger(result.expiresAt) ||
          result.expiresAt <= Date.now() ||
          result.expiresAt > Date.now() + 15 * 60 * 1000
        ) {
          process.exit(1);
        }
      });
    '; then
  echo "::error::The staged deployment did not return the fresh release runtime verification marker." >&2
  exit 1
fi

if ! cleanup_marker; then
  echo "::error::The verified release runtime marker could not be cleaned before pausing." >&2
  exit 1
fi
trap - EXIT

echo "Verified staged runtime database, APP_BASE_URL, and CRON_SECRET before pausing."
