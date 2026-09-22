---
name: spec-tacle
description: Turn a software spec into a browsable HTML visualizer — a technical what/why summary plus editable mermaid diagrams (architecture, user flow, dependency map). Round-trip user edits back into the spec. Use when the user asks to "visualize this spec", "make a spec-tacle for X", "render diagrams for this spec", or points at a spec file and asks for a picture of it.
---

# spec-tacle

Take a written spec, produce an HTML page a person can open in a browser that shows:

1. A tight **technical summary** — a short bulleted list of *what* is being built and one of *why*, sharpened with `no-ai-slop`.
2. A set of **editable mermaid diagrams** — architecture (data/request flow), user flow (task completion paths), and a dependency map (what decisions shape what outcomes). Not every spec needs all three; pick the ones that make the spec easier to hold in your head.
3. **Direct manipulation** — nodes drag, source is editable, annotations can be attached to any node or edge.
4. An **export payload** the user can hand back to reconcile edits into the spec.

The project lives at `_project-management/personal/mike/spec-tacle/`. It contains:

- `template.html` — the reusable HTML shell (mermaid + drag + annotate + inline-edit + export)
- `render.py` — substitutes a JSON data blob into the template
- `serve.py` — local HTTP server that round-trips visualizer edits into the spec file with timestamped backups (see "Live editing" below)
- `example-spec.md` — a fictional Tasky spec used as the reference example, with marker anchors
- `generated/tasky-visualizer.html` — the reference example rendered
- `backups/` — created by `serve.py` next to the spec file (not under `generated/`) on the first Update spec

## When to invoke this skill

- User says: "visualize this spec", "spec-tacle this", "render diagrams for `<file>`", "make a picture of this spec".
- User points at a markdown spec and asks for a visual overview.
- User hands you a `spec-tacle-edits.json` payload and asks you to reconcile it into the spec.

Do **not** invoke unprompted — this produces a real artifact on disk, not chat output.

