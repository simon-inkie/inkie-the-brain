#!/bin/bash
set -e

echo "Io Memory — Full Index"
echo "======================"

# Check Qdrant is running
if ! curl -s http://localhost:6333/healthz > /dev/null 2>&1; then
  echo "Qdrant is not running. Start it with:"
  echo "  docker run -d --name qdrant-io --restart unless-stopped -p 6333:6333 -p 6334:6334 -v ~/io-data/qdrant:/qdrant/storage:z qdrant/qdrant"
  exit 1
fi

echo "Qdrant is healthy"

# Load GEMINI_API_KEY from io-data/.env if not set
if [ -z "$GEMINI_API_KEY" ]; then
  if [ -f ~/io-data/.env ]; then
    export $(grep -v '^#' ~/io-data/.env | xargs)
  fi
fi

if [ -z "$GEMINI_API_KEY" ]; then
  echo "GEMINI_API_KEY not set"
  exit 1
fi

echo "GEMINI_API_KEY is set"

# Run full index
cd "$(dirname "$0")/.."
npx tsx src/cli.ts index

echo ""
echo "Index complete. Run 'pnpm search \"your query\"' to test."
