#!/usr/bin/env bash
set -euo pipefail

printf 'mock-vercel'
redact_next=false
for argument in "$@"; do
  if [[ "${redact_next}" == "true" ]]; then
    printf ' %q' "[redacted]"
    redact_next=false
    continue
  fi
  printf ' %q' "${argument}"
  if [[ "${argument}" == "--token" ]]; then
    redact_next=true
  fi
done
printf '\n'
exit "${MOCK_VERCEL_EXIT_STATUS:-0}"
