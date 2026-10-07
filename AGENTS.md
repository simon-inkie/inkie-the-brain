# inkie-the-brain

Long-term memory for AI coding agents. Filesystem-first, runtime-agnostic.

This is the single shared rules file for AI coding agents working in this
repository, whatever the runtime. `CLAUDE.md` and any other runtime file only
point here, so there is one copy of the rules and nothing to drift. The full
workflow (the SPEC, review and handover) is in
[DEVELOPMENT.md](DEVELOPMENT.md); read it before your first change.

If you are starting work on an issue, the `start-issue` skill does the
mechanical part: it creates the branch and the SPEC skeleton for you. See
[.agents/skills/start-issue/SKILL.md](.agents/skills/start-issue/SKILL.md).

For setting up a machine and running the memory loop, see
[README.md](README.md) and [QUICKSTART.md](QUICKSTART.md). The moving parts are
in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Issues and branches

- GitHub issues on this repository are the source of truth for work. Not
  Linear, not a chat thread, not a prompt: if the issue and your instructions
  disagree, say so and follow the issue, or ask.
- Start from an issue. If none exists for the change, open one first. Trivial
  changes (a typo, a broken link, a one-line config tweak) are the only
  exception; if you are unsure whether something is trivial, it is not.
- Branch off an up-to-date `main` for every change, named
  `<issue>-<short-slug>`, short and kebab-case, for example
  `14-contributor-workflow`. Never push to `main` directly. This applies to
  every contributor, human or agent.
- Non-trivial work keeps a SPEC at `.specs/<issue>-<slug>/SPEC.md`, using the
  branch name as the folder name. The branch's first commit creates it, and it
  is updated in the same commits as the code.
- Read issues with `gh issue view <N>`. If `gh` is missing, unauthenticated
  or refused, read the issue with the GitHub tools your runtime provides
  (for example a GitHub MCP server) instead of stopping or guessing.

## Pull requests

- One pull request per issue, scoped to one change. Large or unrelated
  changes go in separate pull requests. `main` must stay releasable.
- The description comes from the SPEC's TL;DR, links the SPEC file, and
  includes `Closes #<issue>`.
- Say what could not be tested, and why, in the pull request description and
  in the SPEC's Test plan. "Not run" is a fine answer; silence is not.
- Before opening, run the checks in [DEVELOPMENT.md](DEVELOPMENT.md)
  section 4 on a clean tree.

## House rules for agents

- Do not merge your own pull request, push to `main`, force-push a shared
  branch, or create a release, unless a maintainer asked you to in the issue
  or pull request. Opening the pull request is where your part ends.
- No internal material (real names, hosts, home-directory paths, private
  ticket ids, addresses) may enter the repository. This is the open version of
  a privately run system; `pnpm check:leaks` enforces it. Read the rule
  comments in `scripts/leak-gate.mjs` before extending the denylist, and link
  issues by number (`#14`) rather than by private URL.
- Documentation avoids em-dashes and en-dashes. Unlike Deck this is house
  style, enforced by review rather than by a gate; source comments copied in
  from elsewhere are left alone.
- Keep the SPEC current as you go, even within one session. A session can end
  at any point, and the SPEC is all the next one gets.
