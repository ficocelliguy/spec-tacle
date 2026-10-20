---
name: visual-pr-review
description: >
  Review the changes on the current branch and propose the 10 most impactful improvements,
  ranked most-to-least important, delivered as a dark mode HTML report. Use when the user asks
  for a "PR review", to "review my branch/changes/PR", "review this before I open a PR", or similar.
  Invoked as /visual-pr-review. Diffs against the branch's
  true fork point (which may NOT be main/master), includes uncommitted changes, and evaluates
  the changes as a cohesive unit. Emphasizes code quality, cleanliness, separation of concerns,
  test coverage, and accessibility. Read-only for the repo — proposes changes, does not apply them
  unless asked. The only file it writes is the report.
argument-hint: (optional) a base ref to diff against, if the auto-detected fork point is wrong
user-invocable: true
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Write
---

# PR review

Review the current branch's changes and return **exactly 10 proposed changes, ranked from most
important to least important**. This is a review, not an implementation task: **do not edit any
files in the repo** unless the user explicitly asks you to apply a suggestion afterward. The HTML
report in section 5 is the one file you write, and it goes outside the repo.

## 1. Determine the diff range

The base is the point where the current branch diverged — **this is often NOT main/master**,
because the user sometimes branches off another feature branch. Detect the true fork point:

