#!/usr/bin/env bash
# L2 — services up: Qdrant reachable, MCP server boots and responds to
# tools/list, hook scripts have correct shebangs.
#
# Verifies the install can talk to its dependencies and the entry-point
# scripts are well-formed. No real data flows yet — that's L3/L4.

set -euo pipefail

cd "${WORKSPACE:-/workspace}"

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
# Send initialize + initialized + tools/list to the MCP server and check
# the `remembering` tool appears in the response.
#
# Pipe shape: (printf; sleep 5) | npx tsx mcp/server.ts
#   - printf writes the 3 JSON-RPC messages
#   - sleep 5 keeps the pipe open so the server can write responses
#     before stdin closes (MCP SDK exits on stdin EOF)
#   - 30s outer timeout — cold tsx start (~3-5s) + ensureCollections
#     qdrant round-trip (~2-5s) + handshake + read budget
#
# Stderr captured to a file so the qdrant client's "Failed to obtain
# server version" warnings (and any real errors) are available on
# failure without polluting the success path.
STDOUT_FILE=$(mktemp)
STDERR_FILE=$(mktemp)
# shellcheck disable=SC2064
trap "rm -f '$STDOUT_FILE' '$STDERR_FILE'" EXIT

(
  printf %s '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"install-test","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
'
  sleep 5
) | timeout 30 npx --yes tsx mcp/server.ts > "$STDOUT_FILE" 2> "$STDERR_FILE" || true

if grep -q '"name":"remembering"' "$STDOUT_FILE"; then
  echo "  ✓ MCP server lists the remembering tool"
else
  echo "  ✗ MCP server did not list the remembering tool"
  echo "  --- stdout (first 800 chars) ---"
  head -c 800 "$STDOUT_FILE"
  echo
  echo "  --- stderr (first 800 chars) ---"
  head -c 800 "$STDERR_FILE"
  echo
  exit 1
fi
