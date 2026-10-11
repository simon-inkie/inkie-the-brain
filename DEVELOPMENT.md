# Development workflow

How changes get made in this repository. It applies to everyone: human
contributors, and AI coding agents of any runtime. If you are an agent, read
this file in full before your first commit; your tool's own instructions file
(`CLAUDE.md` or similar) only points at [AGENTS.md](AGENTS.md), which points
here.

[AGENTS.md](AGENTS.md) is the single source for the short rules (issues as the
source of truth, branch naming, what an agent may not do). This file describes
the workflow around them: the SPEC, the checks, review and handover.

For setting up a machine, see [README.md](README.md) and
[QUICKSTART.md](QUICKSTART.md).

## The short version

1. Start from a GitHub issue, on a branch named `<issue>-<slug>` off `main`.
2. Non-trivial work keeps a SPEC at `.specs/<issue>-<slug>/SPEC.md`. The
   branch's first commit creates it, using the branch name as the folder name.
3. Keep the SPEC current in the same commits as the code: decisions, dead
   ends, and why.
4. Open a pull request whose description comes from the SPEC's TL;DR and says
   `Closes #<issue>`. CI and a review must pass before a maintainer merges.
5. Anyone picking the work up starts by reading the SPEC.

`start-issue` does steps 1 and 2 for you: see
[.agents/skills/start-issue/SKILL.md](.agents/skills/start-issue/SKILL.md).

## 1. Start from an issue, on a branch

GitHub issues on this repository are where work is defined and tracked. Other
trackers or chat may mention the work, but the issue is what the branch, the
SPEC and the pull request point at.

An issue comes before the work. Search open and closed issues first; if one
exists, comment that you are taking it, or ask the assignee. If none exists,
open one: what is wrong or missing, how you saw it, and what "done" looks like.
Keep one issue to one coherent fix; split anything that would make a reviewer
read two unrelated changes.

