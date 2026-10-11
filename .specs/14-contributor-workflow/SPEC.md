# #14: Contributor workflow: AGENTS.md, DEVELOPMENT.md, .specs/ and a start-issue skill

- Issue: #14
- Branch: claude/project-thread-kr0jym (assigned by the agent environment;
  the convention would be 14-contributor-workflow, see Log)
- Started: 2026-10-07

## TL;DR
Puts the ticket workflow in root-level files so agents follow it without it
being pasted into each prompt. `AGENTS.md` is the single shared rules file,
`CLAUDE.md` points at it, `DEVELOPMENT.md` describes the issue, branch, SPEC,
review and handover flow, and a `start-issue` skill scaffolds the
`<issue>-<slug>` branch and `.specs/<issue>-<slug>/SPEC.md`. Mirrors Deck's
layout (Deck #39, #40), adapted: this repo has no CONTRIBUTING.md and no DCO,
so the rules live in `AGENTS.md` rather than being split across files.

## Scope
In scope:
- `AGENTS.md`: issues on GitHub as the source of truth (not Linear),
  `N-short-slug` branches off `main`, SPEC in the first commit, PR says
  `Closes #N` and is never merged by the agent, fall back to GitHub tools if
  `gh issue view` is refused, say what could not be tested.
- `CLAUDE.md` reduced to a pointer that imports `AGENTS.md`.
- `DEVELOPMENT.md` adapted from Deck's, with this repo's checks and CI.
- `.agents/skills/start-issue/SKILL.md`, with `.claude/skills/start-issue` as
  a relative symlink so there is one copy.
- README Contributing section links to the new files.

Out of scope (and where it goes instead):
- Adding a CONTRIBUTING.md or a DCO requirement. Neither exists here today;
  that is a policy decision, not part of mirroring the workflow.
- A dash-check gate. The leak gate deliberately has no em-dash rule here (see
  the header of `scripts/leak-gate.mjs`); house style is enforced by review.

## Test plan
- `pnpm check:leaks:self-test`, `pnpm check:leaks` and `pnpm check:licence`
  on the branch, which are what CI's guards job runs.
- The symlink resolves: `.claude/skills/start-issue/SKILL.md` reads the
  canonical file.
- No em-dashes or en-dashes in the new files.
- Not tested: a fresh agent session following the skill end to end for a
  sample issue. `pnpm typecheck` and `pnpm test` are unaffected (no code
  change) and the install test needs Docker, so both are left to CI.

## Follow-ups
- None yet.

## Log

### 2026-10-07: branch and SPEC skeleton
- What changed: created this SPEC alongside the workflow files.
- Why: every change starts from an issue, and the SPEC is the first commit.
  The agent environment that did this work requires its own branch name, so
  the branch is not `14-contributor-workflow`; the folder still uses the
  conventional name so the SPEC is findable by issue number.
- Supersedes: nothing, additive.
- Commits: (this commit)
