#!/bin/bash
# the-brain daily health check
# Run manually or via cron/scheduled agent wake
# Outputs a structured report to stdout

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRAIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOME_DIR="$HOME"

# Overridable so a deployment that renamed its container or its systemd unit
# can still be checked without editing this script.
QDRANT_CONTAINER="${QDRANT_CONTAINER:-qdrant}"
WATCHER_UNIT="${WATCHER_UNIT:-the-brain-watcher.service}"

# Load env vars. Candidates in precedence order: $BRAIN_ENV_FILE,
# ~/.the-brain/.env (the documented location), ~/io-data/.env (legacy, kept for
# installs that predate the ~/.the-brain/ layout). First one present wins.
for env_file in "${BRAIN_ENV_FILE:-}" "$HOME_DIR/.the-brain/.env" "$HOME_DIR/io-data/.env"; do
  if [[ -n "$env_file" && -f "$env_file" ]]; then
    while IFS='=' read -r key val; do
      [[ "$key" =~ ^#.*$ || -z "$key" ]] && continue
      val="${val%%#*}"
      val="$(echo "$val" | xargs)"
      export "$key=$val" 2>/dev/null
    done < "$env_file"
    break
  fi
done

PASS="✅"
FAIL="❌"
WARN="⚠️"
errors=0

echo "# the-brain health check — $(date '+%Y-%m-%d %H:%M %Z')"
echo ""

# --- 1. Qdrant ---
echo "## Qdrant"
qdrant_health=$(curl -s --max-time 3 "http://localhost:6333/healthz" 2>/dev/null)
if [[ "$qdrant_health" == *"passed"* ]]; then
  echo "  $PASS Qdrant healthy"
else
  echo "  $FAIL Qdrant unreachable or unhealthy"
  errors=$((errors + 1))
fi

# Storage check (tmpfs guard)
storage_type=$(docker exec "$QDRANT_CONTAINER" cat /proc/mounts 2>/dev/null | grep "/qdrant/storage" | awk '{print $3}')
if [[ "$storage_type" == "ext4" || "$storage_type" == "xfs" || "$storage_type" == "btrfs" ]]; then
  echo "  $PASS Storage: $storage_type (persistent)"
elif [[ "$storage_type" == "tmpfs" || "$storage_type" == "overlay" ]]; then
  echo "  $FAIL Storage: $storage_type — DATA WILL BE LOST ON RESTART"
  errors=$((errors + 1))
else
  echo "  $WARN Storage: ${storage_type:-unknown} (could not verify)"
fi

echo ""

# --- 2. Collections ---
echo "## Collections"
for coll in brain-vault io-observations io-reflections io-messages io-assets; do
  info=$(curl -s --max-time 3 "http://localhost:6333/collections/$coll" \
    -H "api-key: ${QDRANT_API_KEY:-}" 2>/dev/null)
  count=$(echo "$info" | python3 -c "import sys,json; print(json.load(sys.stdin).get('result',{}).get('points_count',0))" 2>/dev/null)
  status=$(echo "$info" | python3 -c "import sys,json; print(json.load(sys.stdin).get('result',{}).get('status','?'))" 2>/dev/null)
  if [[ "$status" == "green" && "$count" -gt 0 ]]; then
    echo "  $PASS $coll: $count points"
  elif [[ "$count" == "0" ]]; then
    echo "  $WARN $coll: 0 points (empty)"
    errors=$((errors + 1))
  else
    echo "  $FAIL $coll: $count points (status=$status)"
    errors=$((errors + 1))
  fi
done

echo ""

# --- 3. Services ---
echo "## Services"
for svc in "$WATCHER_UNIT" snapshot-qdrant.timer; do
  state=$(systemctl --user is-active "$svc" 2>/dev/null)
  if [[ "$state" == "active" ]]; then
    echo "  $PASS $svc: active"
  else
    echo "  $FAIL $svc: $state"
    errors=$((errors + 1))
  fi
done

echo ""

# --- 4. Agent silos ---
echo "## Agent silos"
NOW=$(date +%s)
# Discovered, not hardcoded: every silo under the agents root is checked, so
# this works on any deployment without editing a roster into the script.
silo_root="$HOME_DIR/.the-brain/agents"
silos=()
for candidate in "$silo_root"/*/; do
  [[ -d "$candidate" ]] && silos+=("${candidate%/}")
done
if [[ ${#silos[@]} -eq 0 ]]; then
  echo "  $WARN No agent silos found under $silo_root"
fi
for silo in ${silos[@]+"${silos[@]}"}; do
  agent="$(basename "$silo")"
  obs=$(ls "$silo/memory/observations/" 2>/dev/null | wc -l)
  ref=$(ls "$silo/memory/reflections/" 2>/dev/null | wc -l)
  mem_file="$silo/MEMORY.md"

  if [[ ! -f "$mem_file" ]]; then
    echo "  $FAIL $agent: MEMORY.md missing"
    errors=$((errors + 1))
    continue
  fi

  mem_size=$(wc -c < "$mem_file")
  mem_mtime=$(stat -c %Y "$mem_file")
  mem_age_h=$(( (NOW - mem_mtime) / 3600 ))

  # Stale threshold: 48h. Most agents observe at least daily; longer = something's wrong.
  if [[ $mem_size -lt 1000 ]]; then
    echo "  $FAIL $agent: MEMORY.md only ${mem_size}b (likely empty/broken)"
    errors=$((errors + 1))
  elif [[ $mem_age_h -gt 48 ]]; then
    echo "  $WARN $agent: MEMORY.md stale (${mem_age_h}h old) — observe.sh may be failing"
  else
    age_label="${mem_age_h}h"
    [[ $mem_age_h -eq 0 ]] && age_label="$(( (NOW - mem_mtime) / 60 ))m"
    echo "  $PASS $agent: obs=$obs ref=$ref MEMORY.md=${mem_size}b age=${age_label}"
  fi
done

echo ""

# --- 5. Watcher recent activity ---
echo "## Watcher activity (last 30 min)"
recent=$(journalctl --user -u "$WATCHER_UNIT" --since "30 min ago" --no-pager 2>/dev/null | grep -c "Indexed:")
if [[ "$recent" -gt 0 ]]; then
  echo "  $PASS $recent files indexed in last 30 min"
else
  echo "  $WARN No files indexed in last 30 min (may be idle)"
fi

echo ""

# --- Summary ---
echo "---"
if [[ "$errors" -eq 0 ]]; then
  echo "$PASS All checks passed"
else
  echo "$FAIL $errors issue(s) found"
fi

exit "$errors"
