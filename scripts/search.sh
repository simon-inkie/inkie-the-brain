#!/bin/bash
set -e

# Load GEMINI_API_KEY from io-data/.env if not set
if [ -z "$GEMINI_API_KEY" ]; then
  if [ -f ~/io-data/.env ]; then
    export $(grep -v '^#' ~/io-data/.env | xargs)
  fi
fi

cd "$(dirname "$0")/.."
npx tsx src/cli.ts search "$@"
