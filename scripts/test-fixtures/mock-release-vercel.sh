#!/usr/bin/env bash
set -euo pipefail

authorization_header=""
app_base_url_header=""
release_sha_header=""
deployment=""
token=""
previous_argument=""
state_file="${MOCK_RUNTIME_STATE_FILE:-}"
request_number=1
if [[ -n "${state_file}" && -f "${state_file}" ]]; then
  request_number="$(( $(cat "${state_file}") + 1 ))"
fi
if [[ -n "${state_file}" ]]; then
  printf '%s' "${request_number}" > "${state_file}"
fi
for argument in "$@"; do
  if [[ "${previous_argument}" == "--header" ]]; then
    case "${argument}" in
      Authorization:*) authorization_header="${argument}" ;;
      X-Photo-Admin-Release-App-Base-URL:*) app_base_url_header="${argument}" ;;
      X-Photo-Admin-Release-SHA:*) release_sha_header="${argument}" ;;
    esac
  elif [[ "${previous_argument}" == "--deployment" ]]; then
    deployment="${argument}"
  elif [[ "${previous_argument}" == "--token" ]]; then
    token="${argument}"
  fi
  previous_argument="${argument}"
done

if [[ "${authorization_header}" != "${MOCK_EXPECT_AUTHORIZATION_HEADER:-}" \
  || "${app_base_url_header}" != "${MOCK_EXPECT_APP_BASE_URL_HEADER:-}" \
  || "${release_sha_header}" != "${MOCK_EXPECT_RELEASE_SHA_HEADER:-}" \
  || "${deployment}" != "${MOCK_EXPECT_DEPLOYMENT:-}" \
  || -n "${token}" \
  || "${VERCEL_TOKEN:-}" != "${MOCK_EXPECT_VERCEL_TOKEN:-}" ]]; then
  printf '%s\n__PHOTO_ADMIN_HTTP_STATUS__:403' \
    '{"error":"invalid mock staged request"}'
  exit 0
fi

http_status="${MOCK_RUNTIME_HTTP_STATUS:-200}"
curl_status="${MOCK_RUNTIME_CURL_STATUS:-0}"
if [[ -n "${MOCK_RUNTIME_HTTP_SEQUENCE:-}" ]]; then
  IFS=',' read -r -a statuses <<<"${MOCK_RUNTIME_HTTP_SEQUENCE}"
  index=$((request_number - 1))
  if (( index >= ${#statuses[@]} )); then
    index=$((${#statuses[@]} - 1))
  fi
  http_status="${statuses[${index}]}"
  if [[ "${http_status}" != "200" ]]; then
    curl_status=22
  fi
fi

printf '%s\n__PHOTO_ADMIN_HTTP_STATUS__:%s' \
  "${MOCK_RUNTIME_BODY:-}" \
  "${http_status}"
exit "${curl_status}"
