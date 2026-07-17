#!/usr/bin/env bash
set -euo pipefail

: "${MOCK_RELEASE_NONCE:?MOCK_RELEASE_NONCE is required}"
: "${MOCK_RELEASE_STATE_FILE:?MOCK_RELEASE_STATE_FILE is required}"

command_line=" $* "
if [[ "${command_line}" == *" create "* ]]; then
  printf 'create\n' >>"${MOCK_RELEASE_STATE_FILE}"
  printf '%s' "${MOCK_RELEASE_NONCE}"
  exit "${MOCK_RELEASE_CREATE_STATUS:-0}"
fi

if [[ "${command_line}" == *" cleanup "* ]]; then
  printf 'cleanup\n' >>"${MOCK_RELEASE_STATE_FILE}"
  if [[ "${RELEASE_RUNTIME_VERIFICATION_NONCE:-}" != "${MOCK_RELEASE_NONCE}" ]]; then
    echo "cleanup received the wrong marker" >&2
    exit 2
  fi
  exit "${MOCK_RELEASE_CLEANUP_STATUS:-0}"
fi

echo "unexpected npm invocation" >&2
exit 2