**If invoked with no target** ("spec-tacle this", "/spec-tacle" with nothing after, a bare skill call), stop and ask what to visualize before doing anything else. Use `AskUserQuestion` (or a plain question if the tool isn't available) to gather inputs. Accept any combination of:

- a spec, design doc, or markdown file already on disk (path)
- multiple files at once — merge them into one spec in Step 0
- a transcript (meeting, interview, sales call, Slack thread) — pasted inline or a file path
- one or more images (whiteboard photos, screenshots, hand-drawn flow) — attach them and read them in
- a PDF, DOCX, Google Doc export, or other bundled format
- freeform text describing the system

Once you have inputs, proceed to Step 0. Never fabricate content to fill a naked invocation — ask.

## What the skill does end-to-end (nothing for the user to type)

The skill runs the full workflow itself using its own shell commands:

1. Writes/updates the markdown spec (Step 0).
2. Drafts summary and diagrams and writes the data JSON (Steps 1–5).
3. Runs `npx spec-tacle render …` to produce the HTML (Step 6).
4. Inserts marker anchors into the spec (Step 7).
5. Runs `npx spec-tacle serve --root … --open …` in the background, which auto-opens the visualizer in the user's default browser (Step 8).

The user should never need to run `npx spec-tacle render` or `npx spec-tacle serve` by hand. If the skill can't run those commands in this environment, say so plainly rather than asking the user to run them.

## Generate a visualizer from a spec

**Step 0 — make sure the input is a markdown spec file.** The round-trip only works when the source is an editable markdown document with anchor markers. If the user hands you something else — a PDF, a call transcript, a design doc in a Google Doc export, a Word file, a Slack thread pasted as text, an image of a whiteboard, multiple files — your first job is to write a fresh markdown spec that captures the substance.

- **PDF, DOCX, or other bundled formats:** extract the text. Read it in full. Then write a new `.md` file next to the source, structured as a normal product spec: title, summary, users, solution overview, core flows, architecture, key decisions, out of scope, open questions. Cite the source file at the top so the reader knows where it came from.
- **Meeting or interview transcript:** treat the transcript as raw material. Pull out the decisions, the components named, the flows described, the constraints, the open questions. Attribute quotes to speakers when it clarifies who owns a decision. Write the markdown spec in your own words, not as a rewritten transcript.
- **Multiple sources:** merge into one spec, and note which source each section came from (a `Source:` footnote under a heading, or a brief inline citation).
- **Ambiguous or thin source:** don't invent structure to fill the gaps. Write down only what the source supports, and list every gap under **Open questions** at the end. Ask the user before making up flow direction, component ownership, or conditional logic.
- **Where to save it:** next to the source file if that directory is writable, otherwise in the project's spec folder. Confirm the path with the user if it isn't obvious.

Once the spec is a markdown file, proceed to Step 1. The rest of the workflow assumes a markdown spec exists on disk.

**Step 1 — read the spec.** Full read. Note the sections that describe systems, actors, flows, and decisions. If the spec has known ambiguity patterns (see JIS `CLAUDE.md` — spatial vs conditional words, unscoped conditionals, collapsed multi-step actions), flag them to the user before continuing. Don't silently pick a reading.

**Step 2 — draft the summary as short bullets.** Two lists, 3-6 bullets each:

- **What.** The system in its simplest true form. One bullet per top-level component, one per user surface, one per data-plane fact. Each bullet stands alone. No adjectives that aren't in the spec.
- **Why.** The problem the system solves and the load-bearing decisions that fall out of it. One bullet per reason. Cite the spec's own reasoning; don't invent motivations.

Bullets, not paragraphs. A reader should be able to scan either list in ten seconds and know what's true. If a bullet needs two clauses, split it. **Bolding in the summary is very sparing** — one or two `**bold**` terms across the *entire* What list and one or two across the *entire* Why list, reserved for the single most load-bearing noun the whole document turns on. Most bullets have no bolding at all. Bolding everything is the same as bolding nothing. Captions, details, and descriptions can bold more freely (see the appendix).

Then run the writing rules from the appendix over every bullet. Cut em-dashes and fluffy short sentences. Never characterize things the spec doesn't say — see `CLAUDE.md`'s "Don't characterize what you can't source" rule.

**Step 3 — pick which diagrams the spec warrants.** Ask "would this diagram make the spec easier to hold in your head?" for each candidate:

| Kind | Use when the spec describes… | Mermaid form |
|---|---|---|
| `architecture` | Components, services, stores, and how requests/data flow between them | `flowchart LR` with directional edges labeled by protocol/payload |
| `user flow` | A sequence of user actions with system responses and branches | `flowchart TD` with a Start node, decision diamonds, and terminal states |
| `dependency map` | Decisions, constraints, or scope items that shape downstream outcomes | `flowchart LR` from decisions to their consequences |
| `state` | An entity with clear states and transitions | `stateDiagram-v2` |
| `sequence` | Messages between named actors over time (auth, handshake, retries) | `sequenceDiagram` |

Fewer, load-bearing diagrams beats a full menu. One is fine. Skip a diagram if the spec doesn't have the content to make it truthful.

**Step 4 — write mermaid for each chosen diagram.**

- **Default direction is left-to-right** (`flowchart LR`, `graph LR`). Only use top-down (`flowchart TD`) when the longest linear path is 8 or more nodes — deep sequences read better vertically. Everything else, including architecture, dependency maps, and shorter user flows, is LR.
- Use the spec's own vocabulary for node labels. Don't rename things.
- Every edge in an architecture diagram carries a label (protocol, event name, or payload).
- Every user-flow branch labels its condition (`ok`, `fail`, `yes`, `no`, `if <predicate>`).
- Node ids are short, stable, kebab or camel — they show up in the export payload when the user annotates them.
- If the spec is genuinely silent on flow direction or condition, leave it unlabeled rather than guess.

**Step 4b — draft a caption and a detail block for each diagram.**

- **Caption** — two or three sentences that sit directly above the diagram. Explain what the picture is, name the load-bearing pieces, and if there's a reading direction (LR / TD / read-both-ways) call it out. Bold one or two key terms with `**double asterisks**`. Do NOT restate the title.
- **Detail** — a paragraph or two (or a bulleted list — see below) that lives in an "About the <diagram title>" section under the diagram. Expanded by default; the reader collapses it with a clearly visible pill-shaped ▸ toggle to the left of the heading. Written for the reader who has time to slow down: what to focus on, how to read the arrows, what the diagram deliberately omits, and any orientation notes. This is where you tell the reader what the diagram *represents* beyond what they can see. Bold key terms sparingly.

Both are plain prose. Apply the writing rules from the appendix to every sentence — clarity above all.

**Step 4d — leave the per-diagram notes slot empty.** Every diagram card in the visualizer has an "Add notes…" area under the mermaid canvas. Users click it to jot general thoughts about that diagram; those notes round-trip into the spec via a `<!-- spec-tacle:diagram:<id>:notes -->` marker section on the next Update spec. Do not fill in `notes` when you generate the data JSON — leave it empty (or omit the field entirely). It's the user's slot.

**Step 4c — seed per-node and per-arrow descriptions.** Hover shows the description; click the tooltip to edit. Seed `descriptions` with one sentence per significant node and arrow that answers "what is this and what does it do" — under ~20 words, don't repeat the label, no bolding. Keys are `"node:<id>"` and `"edge:<edgeId>"` (edge ids are mermaid's `L-<source>-<target>-<n>`; skip the entry if you're not sure and let the user add it in-browser).

**Step 5 — build the data JSON.** Shape:

```json
{
  "title": "<spec title>",
  "subtitle": "<one-line context: source file, date, or empty>",
  "specPath": "<repo-relative path to the spec, used later for reconciliation>",
  "serverUrl": null,
  "sectionMap": {
    "summaryWhat": "summary:what",
    "summaryWhy": "summary:why"
  },
  "summary": {
    "what": ["short bullet", "short bullet", "…"],
    "why":  ["short bullet", "short bullet", "…"]
  },
  "diagrams": [
    {
      "id": "<slug>",
      "kind": "architecture | user flow | dependency map | state | sequence",
      "title": "<human title>",
      "caption": "<two or three sentences shown directly above the diagram; bold key terms with **asterisks**>",
      "detail":  "<longer paragraph or bulleted list shown in the 'About the <title>' section under the diagram (expanded by default)>",
      "source":  "<mermaid source, with \\n for newlines; default direction LR>",
      "descriptions": {
        "node:<id>": "<what this node is and does, shown on hover, editable in place>",
        "edge:<edgeId>": "<what this arrow carries, shown on hover, editable in place>"
      },
      "notes": "<optional free-form user notes for this diagram; usually empty on first render>"
    }
  ]
}
```

Save to `_project-management/personal/mike/spec-tacle/generated/<spec-slug>-data.json`.

Notes on the shape:

- `summary.what` and `summary.why` are arrays of short bullet strings. Never use paragraph text there — the visualizer renders each element as its own `<li>`.
- `caption` is two or three sentences of italic subtext directly above the diagram. `detail` is a longer paragraph or bulleted list in an "About the <diagram title>" block that starts expanded (the reader can collapse it). Both accept `**bold**` markdown for key terms; `detail` also accepts `- ` / `  - ` nested bullet lists.
- `descriptions` is optional — a map from `node:<id>` / `edge:L-<source>-<target>-<n>` keys to one-sentence descriptions shown on hover, editable on click.
- `notes` is optional and usually empty on first render. It's a per-diagram free-form user notes area (supports `**bold**` and `- ` / `  - ` nested bullets). Users click the "Add notes…" area under each diagram to add general thoughts; those get written back into the spec via a `diagram:<id>:notes` marker section on Update.
- `serverUrl` is normally `null`. The visualizer falls back to `location.origin` when served through `serve.py`, and disables Update/Undo when opened via `file://`. Only set it if the visualizer will be served from a different origin than the one hosting `serve.py`.

**Nested markdown lists** are supported in captions, details, per-node/edge descriptions, and user notes. Use `- ` for a top-level bullet and `  - ` (two-space indent) for a nested sub-bullet, arbitrarily deep. Details in particular read much better as a bulleted list than a paragraph — draft them that way by default.

**Step 6 — render.** Run the render command yourself (do not just print it and ask the user to run it):

```
npx spec-tacle render <path/to/spec-slug-data.json>
```

That writes `<spec-slug>-visualizer.html` next to the data JSON.

**Step 7 — insert marker anchors into the spec.** These let the visualizer's **Update spec** button round-trip user edits back into the spec file. Each pair sits on its own lines; the content between the pair is what the server rewrites on save.

- **Summary bullets:**
  - `<!-- spec-tacle:summary:what -->` … `<!-- /spec-tacle:summary:what -->` around the What bullet list (each bullet a markdown `- ` line).
  - `<!-- spec-tacle:summary:why -->` … `<!-- /spec-tacle:summary:why -->` around the Why bullet list.
- **Per-diagram, in a `## Diagrams` section at the end of the spec, for each diagram id `<id>`:**
  - `<!-- spec-tacle:diagram:<id>:caption -->` … `<!-- /spec-tacle:diagram:<id>:caption -->` around the caption sentence(s).
  - `<!-- spec-tacle:diagram:<id>:detail -->` … `<!-- /spec-tacle:diagram:<id>:detail -->` around the bulleted or paragraph detail.
  - `<!-- spec-tacle:diagram:<id>:notes -->` … `<!-- /spec-tacle:diagram:<id>:notes -->` around the per-diagram user notes area (usually empty on first render — the user fills it in-browser and Update spec writes back here).
  - `<!-- spec-tacle:diagram:<id> -->` … `<!-- /spec-tacle:diagram:<id> -->` around the ```` ```mermaid ```` fenced block itself.

The order within a diagram section is caption, then detail, then notes, then the mermaid block, with a human-readable `### Diagram title` heading above the caption. `example-spec.md` in the spec-tacle project directory is the reference — copy its shape.

**Step 8 — start the round-trip server (it auto-opens the visualizer).** Without the server running the Update spec / Undo buttons in the visualizer disable themselves (the page detects `file://` and won't accept edits), so if you skip this step the user gets a read-only page and thinks the tool is broken.

Run this yourself as a long-running background process:

```
npx spec-tacle serve --root <path/to/spec-dir> --open <relative/path/to/spec-slug-visualizer.html>
```

- Run it in the background (your tool's `run_in_background` option, or `&` in a plain shell). Don't wait for it to exit — it stays up until the user stops it.
- `--open` fires the visualizer in the user's default browser once the server binds. No separate `open` / `xdg-open` / `start` step is needed, and no need to ask the user to click a link.
- If port 8765 is taken the server auto-increments (up to +10). The actual URL is in the server's banner.
- If a spec-tacle server is already running on the same root, reuse it — don't start a second one. Just tell the user where to look.

Tell the user, in one short line, what you opened, the port the server is on, and where their edits will be written. Don't recap the whole workflow.

## Reconcile edits back into the spec

The visualizer's **Export changes** button produces `spec-tacle-edits.json`. When the user hands you that payload (or points at one):

**Step 1 — read the payload and the current spec.** The payload has:

- `specPath` — where the spec lives.
- `summary` — only present if the user edited the What or Why bullets; keyed by the `sectionMap` name (e.g. `summary:what`), each value `{ original: [...], current: [...] }`.
- `diagrams[]` — only diagrams the user actually touched. Each carries `sourceChanged`/`captionChanged`/`detailChanged` flags plus `originalSource`/`currentSource`, `originalCaption`/`currentCaption`, `originalDetail`/`currentDetail`, `nodePositions`, `edgeWaypoints`, and `annotations`.

**Step 2 — categorize each change.**

- **Source-only edits** (added/removed/renamed nodes and edges) — real structural changes the user made in the mermaid textarea. These usually imply the spec is wrong or incomplete.
- **Position-only edits** (nodes dragged, or arrows bent via `edgeWaypoints`, but source unchanged) — layout preference, not spec content. Do not modify the spec for these; only mention them if you're saving a new default data JSON.
- **Caption/detail edits** (`captionChanged`/`detailChanged`) — the user rewrote the picture-caption or the "About the …" section. Treat these like any other prose edit: fold the new wording back into the spec's `diagram:<id>:caption`/`:detail` marker section, running `no-ai-slop` over it first if the user's phrasing is rough.
- **Summary bullet edits** (`summary`) — the user rewrote, added, or removed a What/Why bullet. These read the same as any other content correction — fold them into `summary:what`/`summary:why`.
- **Annotations** — the user attached a note to a node or edge. Each is a candidate to become a spec sentence, a follow-up question, or a decision entry.

**Step 3 — for each structural, caption/detail, or summary edit, propose a spec change and get confirmation.**

- For structural edits, diff the mermaid source (`currentSource` vs `originalSource`). Name each concrete change: "added node `Redis-2`", "removed edge `API → Mail`", "renamed `WS` to `Realtime`".
- For caption/detail/summary edits, the `original`/`current` pair in the payload is the diff — no mermaid parsing needed.
- Locate the section of the spec that describes that piece of the system. Propose the smallest edit — a sentence rewrite, an added bullet, or a note in Open Questions. For caption/detail/summary edits, the marker section itself is the target — write the new text straight into it.
- Present the change list to the user first. Do not silently edit the spec.

**Step 4 — apply the confirmed edits to the spec.** Use Edit tool, one change per section. If the change contradicts a decision in the spec, don't quietly override it — surface the conflict and ask.

**Step 5 — regenerate the data JSON and re-render.** So the visualizer reflects the new source of truth. Preserve node positions and annotations from the payload where they still make sense (same node ids).

## Style and constraints

- **Precision beats coverage.** A visualizer that shows two things clearly beats one that crams in every relationship. If the spec is thin in one area, don't fabricate connections to fill a diagram.
- **Use the spec's language.** If the spec calls it "WebSocket gateway," the diagram says "WebSocket gateway," not "realtime service" or "push server."
- **Ask before inventing structure.** If the spec is ambiguous about direction, ownership, or which component talks to which, list the ambiguities and ask. One question at a time.
- **No performed contrition on reconciliation.** If you got a diagram wrong and the user fixed it, apply the fix, briefly note what changed in the spec, and move on. Don't editorialize.
- **The generated HTML file is disposable.** Regenerate freely. The spec is the source of truth; the visualizer is a reading aid.

## Reference example

`_project-management/personal/mike/spec-tacle/example-spec.md` (the fictional Tasky app) → `generated/tasky-visualizer.html`. Open that HTML file to see the shape a good output takes: four diagrams, dragged nodes, source-editable, exportable.

## Appendix: writing rules for every summary, caption, detail, and description

These rules apply to every piece of prose the skill produces or edits — summary bullets, diagram captions, "About the …" details, per-node/per-edge descriptions. They're a stricter, embedded subset of `no-ai-slop` so the skill stays useful even if that skill isn't loaded. **Clarity above all.** When a rule and a stylistic instinct disagree, keep the sentence that reads clearest to a human on first pass.

### Cut every filler pattern

- **No em-dashes.** Not one. Use periods, colons, parentheses, or commas depending on what the sentence needs. Em-dashes are the model's tell; excise them even when they "feel right."
- **No fluffy short sentences.** A three-word sentence must earn its place with a real fact, decision, or contrast. Cut "That matters." "Enough said." "Here's why." "Simple as that." Each is filler. If you find yourself wanting drama, restructure so the surrounding prose carries the emphasis.
- **No throat-clearing openers.** "Here's the thing," "Let me be clear," "The uncomfortable truth is," "Simply put." Delete and state the point.
- **No fake-insight setups.** "This is the part most people skip," "What most people get wrong," "Here's what nobody tells you." State the claim on its own.
- **No colon reveals.** A noun phrase followed by a colon and a dramatic reveal ("The detail that makes it work: a separate agent grades it.") reads AI. Rewrite as a plain sentence.
- **No importance puffery.** "Stands as a testament," "marks a pivotal moment," "plays a vital role," "underscores its significance." State the fact and let the reader judge whether it matters.
- **No interpretive metadiscourse.** "As you can see," "The key point is," "This distinction matters," "In other words." If the point is clear, delete the aside.
- **No weasel attribution.** "Experts agree," "widely regarded as," "studies show." Name the source or cut the claim.
- **No superficial `-ing` clauses.** "…, highlighting the team's commitment to X." Replace with a concrete consequence: "…, so users can find old drafts without leaving the editor."
- **No fake-strong verbs.** Prefer "is" and "has" when they're clearer. "The app serves as a centralized hub" → "The app tracks sponsors, drafts, and approvals in one place."
- **No dramatic fragmentation.** "X. And Y. And Z." or "That's it. That's the whole thing." Use complete sentences.
- **No summary-recap endings.** "In conclusion," "Ultimately," "Overall." End on the last concrete point.

### Banned words (never use)

`delve, foster, leverage, utilize, facilitate, empower, streamline, robust, cutting-edge, paradigm shift, game changer, tapestry, realm, beacon, multifaceted, meticulous, intricate, paramount, transformative, elevate, embark, supercharge, harness, ever-evolving, seamless, seamlessly`.

Empty adverbs (`just, literally, honestly, simply, actually, truly, fundamentally, importantly, crucially`): cut when they add nothing. Keep only when they carry contrast, uncertainty, or the writer's rhythm.

Empty phrases (`it's worth noting, at the end of the day, when it comes to, at its core, in today's world, in order to, going forward`): cut them and state the point.

### Positive rules

- **Be concrete and specific.** Names, numbers, dates, mechanisms beat abstractions. "The integration improved efficiency" → "The integration cut deploy time from 40 minutes to 4."
- **Active voice.** "The team shipped it Tuesday" beats "the decision emerged."
- **Portability test.** If a sentence could move unchanged to a different product, company, or country, it's filler. Cut it or replace with a fact specific to this subject.
- **Show, don't tell.** Facts and consequences carry the emphasis. Don't tell the reader something is important or surprising; demonstrate it.
- **Keep useful edge.** Preserve blunt language, opinions, and self-aware admissions when they belong. Don't sand every sentence to the same polish.
- **Match the format to the content.** Bullets are for genuinely list-shaped content. Two sentences of prose usually read better than two short bullets.

### Bolding rules

- Bold with `**double asterisks**` around a term that is genuinely load-bearing in that sentence — the noun the reader's eye should hit first. Bold nouns and named things, not verbs or adjectives. "The **WebSocket gateway** holds long-lived connections" is good; "the connections are **long-lived**" is not.
- Don't bold the same term twice in the same paragraph. Once is enough — the reader remembers.
- If a bullet or sentence has no obvious load-bearing noun, don't force one. Bold nothing.
- **Density is different per surface.** Bolding is visual weight; too much and it flattens. Use less in high-density surfaces (bullets), more in low-density ones (single caption).

**Per-surface bolding budget:**

| Surface | Bolding budget |
|---|---|
| Summary bullet lists (What / Why) | 1-2 bolded terms across the entire list. Most bullets have no bolding. |
| Diagram caption (2-3 sentences) | 1-2 bolded terms total. |
| Diagram detail (paragraph or two) | 1-3 bolded terms per paragraph. |
| Per-node/per-edge description (one sentence in a hover tooltip) | Usually zero. Only bold if the sentence names a term the reader must remember. |

When in doubt, remove a bold. The reader gets the emphasis from the surrounding sentence shape, not the typeface.

### Workflow

1. Read the full draft.
2. Cut every filler pattern above without touching the meaning.
3. Bold one or two key terms per sentence where they earn it.
4. Read the draft aloud in your head. If a sentence feels like a filler beat between two real facts, cut it.
5. Check every em-dash and remove or rewrite it.
6. Check every sentence under six words. If it's not carrying a real fact or a real contrast, cut it or fold it into the sentence around it.
