#!/usr/bin/env bash
set -euo pipefail

policy="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/codex-sandbox.apparmor"
marker="${RUNNER_TEMP:?}/oce-ci-codex-apparmor-loaded"

case "${1:-}" in
  load)
    : "${GITHUB_ENV:?}"
    security_options="$(docker info --format '{{json .SecurityOptions}}')"
    if [[ "$security_options" != *name=apparmor* ]]; then
      printf 'Docker AppArmor is disabled; no CI policy loaded.\n'
      exit 0
    fi
    test ! -e "$marker"
    if ! command -v apparmor_parser >/dev/null 2>&1; then
      sudo apt-get -o Acquire::Retries=3 update
      sudo apt-get -o Acquire::Retries=3 install --no-install-recommends -y apparmor
    fi
    # Add rather than replace: never take ownership of an existing host policy.
    sudo apparmor_parser --add "$policy"
    if ! touch "$marker" || ! printf 'OCC_TEST_CODEX_APPARMOR_PROFILE=oce-ci-codex-sandbox\n' >> "${GITHUB_ENV:?}"; then
      sudo apparmor_parser --remove "$policy"
      rm -f "$marker"
      exit 1
    fi
    docker info --format 'Docker {{.ServerVersion}}, kernel {{.KernelVersion}}, security {{json .SecurityOptions}}'
    ;;
  unload)
    if [[ -e "$marker" ]]; then
      sudo apparmor_parser --remove "$policy"
      rm "$marker"
    fi
    ;;
  *)
    printf 'Usage: %s load|unload\n' "$0" >&2
    exit 2
    ;;
esac
