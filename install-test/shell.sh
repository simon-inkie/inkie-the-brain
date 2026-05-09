#!/usr/bin/env bash
# Boot the install-test container with an interactive bash shell instead of
# running the L1-L4 checks. Use when something fails and you want to poke at
# the env directly.
#
# Inside the container: cd /workspace, then `pnpm install`, `pnpm build`,
# `bash /opt/install-test/checks/01-build-clean.sh` (etc) to run individual
# checks against the live env.

set -euo pipefail

cd "$(dirname "$0")/.."

docker compose -f install-test/docker-compose.yml run --rm \
  -e GEMINI_API_KEY="${GEMINI_API_KEY:-}" \
  test-runner bash
