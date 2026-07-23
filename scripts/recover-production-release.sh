#!/usr/bin/env bash
set -euo pipefail

: "${RELEASE_PAUSE_REQUESTED:=false}"
: "${RELEASE_SCHEMA_STARTED:=false}"
: "${RELEASE_SCHEMA_READY:=false}"
: "${RELEASE_STAGED_VERIFIED:=false}"
: "${RELEASE_TARGET_PROMOTED:=false}"

for value in \
  "${RELEASE_PAUSE_REQUESTED}" \
  "${RELEASE_SCHEMA_STARTED}" \
  "${RELEASE_SCHEMA_READY}" \
  "${RELEASE_STAGED_VERIFIED}" \
  "${RELEASE_TARGET_PROMOTED}"; do
  if [[ "${value}" != "true" && "${value}" != "false" ]]; then
    echo "Invalid release recovery state" >&2
    exit 2
  fi
done

if [[ "${RELEASE_PAUSE_REQUESTED}" != "true" ]]; then
  echo "Release never armed the production pause; no recovery action is needed."
  exit 0
fi

: "${VERCEL_TOKEN:?VERCEL_TOKEN is required}"
: "${VERCEL_ORG_ID:?VERCEL_ORG_ID is required}"
: "${VERCEL_PROJECT_ID:?VERCEL_PROJECT_ID is required}"
: "${EXPECTED_PROJECT_FINGERPRINT:?EXPECTED_PROJECT_FINGERPRINT is required}"

if [[ ! "${VERCEL_ORG_ID}" =~ ^[A-Za-z0-9_-]+$ \
  || ! "${VERCEL_PROJECT_ID}" =~ ^[A-Za-z0-9_-]+$ \
  || ! "${EXPECTED_PROJECT_FINGERPRINT}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "::error::Invalid recovery project identity." >&2
  exit 2
fi

actual_project_fingerprint="$(
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s\n%s\n' "${VERCEL_ORG_ID}" "${VERCEL_PROJECT_ID}" |
      sha256sum |
      cut -d ' ' -f 1
  else
    printf '%s\n%s\n' "${VERCEL_ORG_ID}" "${VERCEL_PROJECT_ID}" |
      shasum -a 256 |
      cut -d ' ' -f 1
  fi
)"
if [[ "${actual_project_fingerprint}" != "${EXPECTED_PROJECT_FINGERPRINT}" ]]; then
  echo "::error::Recovery project fingerprint does not match the sealed production project." >&2
  exit 1
fi

curl_bin="${CURL_BIN:-curl}"
printf -v authorization_header '%s: %s %s' \
  "Authorization" \
  "Bearer" \
  "${VERCEL_TOKEN}"
project_endpoint="https://api.vercel.com/v9/projects/${VERCEL_PROJECT_ID}?teamId=${VERCEL_ORG_ID}"
project_response=""
if project_response="$(
  "${curl_bin}" \
    --silent \
    --show-error \
    --connect-timeout 15 \
    --max-time 60 \
    --request GET \
    --header "${authorization_header}" \
    --write-out $'\n__PHOTO_ADMIN_HTTP_STATUS__:%{http_code}' \
    "${project_endpoint}"
)"; then
  project_curl_status=0
else
  project_curl_status=$?
fi
project_marker="${project_response##*$'\n'}"
if [[ "${project_marker}" == __PHOTO_ADMIN_HTTP_STATUS__:* ]]; then
  project_http_status="${project_marker#*:}"
else
  project_http_status="000"
fi
if (( project_curl_status != 0 )) \
  || [[ ! "${project_http_status}" =~ ^2[0-9]{2}$ ]]; then
  echo "::error::Recovery credentials cannot authenticate the sealed production project (curl ${project_curl_status}, HTTP ${project_http_status})." >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "${RELEASE_SCHEMA_STARTED}" != "true" ]]; then
  echo "Schema cutover did not start; resuming the still-compatible old target."
  bash "${script_dir}/vercel-project-state.sh" unpause
  exit 0
fi

if [[ "${RELEASE_SCHEMA_READY}" != "true" ]]; then
  echo "::error::Schema cutover started but exact-target compatibility was not verified. Production remains paused for visible recovery." >&2
  exit 1
fi
if [[ "${RELEASE_STAGED_VERIFIED}" != "true" ]]; then
  echo "::error::The exact target artifact was not verified before cutover. Production remains paused." >&2
  exit 1
fi
if [[ ! "${RELEASE_TARGET_URL:-}" =~ ^https://[A-Za-z0-9.-]+/?$ ]] \
  || [[ ! "${RELEASE_SHA:-}" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "::error::Exact target recovery coordinates are unavailable. Production remains paused." >&2
  exit 1
fi

vercel_bin="${VERCEL_BIN:-vercel}"
bash "${script_dir}/verify-vercel-deployment.sh" \
  "${RELEASE_TARGET_URL}" \
  "${RELEASE_SHA}"

if [[ "${RELEASE_TARGET_PROMOTED}" == "true" ]]; then
  echo "Reasserting the exact promoted target before recovery resume."
else
  echo "Promoting the already-built exact target before recovery resume."
fi
"${vercel_bin}" promote \
  "${RELEASE_TARGET_URL}" \
  --yes \
  --timeout=5m \
  --token "${VERCEL_TOKEN}"

bash "${script_dir}/verify-vercel-deployment.sh" \
  "${RELEASE_TARGET_URL}" \
  "${RELEASE_SHA}"
bash "${script_dir}/vercel-project-state.sh" unpause
echo "Exact target promotion and production resume are verified."
