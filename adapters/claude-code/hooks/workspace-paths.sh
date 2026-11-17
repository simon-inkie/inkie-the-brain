#!/usr/bin/env bash
# Read-only fixed-variable shell output. Caller may eval only successful output.
set -eu
foundation_dir="$(cd "$(dirname "$0")" && pwd)"
foundation_helper="$foundation_dir/../workspace-foundation.js"
if [ ! -f "$foundation_helper" ]; then
  printf '%s\n' '[workspace] WORKSPACE_HELPER_MISSING: adjacent foundation bundle required' >&2
  exit 2
fi
exec node "$foundation_helper" paths "$@"
