#!/bin/bash
# snapshot-qdrant.sh — Daily maintenance: snapshot all Qdrant collections,
# verify data integrity, and auto-reindex on drift.
#
# Usage:
#   scripts/snapshot-qdrant.sh               # run full maintenance (default: keep last 7)
#   scripts/snapshot-qdrant.sh --keep 14     # keep last 14 daily snapshots
#   scripts/snapshot-qdrant.sh --skip-reindex # snapshot + verify only, no auto-repair
#   scripts/snapshot-qdrant.sh --help
#
# Designed to be run by a systemd user timer (daily at 03:00).
#
# What it does:
#   1. Pre-flight checks (container, API, mount type)
#   2. Snapshot all 5 collections via Qdrant API
#   3. Copy snapshots to persistent host storage
#   4. Drift check: compare collection counts against indexer state files
#   5. Auto-reindex any collections that have drifted (> 20% below expected)
#   6. Rotate old snapshots (keep last N)
#
# Decision doc: brain/decisions/2026-04-11-qdrant-tmpfs-rescue.md

set -euo pipefail

# --- Defaults ---

KEEP=7
CONTAINER=qdrant-io
HOST_BACKUP_DIR="${HOME}/io-data/qdrant-rescue/snapshots"
ENV_FILE="${HOME}/io-data/.env"
QDRANT_URL="http://localhost:6333"
GREYMATTER_DIR="${HOME}/io-projects/greymatter"
COLLECTIONS=(brain-vault io-observations io-reflections io-messages io-assets)
SKIP_REINDEX=false

# --- Arg parsing ---

while [ $# -gt 0 ]; do
    case "$1" in
        --keep) KEEP="$2"; shift 2 ;;
        --container) CONTAINER="$2"; shift 2 ;;
        --dir) HOST_BACKUP_DIR="$2"; shift 2 ;;
        --skip-reindex) SKIP_REINDEX=true; shift ;;
        --help|-h)
            sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) echo "Unknown arg: $1" >&2; exit 1 ;;
    esac
done

# --- Logging ---

LOG_PREFIX="[maintenance]"
log()  { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $LOG_PREFIX $*" >&2; }
fail() { log "FAIL: $*"; exit 1; }

# --- Pre-flight checks ---

[ -f "$ENV_FILE" ] || fail "env file not found: $ENV_FILE"
QDRANT_API_KEY="$(grep '^QDRANT_API_KEY=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")"
[ -n "$QDRANT_API_KEY" ] || fail "QDRANT_API_KEY not found in $ENV_FILE"

GEMINI_API_KEY="$(grep '^GEMINI_API_KEY=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")"

docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" || fail "container '$CONTAINER' is not running"

if ! curl -sf -H "api-key: $QDRANT_API_KEY" "$QDRANT_URL/collections" >/dev/null; then
    fail "Qdrant at $QDRANT_URL is not responding"
fi

# Verify the storage mount is NOT tmpfs
mount_type="$(docker exec "$CONTAINER" mount 2>/dev/null | awk '/\/qdrant\/storage/ { print $5 }' | head -1)"
if [ "$mount_type" = "tmpfs" ]; then
    log "🚨 WARNING: $CONTAINER /qdrant/storage is tmpfs — data is in RAM only!"
    log "   Snapshot will proceed (rescue copy) but the underlying mount MUST be fixed."
    log "   See brain/decisions/2026-04-11-qdrant-tmpfs-rescue.md"
elif [ -z "$mount_type" ]; then
    log "WARNING: could not determine /qdrant/storage mount type (continuing anyway)"
else
    log "mount type: $mount_type ✓"
fi

# =========================================================================
# PHASE 1: SNAPSHOT
# =========================================================================

STAMP="$(date -u +%Y-%m-%dT%H%M%S)"
THIS_BACKUP="$HOST_BACKUP_DIR/daily/$STAMP"
mkdir -p "$THIS_BACKUP"
log "--- Phase 1: Snapshot ---"
log "backup dir: $THIS_BACKUP"

