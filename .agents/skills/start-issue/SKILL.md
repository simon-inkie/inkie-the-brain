---
name: start-issue
description: Start work on a GitHub issue in this repository. Use when the user says "start issue N", "pick up issue N", "start #N", or asks to begin a new piece of work that needs an issue, a branch and a SPEC. Creates the N-slug branch and the .specs/N-slug/SPEC.md skeleton, pre-filled from the GitHub issue, as the branch's first commit.
---

# start-issue

Creates the branch and the SPEC skeleton for one GitHub issue, so the first
commit on a branch is the SPEC rather than the code. The convention this
implements is in [DEVELOPMENT.md](../../../DEVELOPMENT.md) at the repository
root, and the short rules are in [AGENTS.md](../../../AGENTS.md); read both if
you have not.

GitHub issues on this repository are the source of truth. If the user's
request mentions another tracker (Linear or similar), still work from the
GitHub issue; if there is none, open one first (or ask the user to) before
running this skill.

## What it produces

For issue number `N` with title `T`:

- A branch off an up-to-date `origin/main`, named `N-<slug>`, where `<slug>`
  is a short kebab-case summary of the title: lowercase, anything that is not
  a letter or digit replaced by a hyphen, collapsed and trimmed of leading and
  trailing hyphens, and cut to two to five words so the branch name stays
  short (under about 40 characters).
- `.specs/N-<slug>/SPEC.md`, filled from the template below with the issue
  number and title.
- One commit on the new branch: `docs(spec): start #N <slug> (#N)`.

It does not write any code, does not push, and does not open the pull request.
Those come next, and the SPEC's Log records when they happen. When the pull
request is opened it says `Closes #N`, and it is never merged by the agent.

## How to run it

The mechanical steps, in order:

1. Check the working tree is clean (`git status --porcelain` is empty). If it
   is not, stop and tell the user; starting a branch on top of uncommitted work
   mixes two changes into one review.
2. Read the issue, so the SPEC carries the real title and body:

   ```sh
   gh issue view <N> --json number,title,body,state
   ```

   If `gh` is not installed, not authenticated, or the command is refused by
   your environment, read the issue with the GitHub tools your runtime
   provides instead (for example a GitHub MCP server's issue read on this
   repository). Only if neither works, ask the user for the title and body.
   If the issue is closed, say so and ask before continuing.
3. Check the branch does not already exist (see Notes), then fetch and
   branch:

   ```sh
   git fetch origin main
   git switch -c <N>-<slug> origin/main
   ```

   If your environment has already put you on a branch it requires you to
   use, stay on it, still name the SPEC folder `<N>-<slug>`, and tell the user
   the branch name differs from the convention.
4. Create the folder and the SPEC:

   ```sh
   mkdir -p .specs/<N>-<slug>
   ```

   Write `.specs/<N>-<slug>/SPEC.md` from the template below, substituting the
   issue number, title and today's date. Fill TL;DR, Scope and Test plan from
   the issue body where it already states scope and acceptance criteria
   clearly; otherwise leave the skeleton text plus a single `- To be decided.`
   line.
5. Commit:

   ```sh
   git add .specs/<N>-<slug>/SPEC.md
   git commit -m "docs(spec): start #<N> <slug> (#<N>)"
   ```

6. Tell the user the branch name and the SPEC path, and that the next step is
   to fill in Scope and Test plan as the approach settles, in the same commits
   as the code.

## SPEC template

```markdown
# #<N>: <title>

- Issue: #<N>
- Branch: <N>-<slug>
- Started: <YYYY-MM-DD>

## TL;DR
One or two sentences: what is changing and why. This becomes the pull request
description, so keep it true as the work moves.

## Scope
In scope:
- To be decided.

Out of scope (and where it goes instead):
- To be decided.

## Test plan
To be filled in as the approach settles: the automated tests added or changed,
any manual check with the exact command, and what could not be tested and why.

## Follow-ups
Anything found but deliberately not done here, each with an issue link once
filed.

## Log

### <YYYY-MM-DD>: branch and SPEC skeleton
- What changed: started the branch from `origin/main` and created this SPEC.
- Why: every change starts from an issue, and the SPEC is the first commit.
- Supersedes: nothing, additive.
- Commits: (this commit)
```

## Notes

- If a branch named `<N>-<slug>` (or any branch starting `<N>-`) already
  exists locally or on `origin`, do not create a new one. Say so, and offer to
  check it out and read its SPEC, which is the "picking up someone else's
  work" path in DEVELOPMENT.md section 5.
- If a SPEC already exists for this issue (`.specs/<N>-*`), say so rather than
  creating a second one; one issue has one SPEC.
- The SPEC is public text and goes through the leak gate (`pnpm check:leaks`)
  like the code. Link issues by number (`#<N>`), and keep the file ASCII.
