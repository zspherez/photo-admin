#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${MOCK_CURL_EXPECT_AUTHORIZATION_HEADER:-}" ]]; then
  authorization_header=""
  previous_argument=""
  for argument in "$@"; do
    if [[ "${previous_argument}" == "--header" \
      && "${argument}" == Authorization:* ]]; then
      authorization_header="${argument}"
    fi
    previous_argument="${argument}"
  done
  if [[ "${authorization_header}" != "${MOCK_CURL_EXPECT_AUTHORIZATION_HEADER}" ]]; then
    printf '%s\n__PHOTO_ADMIN_HTTP_STATUS__:403' \
      '{"error":"invalid recovery credentials"}'
    exit 0
  fi
fi

if [[ -n "${MOCK_CURL_RESPONSES_FILE:-}" ]]; then
  if [[ -z "${MOCK_CURL_STATE_FILE:-}" ]]; then
    echo "MOCK_CURL_STATE_FILE is required for sequenced responses" >&2
    exit 2
  fi
  call=0
  if [[ -f "${MOCK_CURL_STATE_FILE}" ]]; then
    call="$(<"${MOCK_CURL_STATE_FILE}")"
  fi
  call=$((call + 1))
  printf '%s\n' "${call}" >"${MOCK_CURL_STATE_FILE}"
  response="$(sed -n "${call}p" "${MOCK_CURL_RESPONSES_FILE}")"
  if [[ -z "${response}" ]]; then
    echo "No mock curl response configured for call ${call}" >&2
    exit 2
  fi
  IFS=$'\t' read -r exit_status http_status body <<<"${response}"
  printf '%s\n__PHOTO_ADMIN_HTTP_STATUS__:%s' "${body}" "${http_status}"
  exit "${exit_status}"
fi

printf '%s\n__PHOTO_ADMIN_HTTP_STATUS__:%s' \
  "${MOCK_CURL_BODY:-}" \
  "${MOCK_CURL_HTTP_STATUS:-200}"
exit "${MOCK_CURL_EXIT_STATUS:-0}"
