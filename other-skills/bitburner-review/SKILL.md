---
name: bitburner-review
description: Full review of a bitburner-src diff or PR. Covers correctness bugs plus the project's design, API, save-data, balance, React and style standards, so issues get fixed before maintainers have to point them out. Use when the user asks for a "full review", "thorough review", or "maintainer review" in the bitburner-src repo. For a quick bug check only, use /code-review instead. Delivers the same dark-themed HTML tracker, with an extra Code Standards section.
---

Review target: `$ARGUMENTS`

`full review → 5 bug angles + 4 standards angles → verify → sweep → ≤15 bugs + ≤25 standards notes`

This is a variant of the user's base `code-review` skill, tuned for
bitburner-src. **First Read `~/.claude/skills/code-review/SKILL.md`.** Its
Phase 0 (gather diff), bug angles A–E, verify semantics, sweep, and the full
HTML tracker spec (structure, CSS palette, persistence script, open-in-browser,
`--comment` mode) all apply unless overridden below.

The project's recurring code-quality standards are in the **Review
standards** section at the end of this file. Every standards-angle agent gets
that section's full text.

The goal is good code overall: catch and fix up front anything a careful
bitburner maintainer would raise in review. Findings are framed as
improvements to the code, never as quotes or opinions attributed to any
person. Don't name reviewers or cite past PRs in findings.

**Either-is-fine items.** Some standards list two acceptable approaches. If
the code follows either one, it's fine and must not be flagged. Flag it only
when the code follows neither, and then offer both approaches as fix options.

## Phase 0: Gather (extends the base skill)

Do everything the base Phase 0 does, plus:
- If reviewing a PR, also gather the PR description, since it should explain
  any non-obvious change, and the list of changed files.
- Note whether the diff touches: save/load (`SaveLoad`, `JSONReviver`, any
  class with `toJSON`/`fromJSON`), `NetscriptDefinitions.d.ts`,
  `RamCostGenerator.ts`, `src/utils/APIBreaks/`, React components, balance
  constants, docs under `src/Documentation/`, or `package-lock.json`. Tell
  the angles below which of these apply.

## Phase 1: Find candidates (9 angles)

Run the base skill's **angles A–E** unchanged (bug hunting, up to 8 each).
Add Bitburner-specific bug focus to their prompts: async/promise ordering in
the Go / Terminal / Darknet code, every exit path of a UI flow (cancel, quit,
close, unmount), save/load round-trips, and NS-API input validation via
`helpers.*`.

Then run **four standards angles** in parallel. Each one gets the diff, the
full Review standards section, and its section focus. Each returns up to 8
candidates. Each candidate must name the standard it applies
(section + bullet) and quote the offending line.

### Angle F: architecture, async, state (standards §1, §2, §3, §4)
Sleep or setTimeout hacks, papered-over promise problems, boolean flags that
race, multiple `Date.now()` reads, instance vs singleton confusion, getters
with side effects, broken invariants, defensive guards that hide bugs, test
code in production, test changes that hide flakiness, and diff hunks whose
semantic change isn't explained.

### Angle G: API, save data, balance (standards §7, §8, §9)
NS signature shape (options objects, `host` naming, formulas purity, RAM cost
of anything that probes for servers), whether an API-break entry or
breaking-change note is needed, whether `Result<T>` is reused, a migration
decision for every saved-field change, new persisted counters, removed tuning
knobs, stacked random gates, compounding multipliers, exit-path exploits,
BitNode multiplier coverage for new income sources, and whether the PR shows
the math for rate or reward changes. When a balance change has no supporting
calculation, say so. Don't invent numbers.

### Angle H: React, UI, player-facing text, docs (standards §10, §11)
useEffect cleanup and dependencies, `&&` with numbers, `validateDOMNesting`,
camelCase style keys, `onClose` getting an event argument, controls that
can't act, dev buttons, help or tooltip text, TSDoc formatting (line breaks,
`@remarks`), relative doc links, spoilers, and how faithful terminal features
are to a real shell.

