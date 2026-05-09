# Install-test runner for the-brain.
#
# Goal: a fresh-machine simulation that the documented QUICKSTART path actually
# works. Pinned base + pinned node version so flakes are real bugs, not env drift.
#
# Pair with docker-compose.yml — this image talks to a sidecar Qdrant service
# at http://qdrant:6333 (compose internal DNS).

FROM ubuntu:24.04@sha256:80dd3c3b9c6cecb9f1667e9290b3bc61b78c2678c02cbdae5f0fea92cc6734ab

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
COPY checks/ /opt/install-test/checks/
COPY fixtures/ /opt/install-test/fixtures/
COPY run.sh /opt/install-test/run.sh
RUN chmod +x /opt/install-test/run.sh /opt/install-test/checks/*.sh

CMD ["/opt/install-test/run.sh"]