Read the issue with `gh issue view <N>`. If the GitHub CLI is not installed,
not authenticated, or refused by your environment, use whatever GitHub tools
your runtime provides (for example a GitHub MCP server's issue reader) rather
than guessing the title or stopping.

Once you have the number:

```sh
git fetch origin main
git switch -c <issue>-<slug> origin/main
```

Branch names are short and kebab-case, led by the issue number, for example
`14-contributor-workflow`.

Trivial changes (a typo, a one-line config tweak, a broken link) can go
straight to a pull request without an issue or a SPEC. If you are unsure
whether something is trivial, it is not.

## 2. The SPEC folder

The first commit on the branch creates:

```
.specs/<issue>-<slug>/SPEC.md
```

using the branch name as the folder name. Anything else the work needs
(notes, captured output, small diagrams) can live in the same folder. The
folder is committed and merged with the code; it is the permanent record of
why the change looks the way it does.

A starting SPEC can be ten lines. Use this skeleton:

```markdown
# #<issue>: <issue title>

- Issue: #<issue>
- Branch: <issue>-<slug>
- Started: <YYYY-MM-DD>

## TL;DR
Two or three sentences: what is changing and why. This becomes the pull
request description, so keep it true as the work moves.

## Scope
In scope:
- ...
Out of scope (and where it goes instead):
- ...

## Test plan
To be filled in as the approach settles. What proves this works: automated
tests added or changed, any manual check with the exact command, and what
could not be tested and why.

## Follow-ups
Anything found but deliberately not done here, each with an issue link once
filed.

## Log
(append-only; see below)
```

The SPEC is scanned by the leak gate like everything else. Write it as public
text: no real names, hosts, home-directory paths or private ticket ids, and
link issues by number (`#14`) rather than by URL.

## 3. The SPEC is a running commentary

The SPEC records the work as it happened, not a tidy summary written at the
end. A retrospective SPEC loses exactly what the next person needs: the pivots,
the approaches that failed and why, and the constraints that were only
discovered halfway through.

Rules:

- **Update it in the same commit as the code it describes.** A commit that
  changes the approach also changes the SPEC. No end-of-branch "update docs"
  commit.
- **Append to the Log; do not rewrite history.** Earlier entries stay as they
  were written. If a decision is reversed, add an entry that says so and
  names what it supersedes. You may keep TL;DR, Scope and Test plan current,
  because those describe the present state; the Log carries how it got there.
- **Record dead ends.** "Tried X, failed because Y" saves the next person the
  same afternoon.
- **Record review outcomes.** For each review finding: fixed (which commit),
  declined (why), or deferred (to which issue).
- **Put anything that is live and wrong where a reader will meet it.** If you
  ship a known limitation or defer a known bug, state it in the TL;DR, in the
  pull request description, and in a comment next to the code. A note at the
  bottom of the Log is not enough on its own.
- **Comments state what the code guarantees, not what you meant it to do.** If
  a comment claims a property of a language or library feature, check that the
  feature really has it.
- **Do not invent entries.** If you add a missed entry later, date it from
  `git log` and mark it `(retrospective)`. Leave a gap rather than guess.

Log entry format:

```markdown
### <YYYY-MM-DD>: <short description>
- What changed: <one or two sentences>
- Why: <decision, discovered constraint, review finding, dead end>
- Supersedes: <earlier entry or section, or "nothing, additive">
- Commits: <short sha> <subject>
```

What earns an entry: a commit that moves the work forward, a change of scope
or approach, a review finding and how it was resolved, a follow-up filed.
What does not: typo and formatting fixes.

## 4. Pull requests and review

Before opening:

- Merge or rebase the latest `main` into your branch, so the review diff is
  only your change.
- Run the checks locally from a clean tree (commit or stash first):

  ```sh
  pnpm install --frozen-lockfile
  pnpm typecheck
  pnpm test
  pnpm check:leaks:self-test
  pnpm check:leaks
  pnpm check:licence
  ```

  CI runs the leak and licence gates (`.github/workflows/guards.yml`) and the
  install test (`.github/workflows/install-test.yml`, Docker plus a macOS
  build). The install test needs Docker and an embeddings key, so most
  contributors cannot run it locally; say so in the Test plan rather than
  implying it passed.

- Make sure the SPEC's TL;DR, Test plan and Follow-ups are current.

Opening:

- Title: a short imperative sentence in `type(scope): summary (#issue)` form,
  matching the history, e.g.
  `fix(precompact): don't let diagnostic-log setup block the indexer spawn (#7)`.
- Description: the SPEC's TL;DR, a link to the SPEC file, the test plan, and
  `Closes #<issue>`. Call out anything live and wrong at the top.
- Say plainly what could not be tested and why: a check you could not run, a
  platform you do not have, a path only CI exercises. Reviewers would rather
  know than find out.
- One pull request per issue, scoped to one change. If one is growing past
  reviewable, split it and say so in the SPEC.
- Agents open the pull request and stop there. A maintainer merges.

Review:

- CI must be green.
- At least one approving review from someone other than the author. An agent
  cannot approve its own work, and a second agent run by the same person
  reviewing the same diff is not independent review; give the reviewer the
  change and the issue, not your justification for it.
- Reviewers look at scope, intent and design as well as line-level
  correctness: does the change do what the issue asked, and nothing else?
- Resolve every review thread with a reply: fixed in a named commit, declined
  with a reason, or deferred to a named issue. Record the same in the SPEC Log.
- Do not force-push over commits a reviewer has already commented on without
  saying so.

After merge: file any follow-ups listed in the SPEC as issues and link them
from it.

## 5. Picking up someone else's work

The SPEC is the handover. Whether you are a new contributor, the same person a
week later, or an agent starting a fresh session, begin here:

1. Read the issue, then the whole SPEC, top to bottom, including the Log.
2. Compare the SPEC against the branch: `git log --oneline origin/main..HEAD`
   and `git diff origin/main...HEAD`. The last Log entry should match the last
   meaningful commit. If there are commits the Log does not explain, the SPEC
   is stale; find out what they did before building on them.
3. Check the pull request, if one is open, for unresolved review threads.
   Read all of them, not just the most recent.
4. Run the checks on a clean tree to learn the true starting state rather
   than assuming the last session left it green.
5. Before you change anything, add a Log entry saying you have picked the work
   up, what state you found it in, and what you intend to do next.
6. If you are taking over from someone who may still be active, say so on the
   issue first.

If you stop partway, leave the SPEC in a state the next person can act on: the
last Log entry says what is done, what is in progress, and the next concrete
step.

## Notes for AI agents

- This file is the workflow and [AGENTS.md](AGENTS.md) holds the short rules;
  your runtime's own file is only a pointer. If they disagree, these two win
  and the pointer should be fixed.
- Do not push to `main`, force-push shared branches, merge your own pull
  request, or create releases unless a maintainer has asked you to in the
  issue or pull request.
- Keep the SPEC current as you go even within a single session; a session can
  end at any point, and the SPEC is all the next one gets.
