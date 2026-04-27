#!/bin/bash
# the-brain MCP server entry.
# Resolves node at runtime so the launcher works across nvm version switches.

set -u

BRAIN_ROOT="$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")/.." && pwd)"

# Prefer node on PATH; fall back to nvm-managed binaries; fall back to /usr/bin.
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [[ -x "$HOME/.nvm/versions/node/$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin/node" ]]; then
  NODE_BIN="$HOME/.nvm/versions/node/$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin/node"
elif [[ -x /usr/bin/node ]]; then
  NODE_BIN=/usr/bin/node
else
  echo "mcp-server.sh: cannot find a node binary" >&2
  exit 1
fi

cd "$BRAIN_ROOT"
exec "$NODE_BIN" --import tsx/esm mcp/server.ts