for col in "${COLLECTIONS[@]}"; do
    result="$(curl -s -X POST -H "api-key: $QDRANT_API_KEY" "$QDRANT_URL/collections/$col/snapshots")"
    name="$(echo "$result" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("result",{}).get("name","ERR"))' 2>/dev/null || echo ERR)"
    size="$(echo "$result" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("result",{}).get("size","?"))' 2>/dev/null || echo "?")"
    if [ "$name" = "ERR" ]; then
        log "  ERROR snapshotting $col: $result"
        continue
    fi
    log "  $col → $name ($size bytes)"
done

log "copying snapshots to host..."
for col in "${COLLECTIONS[@]}"; do
    latest="$(docker exec "$CONTAINER" sh -c "ls -t /qdrant/snapshots/$col/*.snapshot 2>/dev/null | head -1" 2>/dev/null || true)"
    if [ -z "$latest" ]; then
        log "  $col: no snapshot to copy"
        continue
    fi
    bname="$(basename "$latest")"
    mkdir -p "$THIS_BACKUP/$col"
    docker cp "$CONTAINER:$latest" "$THIS_BACKUP/$col/$bname"
    docker cp "$CONTAINER:${latest}.checksum" "$THIS_BACKUP/$col/${bname}.checksum" 2>/dev/null || true
    size_h="$(du -h "$THIS_BACKUP/$col/$bname" | cut -f1)"
    log "  $col: $size_h"
done

# Clean up snapshots inside the container
for col in "${COLLECTIONS[@]}"; do
    docker exec "$CONTAINER" sh -c "find /qdrant/snapshots/$col -name '*.snapshot' -mmin +5 -delete 2>/dev/null || true; find /qdrant/snapshots/$col -name '*.checksum' -mmin +5 -delete 2>/dev/null || true"
done

total_size="$(du -sh "$THIS_BACKUP" | cut -f1)"
log "snapshot complete: $total_size"

# =========================================================================
# PHASE 2: DRIFT CHECK + AUTO-REINDEX
# =========================================================================

log "--- Phase 2: Drift check ---"

# Read expected counts from state files
get_expected() {
    local collection="$1"
    local state_file="$2"
    local jq_expr="$3"
    if [ -f "$state_file" ]; then
        python3 -c "
import json
with open('$state_file') as f:
    s = json.load(f)
$jq_expr
" 2>/dev/null || echo 0
    else
        echo 0
    fi
}

INDEX_STATE="${HOME}/io-data/io-memory-index-state.json"
MSG_STATE="${HOME}/io-data/io-message-index-state.json"
ASSET_STATE="${HOME}/io-data/io-asset-index-state.json"

DRIFT_COLLECTIONS=()

for col in "${COLLECTIONS[@]}"; do
    actual="$(curl -s -H "api-key: $QDRANT_API_KEY" "$QDRANT_URL/collections/$col" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("result",{}).get("points_count",0))' 2>/dev/null || echo 0)"

    case "$col" in
        brain-vault)
            expected="$(get_expected "$col" "$INDEX_STATE" "
files = s.get('files', {})
total = sum(f['chunks'] for f in files.values() if f.get('collection') == 'brain-vault')
print(total)
")" ;;
        io-observations)
            expected="$(get_expected "$col" "$INDEX_STATE" "
files = s.get('files', {})
total = sum(f['chunks'] for f in files.values() if f.get('collection') == 'io-observations')
print(total)
")" ;;
        io-reflections)
            expected="$(get_expected "$col" "$INDEX_STATE" "
files = s.get('files', {})
total = sum(f['chunks'] for f in files.values() if f.get('collection') == 'io-reflections')
print(total)
")" ;;
        io-messages)
            expected="$(get_expected "$col" "$MSG_STATE" "
sessions = s.get('sessions', {})
total = sum(sess.get('messagesIndexed', 0) for sess in sessions.values())
print(total)
")" ;;
        io-assets)
            expected="$(get_expected "$col" "$ASSET_STATE" "
assets = s.get('assets', {})
total = sum(a.get('chunks', 0) for a in assets.values())
print(total)
")" ;;
    esac

    threshold=$(( expected * 80 / 100 ))

    if [ "$expected" -eq 0 ]; then
        log "  $col: $actual points (no state expectation — skipping drift check)"
    elif [ "$actual" -lt "$threshold" ]; then
        log "  🚨 $col: DRIFT — actual=$actual expected=$expected (< 80% threshold=$threshold)"
        DRIFT_COLLECTIONS+=("$col")
    else
        log "  ✓ $col: $actual points (expected $expected)"
    fi
done

# =========================================================================
# PHASE 3: AUTO-REINDEX ON DRIFT
# =========================================================================

if [ ${#DRIFT_COLLECTIONS[@]} -gt 0 ] && [ "$SKIP_REINDEX" = "false" ]; then
    log "--- Phase 3: Auto-reindex (${#DRIFT_COLLECTIONS[@]} collections drifted) ---"

    NEED_INDEX=false
    NEED_MESSAGES=false
    NEED_ASSETS=false

    for col in "${DRIFT_COLLECTIONS[@]}"; do
        case "$col" in
            brain-vault|io-observations|io-reflections) NEED_INDEX=true ;;
            io-messages) NEED_MESSAGES=true ;;
            io-assets) NEED_ASSETS=true ;;
        esac
    done

    export GEMINI_API_KEY QDRANT_API_KEY

    if [ "$NEED_INDEX" = "true" ]; then
        log "  reindexing brain/observations/reflections..."
        if cd "$GREYMATTER_DIR" && npx tsx cli/index.ts index 2>&1 | tail -3 | while read -r line; do log "    $line"; done; then
            log "  ✓ brain/obs/refl reindex complete"
        else
            log "  ⚠️ brain/obs/refl reindex failed (non-fatal)"
        fi
    fi

    if [ "$NEED_MESSAGES" = "true" ]; then
        log "  reindexing messages..."
        if cd "$GREYMATTER_DIR" && npx tsx cli/index.ts index-messages 2>&1 | tail -3 | while read -r line; do log "    $line"; done; then
            log "  ✓ messages reindex complete"
        else
            log "  ⚠️ messages reindex failed (non-fatal)"
        fi
    fi

    if [ "$NEED_ASSETS" = "true" ]; then
        log "  reindexing assets..."
        if cd "$GREYMATTER_DIR" && npx tsx cli/index.ts index-assets 2>&1 | tail -3 | while read -r line; do log "    $line"; done; then
            log "  ✓ assets reindex complete"
        else
            log "  ⚠️ assets reindex failed (non-fatal)"
        fi
    fi
elif [ ${#DRIFT_COLLECTIONS[@]} -gt 0 ]; then
    log "--- Phase 3: Skipped (--skip-reindex) ---"
    log "  ${#DRIFT_COLLECTIONS[@]} collections have drift but reindex was skipped"
else
    log "--- Phase 3: Skipped (no drift detected) ---"
fi

# =========================================================================
# PHASE 4: ROTATE OLD SNAPSHOTS
# =========================================================================

log "--- Phase 4: Rotate (keep last $KEEP) ---"
if [ -d "$HOST_BACKUP_DIR/daily" ]; then
    # shellcheck disable=SC2012
    old="$(ls -1t "$HOST_BACKUP_DIR/daily" | tail -n "+$((KEEP + 1))" || true)"
    for stale in $old; do
        log "  removing $stale"
        rm -rf "$HOST_BACKUP_DIR/daily/$stale"
    done
fi

# Also clean up old weekly/ dirs from before the daily switch
if [ -d "$HOST_BACKUP_DIR/weekly" ]; then
    log "  migrating weekly/ → daily/ (one-time cleanup)"
    for d in "$HOST_BACKUP_DIR/weekly"/*/; do
        [ -d "$d" ] && mv "$d" "$HOST_BACKUP_DIR/daily/" 2>/dev/null || true
    done
    rmdir "$HOST_BACKUP_DIR/weekly" 2>/dev/null || true
fi

# =========================================================================
# SUMMARY
# =========================================================================

log "=== Maintenance complete ==="
log "  snapshot: $total_size at $THIS_BACKUP"
log "  drift: ${#DRIFT_COLLECTIONS[@]} collections needed repair"
log "  mount: $mount_type"
