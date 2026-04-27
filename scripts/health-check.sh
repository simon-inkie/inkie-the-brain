#!/bin/bash
# the-brain daily health check
# Run manually or via cron/scheduled agent wake
# Outputs a structured report to stdout

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRAIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOME_DIR="$HOME"

# Load env vars
if [[ -f "$HOME_DIR/io-data/.env" ]]; then
  while IFS='=' read -r key val; do
    [[ "$key" =~ ^#.*$ || -z "$key" ]] && continue
    val="${val%%#*}"
    val="$(echo "$val" | xargs)"
    export "$key=$val" 2>/dev/null
  done < "$HOME_DIR/io-data/.env"
fi

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
storage_type=$(docker exec qdrant-io cat /proc/mounts 2>/dev/null | grep "/qdrant/storage" | awk '{print $3}')
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
for svc in io-watcher.service index-messages.timer; do
  state=$(systemctl --user is-active "$svc" 2>/dev/null)
  if [[ "$state" == "active" ]]; then
    echo "  $PASS $svc: active"
  else
    echo "  $FAIL $svc: $state"
    errors=$((errors + 1))
  fi
done

echo ""

# --- 4. Classifiers ---
echo "## Classifiers"

# File classifier
file_result=$(echo '{"tool_name":"Read","tool_input":{"file_path":"/tmp/health-check-test"},"cwd":"/tmp"}' \
  | node "$HOME_DIR/io-projects/io-auto-mode/adapters/claude-code/dist/file-hook.js" 2>/dev/null \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['hookSpecificOutput']['permissionDecision'])" 2>/dev/null)
if [[ "$file_result" == "allow" ]]; then
  echo "  $PASS File classifier: responding"
else
  echo "  $FAIL File classifier: not responding (got: ${file_result:-nothing})"
  errors=$((errors + 1))
fi

# Bash classifier (static stage only — avoid burning LLM credits)
bash_result=$(echo '{"tool_name":"Bash","tool_input":{"command":"ls"},"cwd":"/tmp"}' \
  | timeout 5 /home/simon/io-projects/io-auto-mode/adapters/claude-code/bin/classify.sh 2>/dev/null \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['hookSpecificOutput']['permissionDecision'])" 2>/dev/null)
if [[ -n "$bash_result" ]]; then
  echo "  $PASS Bash classifier: responding ($bash_result)"
else
  echo "  $FAIL Bash classifier: timeout or error"
  errors=$((errors + 1))
fi

echo ""

# --- 5. Agent silos ---
echo "## Agent silos"
for agent in io doctor2 aldus andor hopkins; do
  silo="$HOME_DIR/.the-brain/agents/$agent"
  obs=$(ls "$silo/memory/observations/" 2>/dev/null | wc -l)
  ref=$(ls "$silo/memory/reflections/" 2>/dev/null | wc -l)
  mem="✗"
  [[ -f "$silo/MEMORY.md" ]] && mem="✓"
  inbox=$(ls "$silo/inbox/" 2>/dev/null | wc -l)

  if [[ "$mem" == "✓" && "$obs" -gt 0 ]]; then
    echo "  $PASS $agent: obs=$obs ref=$ref MEMORY.md=$mem inbox=$inbox"
  elif [[ "$mem" == "✗" ]]; then
    echo "  $FAIL $agent: MEMORY.md missing"
    errors=$((errors + 1))
  else
    echo "  $WARN $agent: obs=$obs (may be new)"
  fi
done

echo ""

# --- 6. Watcher recent activity ---
echo "## Watcher activity (last 30 min)"
recent=$(journalctl --user -u io-watcher.service --since "30 min ago" --no-pager 2>/dev/null | grep -c "Indexed:")
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
