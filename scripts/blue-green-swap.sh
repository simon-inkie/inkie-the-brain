#!/usr/bin/env bash
#
# blue-green-swap.sh — atomic cutover for a messages-collection rebuild.
#
# Drops the OLD messages collection and points an alias at the freshly-built v2,
# so readers (which query "io-messages") transparently resolve to v2.
#
# CARDINAL: this is a destructive cutover. It will not run without --confirm,
# and it refuses to drop the old collection unless v2 passes health checks first
# (exists + point count >= MIN_POINTS). Verify-before-destroy is the contract.
#
# Usage:
#   QDRANT_API_KEY=... ./blue-green-swap.sh --new io-messages-v2 [--alias io-messages] \
#       [--min-points N] [--confirm]
#
# Without --confirm it does a DRY RUN: prints what it would do, runs the health
# checks, makes NO changes. Always dry-run first.
#
set -euo pipefail

QDRANT_URL="${QDRANT_URL:-http://localhost:6333}"
ALIAS="io-messages"
NEW=""
MIN_POINTS=1
CONFIRM=0

while [ $# -gt 0 ]; do
  case "$1" in
    --new) NEW="$2"; shift 2;;
    --alias) ALIAS="$2"; shift 2;;
    --min-points) MIN_POINTS="$2"; shift 2;;
    --confirm) CONFIRM=1; shift;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

if [ -z "$NEW" ]; then echo "ERROR: --new <collection> required" >&2; exit 2; fi
if [ -z "${QDRANT_API_KEY:-}" ]; then echo "ERROR: QDRANT_API_KEY not set" >&2; exit 2; fi

hdr=(-H "api-key: $QDRANT_API_KEY" -H "Content-Type: application/json")

count() { # $1=collection -> exact point count, or "MISSING"
  local r
  r=$(curl -s "${hdr[@]}" "$QDRANT_URL/collections/$1/points/count" -d '{"exact":true}')
  echo "$r" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('result',{}).get('count','MISSING') if d.get('status')=='ok' else 'MISSING')" 2>/dev/null || echo "MISSING"
}

echo "== blue-green swap =="
echo "  alias:        $ALIAS"
echo "  new (v2):     $NEW"
echo "  min-points:   $MIN_POINTS"
echo "  mode:         $([ "$CONFIRM" = 1 ] && echo 'EXECUTE (--confirm)' || echo 'DRY RUN (no --confirm)')"
echo

# --- Health checks (run in BOTH dry-run and execute) -----------------------
NEW_COUNT=$(count "$NEW")
OLD_COUNT=$(count "$ALIAS")
echo "health: $NEW has $NEW_COUNT points; current $ALIAS has $OLD_COUNT points"

if [ "$NEW_COUNT" = "MISSING" ]; then
  echo "ABORT: new collection '$NEW' does not exist or is unreachable. Build it first." >&2
  exit 1
fi
if [ "$NEW_COUNT" -lt "$MIN_POINTS" ]; then
  echo "ABORT: '$NEW' has $NEW_COUNT points (< min $MIN_POINTS). Refusing to swap onto a thin collection." >&2
  exit 1
fi

if [ "$CONFIRM" != 1 ]; then
  echo
  echo "DRY RUN ok. Health checks passed. Would, on --confirm:"
  echo "  1) DELETE collection '$ALIAS' (current points: $OLD_COUNT)"
  echo "  2) create alias '$ALIAS' -> '$NEW'"
  echo "Re-run with --confirm to execute. Take a snapshot first and verify it restores."
  exit 0
fi

# --- Execute (destructive) -------------------------------------------------
echo
echo "EXECUTING swap..."

# Drop the old collection (instant; no tombstone vacuum — that's the point of blue-green).
echo "  dropping '$ALIAS'..."
curl -s -X DELETE "${hdr[@]}" "$QDRANT_URL/collections/$ALIAS" \
  | python3 -c "import sys,json;print('   delete:', json.load(sys.stdin).get('status'))"

# Create the alias.
echo "  aliasing '$ALIAS' -> '$NEW'..."
curl -s -X POST "${hdr[@]}" "$QDRANT_URL/collections/aliases" \
  -d "{\"actions\":[{\"create_alias\":{\"collection_name\":\"$NEW\",\"alias_name\":\"$ALIAS\"}}]}" \
  | python3 -c "import sys,json;print('   alias:', json.load(sys.stdin).get('status'))"

# Verify the alias resolves to the v2 count.
VIA_ALIAS=$(count "$ALIAS")
echo "verify: query '$ALIAS' (alias) now returns $VIA_ALIAS points (expected $NEW_COUNT)"
if [ "$VIA_ALIAS" = "$NEW_COUNT" ]; then
  echo "OK — swap complete. '$ALIAS' resolves to '$NEW'."
else
  echo "WARNING — alias count ($VIA_ALIAS) != v2 count ($NEW_COUNT). Investigate before trusting recall." >&2
  exit 1
fi