1. Get the current branch: `git rev-parse --abbrev-ref HEAD`.
2. If the user passed a base ref as an argument, use that as the base and skip auto-detection.
3. Otherwise auto-detect the parent branch and merge-base:
   - Find the most likely parent branch (the branch this one forked from). Try:
     `git show-branch -a` reasoning, or the reflog: `git reflog show <branch> | tail`, or
     compare merge-bases: for each candidate branch (`main`, `master`, and other local branches),
     run `git merge-base <branch> <candidate>` and pick the candidate whose merge-base is the
     most recent ancestor (i.e., the closest fork point that isn't the branch tip itself).
   - A reliable heuristic: `git merge-base --fork-point <candidate> <branch>` when available,
     otherwise `git merge-base <candidate> <branch>`.
4. If detection is ambiguous, **state which base you chose and why**, and tell the user they can
   re-run with an explicit base ref (`/visual-pr-review <base>`).

## 2. Gather the changes

Include **both committed and uncommitted** work so the review reflects the full branch state:

```
git diff <base>...HEAD          # committed changes on this branch
git diff HEAD                    # unstaged changes
git diff --staged               # staged-but-uncommitted changes
git status --short              # untracked files — read new files directly
```

Read new/untracked files in full. Read enough surrounding context of changed files to judge each
change fairly — don't review a hunk in isolation if the file gives it meaning.

## 3. Evaluate the changes as a cohesive whole

Review **only the branch's own changes** and how they fit together — do not propose rework of
pre-existing code that the branch didn't touch (unless a change is actively broken by it). Judge
whether the added pieces cohere: consistent patterns, no duplication introduced across the new
files, sensible boundaries.

Emphasize, in roughly this priority order:

- **Correctness & risk** — bugs, broken edge cases, regressions, unhandled states.
- **Code quality & cleanliness** — clarity, naming, dead code, commented-out code, leftover
  debug/print/log statements, magic values, inconsistent formatting, and duplication. The added
  code should match the conventions and idioms already used in this repo and read like it belongs.
- **Separation of concerns** — logic living in the right layer/module, units not doing too much,
  clear boundaries between responsibilities, reusable pieces extracted where warranted. (For a
  UI codebase this means presentation vs. business logic vs. data access; for a backend/library
  it means handlers vs. services vs. data layers, or equivalent boundaries for the stack at hand.)
- **Accessibility (frontend/UI repos only)** — if the changes include user-facing markup/templates
  (HTML, JSX/TSX, Angular templates, etc.), flag a11y issues: missing labels/alt text, non-semantic
  elements used as controls, missing ARIA where needed, keyboard/focus handling, color-contrast-
  dependent meaning, and form field associations. Skip this concern entirely for repos with no UI
  layer — don't invent a11y findings where there's no user-facing surface.
- **Test coverage** — every new behavior, branch, and edge case introduced by the changes should
  have a corresponding test. Flag untested logic, missing edge-case/error-path tests, and assertions
  that don't actually verify the new behavior. Use whatever test framework and patterns the repo
  already uses.

## 4. Findings

Produce **10 proposed changes, ranked #1 (most important) → #10 (least important)**. For each:

- A one-line title.
- The `file_path:line` reference(s) it applies to.
- A short explanation of the problem and the concrete suggested change.
- A tag of which concern it addresses (e.g. `[correctness]`, `[separation of concerns]`,
  `[accessibility]`, `[code quality]`, `[tests]`).

If there genuinely aren't 10 distinct worthwhile changes, list the real ones and note that the
remainder would be minor nitpicks rather than padding the list.

## 5. Report

Deliver the findings as a single self-contained HTML document, not as a list in the terminal.

- **Prose:** follow section 6 for every sentence in the report: titles, explanations, and the
  summary.
- **Theme:** dark mode. Dark background, light text, and severity or concern colors that keep
  readable contrast against it. Do not ship a light theme or a toggle.
- **Contents:** the branch and the base ref diffed against at the top, a one-line count of
  findings by concern tag, then one block per finding in rank order with its title, tag,
  `file_path:line` references in monospace, the problem, and the suggested change.
- **Tracking checkboxes:** give each finding two labeled checkboxes in its header, "Reviewed"
  and "Fixed", so the user can mark progress. Use real `<input type="checkbox">` elements with
  `<label>`s. Ticking "Fixed" also ticks "Reviewed". Show a progress line under the counts
  (e.g. "Reviewed 3 / 9 · Fixed 1 / 9") that updates as boxes change. Dim a finding's block
  once it is marked Fixed. Save the state in `localStorage` under a key built from the branch,
  the base ref, and the finding's rank, so a reload keeps the marks. Wrap every storage read
  and write in try/catch so the page still works when storage is unavailable.
- **File:** inline all CSS and JS. The only script allowed is the small one that drives the
  checkboxes and progress line; no external scripts or libraries. Write it to the session
  scratchpad directory if one is listed, otherwise `$TMPDIR`, named `<branch>-review.html`.
  Never write it inside the repo.
- **Open it:** run `open <path>` so it lands in the browser. If the sandbox blocks that, give
  the user the exact command to run with the `!` prefix.

In the terminal, reply with the base ref, the report path, and the titles of the top three
findings. Then offer to apply any subset the user picks.

## 6. Writing rules

Apply these to the report and the terminal reply. Write like a senior engineer leaving review
comments: name the code, say what breaks, say what to change.

**Be concrete.** Name the function, the input, and the failure. "Error handling could be more
robust" becomes "`parseConfig` throws on an empty file and the caller at `cli.js:42` doesn't
catch it." Names, values, line numbers, and mechanisms beat abstractions. If a sentence could
move unchanged into a review of a different repo, cut it or replace it with a fact about this
code.

**Use active voice and direct verbs.** "`render()` mutates the input array," not "the input array
is mutated." "Has the ability to" becomes "can"; "make a decision" becomes "decide." Prefer
"is" and "has" over "serves as" and "acts as."

**Show the consequence, don't label it.** Skip "this is important," "this is subtle," "this
matters." Say what happens: "A second click submits the form twice."

**Repeat the right term.** If the code calls it a `session`, call it a session every time. Don't
rotate to "context," "state," and "connection" for variety.

**Banned words:** delve, foster, leverage, utilize, facilitate, empower, streamline, robust,
cutting-edge, paradigm shift, game changer, tapestry, realm, beacon, multifaceted, meticulous,
intricate, paramount, transformative, elevate, embark, supercharge, harness, ever-evolving.

**Cut when empty:** just, simply, actually, truly, fundamentally, importantly, crucially,
inherently; "it's worth noting," "it's important to note," "when it comes to," "at its core,"
"in terms of," "with regard to," "in order to," "going forward."

**Patterns to cut:**

- Binary contrasts ("This isn't a style issue, it's a correctness issue"). State the claim
  directly.
- Throat-clearing and faux-insight openers ("Here's the thing," "What's easy to miss").
- Colon reveals ("The catch: it never resets"). Write a plain sentence.
- Trailing `-ing` clauses that pretend to explain ("…, highlighting a gap in validation").
- Importance puffery ("plays a vital role," "a key part of the architecture").
- Weasel attribution ("best practice says," "it's widely recommended"). Cite the repo convention
  or the doc, or make the argument yourself.
- Dramatic fragments and fake-profound closing lines.
- Summary-recap endings that restate the findings.

**Formatting:** no emoji, no bold scattered mid-sentence, no subtitles or taglines under headings.
Headings name what the section contains. Use a bullet list only when the items are parallel;
two sentences of prose usually read better. Avoid em dashes; use a period, comma, or parentheses.
