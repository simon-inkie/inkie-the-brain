# Install-test runner for the-brain.
#
# Goal: a fresh-machine simulation that the documented QUICKSTART path actually
# works. Pinned base + pinned node version so flakes are real bugs, not env drift.
#
# Pair with docker-compose.yml — this image talks to a sidecar Qdrant service
# at http://qdrant:6333 (compose internal DNS).

# Tag-only (no digest pin) — install-test wants to surface base-image
# regressions early, not hide them behind a frozen pin. CI runs the harness
# every PR + nightly, so any breaking change in a base-image update gets
# caught at the next run rather than in production six months later.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_VERSION=22.11.0 \
    PNPM_VERSION=9.15.0 \
    LANG=C.UTF-8

# System deps. curl + ca-certificates so the n version manager can fetch node;
# git so pnpm install can resolve git: deps; jq for the check scripts.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates git jq bash bsdmainutils \
    && rm -rf /var/lib/apt/lists/*

# Pinned node via the n version manager (stable across the test runner's life).
RUN curl -fsSL https://raw.githubusercontent.com/tj/n/master/bin/n -o /usr/local/bin/n \
    && chmod +x /usr/local/bin/n \
    && /usr/local/bin/n "${NODE_VERSION}" \
    && node --version

# pnpm via corepack (ships with node).
RUN corepack enable \
    && corepack prepare "pnpm@${PNPM_VERSION}" --activate \
    && pnpm --version

WORKDIR /workspace

# The repo is mounted in at /workspace by docker-compose, not COPY'd, so the
# harness exercises the same install path a stranger cloning the repo follows.
# Default command is the runner; override via `docker compose run` for shell.
#
# Build context is the repo root (set via `context: ..` in compose), so COPY
# paths are repo-relative.
COPY install-test/checks/ /opt/install-test/checks/
COPY install-test/fixtures/ /opt/install-test/fixtures/
COPY install-test/run.sh /opt/install-test/run.sh
RUN chmod +x /opt/install-test/run.sh /opt/install-test/checks/*.sh

CMD ["/opt/install-test/run.sh"]
