# Install-test harness

A Docker Compose harness that runs the documented QUICKSTART path on a fresh ubuntu:24.04 image — proving the brain installs cleanly from a clean clone, talks to Qdrant, and round-trips a search against a small fixture corpus.

This is what verifies "does it actually work for strangers" before each release. CI runs the same harness on every PR.

## What it covers

| Level | Check | What it proves |
|---|---|---|
| **L1** | `pnpm install` + `pnpm build` + `pnpm typecheck` | Buildable from a fresh clone with documented prereqs |
| **L2** | Qdrant healthcheck + hook script shebangs + MCP `tools/list` handshake | Services boot and the entry-points are well-formed |
| **L3** | `pnpm index` against an empty silo + brain vault | Indexer doesn't crash on the cold-start case |
| **L4** | Index a 5-file fixture corpus, search for a distinctive phrase, verify the expected file is in the top-3 | The brain's round-trip actually works |

## What it doesn't cover

- ❌ Real Claude Code session — CC isn't installable in a stripped container
- ❌ Real semantic-recall data — the brain ships with no real silo content; only fixture-data verification
- ❌ Multi-agent behaviour: the harness runs one silo (`AGENT_NAME=install-test`); per-directory attribution and cross-silo scoping are covered by the vitest suites, not here
- ❌ Hook firing in production — requires real CC; manual workshop dry-run is the test
- ❌ Performance / scale — no load testing in v0
- ❌ macOS/Windows-specific paths — Docker is Linux-only by default; OS-specific issues caught only by GitHub Actions matrix runs on macOS runners (see `.github/workflows/install-test.yml`)

These are deliberate v0 cuts. Don't grow the harness past these without a separate spec.

## Run it locally

Prereqs: Docker + Docker Compose; a Gemini API key for L2/L3/L4 (L1 alone needs no key).

```bash
# One-shot pass/fail — exit code is 0 on all-pass, 1 if anything failed
GEMINI_API_KEY=your-key docker compose -f install-test/docker-compose.yml run --rm test-runner

# Interactive shell into the test container — useful when something fails
GEMINI_API_KEY=your-key install-test/shell.sh
```

Without `GEMINI_API_KEY` set, L2-L4 skip with a friendly message. L1 still runs (it's pure build + typecheck).

## Run it in CI

`.github/workflows/install-test.yml` runs the harness on every PR. Tests for the build path on Ubuntu (Docker) + a separate native run on macOS to catch the OS-specific issues Docker can't.

## Anatomy

```
install-test/
├── README.md              ← this file
├── Dockerfile             ← ubuntu:24.04 + node 22 + pnpm + git
├── docker-compose.yml     ← test-runner + qdrant sidecar
├── run.sh                 ← one-shot entry point (matrix output)
├── shell.sh               ← interactive debug shell wrapper
├── fixtures/
│   └── brain/             ← 5 markdown files for L4 round-trip
│       ├── ideas/
│       ├── decisions/
│       └── learnings/
└── checks/
    ├── 01-build-clean.sh
    ├── 02-services-up.sh
    ├── 03-indexer-empty.sh
    └── 04-search-fixtures.sh
```

## When this fails

If a check fails, drop into the shell with `install-test/shell.sh` and run the failing check directly:

```bash
# Inside the container
cd /workspace
pnpm install     # if you didn't run a prior pass
bash /opt/install-test/checks/01-build-clean.sh
```

Each check script is self-contained — read the top comment for what it's verifying.
