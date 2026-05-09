#!/usr/bin/env bash
# L2 — services up: Qdrant reachable, MCP server boots and responds to
# tools/list, hook scripts have correct shebangs.
#
# Verifies the install can talk to its dependencies and the entry-point
# scripts are well-formed. No real data flows yet — that's L3/L4.

set -euo pipefail

cd /workspace

echo "  qdrant healthz"
if ! curl -sf "${QDRANT_URL}/healthz" >/dev/null; then
  echo "  ✗ qdrant unreachable at $QDRANT_URL"
  exit 1
fi
echo "  ✓ qdrant healthy at $QDRANT_URL"

echo "  hook script shebangs"
for f in dist/claude-code/bin/*.sh; do
  head -1 "$f" | grep -qE '^#!/(usr/bin/env |bin/)bash' || {
    echo "  ✗ missing/wrong shebang in $f"
    exit 1
  }
done
echo "  ✓ all hook scripts have bash shebangs"

if [ -z "${GEMINI_API_KEY:-}" ]; then
  echo "  - GEMINI_API_KEY unset — skipping MCP tools/list handshake"
  exit 0
fi

echo "  MCP server tools/list handshake"
# Send a minimal tools/list request to the MCP server and look for the
# `remembering` tool in the response. Use a 5s timeout to avoid hanging
# forever if the server can't boot.
RESPONSE=$(timeout 10 bash -c '
  printf %s "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"install-test\",\"version\":\"0\"}}}\n{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\n" \
    | node dist/mcp/server.js 2>/dev/null
' || true)

if echo "$RESPONSE" | grep -q '"name":"remembering"'; then
  echo "  ✓ MCP server lists the remembering tool"
else
  echo "  ✗ MCP server did not list the remembering tool"
  echo "  --- response snippet ---"
  echo "$RESPONSE" | head -c 500
  echo
  exit 1
fi
