#!/bin/bash
set -e

echo "The Brain — Full Index"
echo "======================"

# Check Qdrant is running
if ! curl -s http://localhost:6333/healthz > /dev/null 2>&1; then
  echo "Qdrant is not running. Start it with:"
  echo "  docker run -d --name qdrant --restart unless-stopped -p 6333:6333 -p 6334:6334 -v \"\$HOME/.the-brain/qdrant:/qdrant/storage:z\" qdrant/qdrant"
  exit 1
fi

echo "Qdrant is healthy"

# Load GEMINI_API_KEY from the env file if not already set. Candidates in
# precedence order: $BRAIN_ENV_FILE, ~/.the-brain/.env (the documented
# location), ~/io-data/.env (legacy, for installs that predate that layout).
if [ -z "${GEMINI_API_KEY:-}" ]; then
  for env_file in "${BRAIN_ENV_FILE:-}" ~/.the-brain/.env ~/io-data/.env; do
    if [ -n "$env_file" ] && [ -f "$env_file" ]; then
      set -a
      # shellcheck disable=SC1090
      . "$env_file"
      set +a
      break
    fi
  done
fi

if [ -z "$GEMINI_API_KEY" ]; then
  echo "GEMINI_API_KEY not set"
  exit 1
fi

echo "GEMINI_API_KEY is set"

# Run full index
cd "$(dirname "$0")/.."
npx tsx cli/index.ts index

echo ""
echo "Index complete. Run 'pnpm search \"your query\"' to test."