### Angle I: idiom, simplification, hygiene (standards §5, §6, §12)
`isNaN` / `isFinite` vs `Number.isFinite`, clamp, redundant annotations or
casts, enum style, shorthand properties, spread order, functional chains that
should be `for...of`, single-use helpers, re-implemented utilities (Grep for
an existing one before flagging), copy-pasted blocks, missing analogue
patterns, unneeded exports, stale comments or names, unrelated changes,
leftover TODOs, dev flags, and lockfile churn.

## Phase 2: Verify

Bug candidates: verify exactly as in the base skill (CONFIRMED / PLAUSIBLE /
REFUTED).

Standards candidates: one verifier each, which must answer:
1. **Does the code actually do this?** Quote it.
2. **Does the standard really apply here?** Check for the stated exception
   (for example, a helper that names a logical unit of work, or `!!` where the
   value can't be a number), an existing codebase precedent that allows it,
   a PR description that already justifies it, or, for an either-is-fine
   item, whether the code already follows one of the accepted approaches.

Return **CONFIRMED** (both yes), **PLAUSIBLE** (a reasonable judgment call),
or **REFUTED**. Drop REFUTED.

## Phase 3: Sweep

As in the base skill, one fresh finder with the verified list looks only for
gaps. It covers both bugs and standards. It should check in particular:
changes outside the PR's stated purpose, every new `export`, every new
`Math.random()`, every new saved field, and every new NS function or
parameter (docs + RAM cost + API-break entry).

## Phase 4: Compose

Two tracks:

**Bugs** follow the base skill: ≤15, severity `critical|high|medium|low`, with
the same fields.

**Code standards** has ≤25 entries, each with tier:
- `blocking`: would likely hold up the PR (test code in production, sleep
  hacks, broken invariants, missing API-break entry, save exploit, unrelated
  changes, removed tuning knobs).
- `should-fix`: expected to be fixed before merge (inlining helpers, options
  objects, idiom fixes, React cleanup, doc formatting).
- `optional`: nits (naming, comment voice, minor style).

**The caps are limits, not quotas.** Never pad a track to reach them. If a
track or tier has only very minor items, leave it out completely and say in
one line that nothing significant came up. When a track has more significant
(non-minor) items than its cap, show the most important ones. Then count the
significant items that were left out, and keep that count per track.

Each entry has: `file`, `line`, `tier`, `title`, `standard` (short paraphrase
of the standard and why it matters), `what` (the offending code and why it
falls short), and `suggested_fix`. For an either-is-fine item, `suggested_fix`
lists both accepted approaches as options.

## Phase 5: Deliver

Use the base skill's HTML tracker, written to
`tmp/<target-slug>-full-review.html`, with these additions:
- After the bug severity sections, add `<h2>Code Standards</h2>` with three
  sub-sections, Blocking, Should fix and Optional, each with its own TOC entry
  and counters. Card classes are `issue blocking|shouldfix|optional`, with
  border colors `--high`, `--medium` and `--low`.
- Each standards card shows a `<p class="pref">` with the standard, between
  `.what` and `.fix`.
- If a track left significant items out, end that track with a
  `<p class="omitted">` note, for example "6 more significant bug findings
  not shown. Address these, then re-run /bitburner-review." Leave the note
  out when nothing was left out.
- If a track was skipped because it had only minor items, show a single line
  saying so instead of empty sections.
- `STORAGE_KEY = "bitburner-review:{target-slug}-{date}"`.

## Chat summary

After writing and opening the HTML:
- path, plus counts per bug severity and per standards tier
- the 2–3 most important bugs and the 2–3 most important blocking standards
  issues
- any leftover dev or test code, TODOs, or missing API-break or migration
  decisions, called out explicitly as pre-merge blockers
- for each track that left items out: how many significant items weren't
  shown, plus a reminder to fix the current ones and then re-run
  `/bitburner-review` to see the rest

## Review standards

The project's code-quality standards for bitburner-src, distilled from past
review history. Use them to catch issues before a PR goes up. They describe
what good code looks like in this codebase; findings should be framed as
improvements to the code, not as anyone's opinion.

Format: **Rule.** Why.

Some topics have **two acceptable approaches** (marked "Either is fine").
Code that follows either one is fine — don't flag it. Flag only code that
follows neither, and offer both approaches as fix options.


### 1. Async, promises, timing

- **Sleeping or `setTimeout` is never the fix for an async problem.** Don't
  use `await sleep(50)` / `setTimeout(..., 10)` to "let things settle". Await
  the real promise. A hack that's unavoidable needs a big comment saying why,
  and it should be used only where needed, not everywhere. Tests shouldn't
  sleep either.
- **Don't patch over orphaned or overwritten promises.** A fallback like
  "resolve if the other player moves" turns real bugs into weird edge cases
  nobody can reproduce. Fix why the promise got orphaned.
- **Fix the bad state at its source.** Don't let state get bad and then handle
  it downstream. If promises should always be initialized, initialize them, and
  don't add handling for the uninitialized case.
- **Boolean "busy" flags race.** Store the promise or token itself and compare
  identity before clearing, so a stale async chain can't clear a newer one's
  flag.
- **Assign chained promises back.** `x.finally(...)` creates a new promise. If
  callers should wait on it, store it.
- **Read the clock once.** Pass one `timestamp` through a whole calculation
  instead of calling `Date.now()` several times. Rewards should freeze when
  the action starts.
- **Don't make functions `async` if they never `await`.** That includes NS API
  wrappers.
- **No `void` on an ordinary call** unless it's needed to mark a floating
  promise on purpose. It reads like a declaration.
- **One code path.** Manual play and script play, or UI and API, should go
  through the same handler. Don't add parallel special cases.

### 2. State ownership and invariants

- **Instance vs singleton.** A function that takes a `boardState`, server or
  similar must not change global or UI state, because many instances can exist
  at once (analysis copies, user-provided boards). Decide whether the data
  belongs to the instance or the top-level state, and stick to it.
- **Local beats global for reasoning.** Swapping a file-scoped variable for a
  global is a subtle change, because globals can be modified anywhere. It
  needs a justification.
- **`get*` must be idempotent.** Getters must not lazily create or write
  state. Initialize ahead of time, or return a default without changing the
  map.
- **Keep the game's invariants.** For example, `AllServers` / `getServer`
  contain only servers that exist, plus tombstones for dead dnet servers. Don't
  register all variants when only one exists.
- **Avoid new global state blobs.** Put values with the module that owns them
  (for example, the last-run PID belongs on `Terminal`).
- **Higher layers handle shared responsibilities.** For example, closing
  stdIO on cancel belongs in `Terminal`'s `TerminalAction` handling, not in
  every implementor.
- **Keep internals private.** Don't export what isn't used outside the file.
  Entry points are public; their helpers are not. Group related entry points
  together.
- **Every diff hunk should have an obvious reason.** Unexplained semantic
  changes, even type-only tweaks like `&& x` → `&& x > 0`, raise the question
  of whether behavior changed. Explain or revert them.

### 3. Fail loudly; don't hide errors

- **Drop defensive null guards that hide bugs.** `if (!server) return` in a
  place where `server` can't be null should go; let it throw on dereference.
- **Don't sanitize impossible values.** Don't NaN-check data that can't be
  NaN. Let the NaN reach the output so the bug shows.
- **No numerical cosmetics** like `Math.abs(x) < 1e-10 ? 0 : x`. Return the
  value.
- **Don't change real behavior just to fix a display problem.** A clamp or
  asymptote added for display changes gameplay. Clamp in the UI, or show
  both the clamped and unclamped values.
- **Don't clamp a tracked quantity to fake recovery.** Leave the moving average
  alone and adjust where it's consumed.
- **Raise errors where the user will see them.** In UI flows, use a snackbar
  or toast, not `console.warn`. Close the modal only if the next step
  actually worked.

### 4. Test code and tests

- **No test-only code in production.** No `if (!CONSTANTS.isInTestEnvironment)`
  branches, no helpers that only tests use, no return values that exist only so
  a test can check them. Mock in the test instead. Note:
  `src/NetscriptFunctions/Darknet.ts` already has one; don't add more.
- **Don't make the API awkward for testability.** Avoid injected logger or
  error closures and one-implementation interfaces. Build a mock `ctx` instead.
- **Don't hide flaky tests by disabling systems.** Find the leak instead; a
  flaky test often points at a real bug (for example, an event that's never
  cancelled across a prestige).
- **Use the house patterns.** `expect(() => ...).toThrow(...)`. Golden JSON
  files are optional for large save fixtures.
- **Tests are welcome.** Never suggest removing extra tests.

### 5. TypeScript and JS idioms

- **Use `Number.isFinite`, not global `isNaN` or `isFinite`.** The global
  versions coerce, so `isFinite("")` is true.
- **Prefer `clampNumber` to hand-written `Math.min` / `Math.max`.** Getting
  the direction backwards is a recurring bug.
- **Don't add redundant type annotations.** TS is structurally typed. Don't
  annotate what the compiler already infers, for example
  `const x: Play = {...} as const`.
- **No gross casts.** `x as unknown as GoOpponent` should become a cast of the
  container, for example `Go.stats as Record<string, OpponentStats>`. Don't lie
  to the compiler: an `assertX` that checks 4 of N fields is a lie.
- **`s == null`** is the accepted check for null-or-undefined.
- **Don't make a constant that just aliases `null`** (`IO_STREAM_CLOSED = null`).
  Readers will expect a unique value.
- **New enum-like data uses `as const` objects, not TS `enum`.** Register it
  in `src/Enums.ts` so names can't collide. Either naming is fine:
  (a) the NetscriptDefinitions.d.ts convention — data `X`, enum type
  `XEnumType`, member values `XType = _ValueOf<XEnumType>`; or (b) a type
  sharing the value's name. Flag only naming that matches neither.
- **Use `as const` on literal lookup objects.**
- **Use shorthand properties** (`{ depth }`, not `{ depth: depth }`).
- **Put defaults first in object spreads:** `{ ...defaults, override }`.
  Otherwise the defaults overwrite explicit values.
- **Compare dates by number:** `a.getTime() > Date.now()`, not Date objects.
  Someone might later add `===`.
- **Avoid "clever" operators:** `x ||= 1` on a number should be an explicit
  `if (x === 0)`.
- **No invisible characters in source.** Write `"​"` with a comment, never
  a literal zero-width space.
- **Use positive logic.** `previousPlayer === GoColor.white` reads better than
  `!== GoColor.black`. If-chains should obviously cover every branch.

### 6. Loops, helpers, abstraction level

- **Prefer `for...of` loops to long functional chains.** Build the result step
  by step instead of hiding it behind split/map/join. Use `for...of` with
  `continue` instead of `filter` + `map` with `?.`, so TS narrows the type.
  The codebase is moving toward for-of.
- **Use the right built-in.** `.some(Boolean)` instead of
  `.filter(x => x).length`, and `Object.keys` instead of
  `Object.entries().map(([k]) => k)`.
- **Inline single-use helpers.** The exception is a helper that names a
  logical unit of work, like a `read()`. Wrapping a `while` loop in
  `onRead(callback)` loses clarity.
- **Don't re-implement existing utilities.** Improve the existing one instead
  (`getFriendlyType`, `userFriendlyString`, `matchScriptPathExact`,
  `getAugLevel`, `getNewBoardState`). Duplicates drift and pick up bugs.
- **Deduplicate copy-pasted blocks.** Extract the shared piece. For a long run
  of near-identical builders, use a factory.
- **Model new code on existing analogues.** `IDarknetServer` should mirror
  `IServer`, constructors take `IConstructorParams`, new augs should work like
  NFG, and results should reuse NetscriptDefinitions' `Result<T>`, not a
  lookalike.
- **Return a class, not a fresh object of closures.** Closures are allocated
  per instance. Likewise, adding **properties** to `NS` costs startup time in
  every script; use functions.
- **Avoid premature optimization** such as caching or memoizing on
  `.length` / `.size`, which misses changes that keep the size the same.

### 7. Function signatures and NS API design

- **Use an options object instead of consecutive boolean or optional positional
  args.** For NS APIs, use an options object even for a single optional
  setting, like the DOM APIs do: it gives a natural absent/false/true state
  and room to grow. Make a flag required if it's always passed.
- **Unspecified should follow the player's setting** (least surprise). For
  example, editor mode falls back to `Settings.MonacoDefaultToVim`.
- **Formulas are pure.** `ns.formulas.*` must not read or write game state
  (BN mults and int are the usual exceptions). Take full objects (a
  `DarknetServer` or `Person`), not hostnames. Take explicit inputs, such as
  a correct-character count, so players can compute the result themselves.
- **Parameter naming:** `host` means hostname *or* IP. Don't prefer hostname
  over IP in the API.
- **Keep interfaces consistent.** Include fields that still make sense even
  when constant, like `cpuCores` and `purchasedByPlayer`, so player code
  doesn't need special cases. Leave out ones that don't make sense
  (`numOpenPortsRequired`).
- **Return structured `Result<{...}>`, not HTTP-style status strings.**
  "Estimated" in a name implies randomness on top; use it only then.
- **RAM cost:** any function that can probe whether a server exists should
  cost at least 0.05 GB (like `dnsLookup`).
- **API breaks:** any behavior change that can break scripts needs an entry in
  `src/utils/APIBreaks/<version>.ts` and a breaking-changes note.
  Understand `showWarning` (terminal warning) vs `doNotSkip` (always logged to
  `APIBreakInfo.txt`) before choosing them.
- **Don't break existing player strategies for flavor.** For example, IPs as
  stable keys. A breaking or nerfing change needs a gameplay reason.

### 8. Save data

- **A field change in a saved object needs a migration decision.** Look for
  double-gain or skipped-gate exploits across the save transition, and make
  the call on purpose, even if the call is "no code needed".
- **Save raw data, not reconstructions.** Saving a length and rebuilding the
  values on load is more complex and can be exploited. Keep saved state to
  one or two values where possible (for example an EMA plus a timestamp).
- **Don't add persisted counters just to throttle things.** They're fragile
  and hard to analyze. Tune the formula instead (but see the rate-limit item
  in §9).
- **No migration needed** when state fixes itself on the next install or
  prestige and is only slightly odd until then.

### 9. Balance and game design (comment even if not a code bug)

- **Keep the tuning knobs.** Don't delete a formula that controls frequency
  just because the current numbers are wrong; change the constants.
- **Fewer random factors.** Tune a probability directly, not through chained
  conditionals (where P(reaching the line) × P(the line) is hard to see).
  Question each new `Math.random()` gate.
- **Rate limiting strong rewards. Either is fine:** (a) a tuned probability or
  rate formula with no cooldown, or (b) a simple hard cap used as a safety net
  for very strong rewards such as CCTs. Flag only a design that does neither,
  such as an unbounded strong reward, or a deterministic cooldown stacked on
  top of random gates (hard to analyze and hard to explain).
- **Show the math.** For any rate or reward change, the PR should include the
  expected-value calculation, a simulator or a Desmos link. Compare against
  the baselines: natural CCT rate is 1 per 40 min (~5.3k rep); rep/s at
  hack 2500 with 50 NFG is ~50/s.
- **Watch compounding multipliers.** Stock volatility, NFG-style mults and
  exponents compound over cycles. Volatility is meant to be static. Mix
  modifiers in as linear factors, not inside `pow`.
- **Every exit path should apply the same restriction.** "Quit" vs "Sell" on a
  victory screen must not bypass the new penalty.
- **Round tuning constants to one significant figure.** More digits claim a
  tuning accuracy that doesn't exist.
- **Make nerfs once, big rather than repeated** (loss aversion). Don't nerf a
  mechanic just because some players dislike it.
- **Scale new income sources by BitNode.** Add multipliers for nodes where
  money or batching is nerfed (BN3, BN9) and group them with the existing
  `*MoneyMultiplier`s.
- **Avoid harsh early-game and big late-game cliffs.** For example 8 GB
  servers early, or capping late RAM so dnet stops being an interesting RAM
  source.
- **Don't spend code defending against prototype tampering.** Players
  can speed up the engine anyway.
- **Docs and example scripts are hints, not solutions.** Don't ship a working
  scanner or batcher. Code meant for players to read should be unusable as-is.

### 10. React and UI

- **Clean up `useEffect` subscriptions:** `return X.subscribe(listener)`.
  Reset module-level flags (`ErrorPageOpen`, `UnreadErrors`) in the cleanup
  function. A missing cleanup leaks subscriptions and causes "state update on
  unmounted component".
- **Get effect dependencies right.** Don't add changing dependencies to a
  run-once effect; split it into another `useEffect`. Don't disable the
  exhaustive-deps lint; use immutable updates. Ask whether a value really
  needs to be React state.
- **Prefer `{cond && <X/>}` over `cond ? <X/> : ""`.** But if `cond` might be a
  number, write an explicit boolean (`count > 0`), because React renders `0`.
- **Fix `validateDOMNesting` warnings.** Use `<Typography component="div">` for
  block content, and test with dev tools open.
- **makeStyles keys are camelCase** (`overflowX`, not `"overflow-x"`). Let CSS
  (line clamp, overflow) handle truncation instead of string slicing.
- **`onClose` gets a synthetic event as its first argument.** Don't treat
  that argument as an optional boolean.
- **Disable controls that can't act.** Don't show "Attempt anyway" or no-op
  buttons.
- **Toggles should stay consistent.** A setting and a temporary toggle that
  share a name must agree, or the tooltip must say which wins.
- **Throttle live-updating values** with `useCycleRerender` / `useRerender`
  (`src/ui/React/hooks.ts`).
- **Dev and testing buttons move to the Dev menu,** or behind the dev flag.
  Don't delete them.

### 11. Player-facing text and docs

- **Explain consequences, not dev rationale.** Players care what changed for
  them, not why it was changed.
- **Keep help text short.** Drop second sentences that don't add anything, and
  don't quote single words.
- **TSDoc line breaks don't carry into generated markdown.** Use `-` lists,
  put `@remarks` in the right place, and check the generated docs
  (`npm run doc`).
- **Doc links are relative** (with the right `..`), not GitHub URLs to `dev`,
  `stable` or a fork.
- **A joke that carries meaning must be explained** (for example, a
  "418 I'm a teapot" status).
- **Terminal features follow real shell defaults** (zsh/bash). Document where
  Bitburner differs, for example that commands always run in the background.
  Don't invent new incompatibilities, like blocking `> script.js`.
- **Lore: no WD or Daedalus spoilers.** Beyond that, either is fine: keeping
  core mysterious characters (jump3r) vague, or expanding on them and adding
  new characters. Flag only spoilers.
- **Fix typos and grammar.**

### 12. PR hygiene

- **No unrelated changes.** Changes that snuck in from another branch,
  drive-by refactors, `package-lock.json` churn, or odd merge artifacts.
  Big unrelated pieces belong in their own PR.
- **Before merge, remove:** local TODO or notes files, dev build flags
  (`npm run build:dev # TODO`), and unresolved `// TODO` placeholders.
- **Update stale comments** when behavior changes. A function whose job has
  grown should be renamed (e.g. `makeAIMove` → `handleNextTurn`) and its doc
  comment should describe everything it now does.
- **Achievements:** run `pack-for-web.sh` after adding an SVG, and check how
  it renders in game, not just in a browser.
