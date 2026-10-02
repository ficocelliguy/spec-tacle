
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/ficocelliguy/spec-tacle/refs/heads/master/assets/spec-tacle-logo-dark.png">
  <img src="https://raw.githubusercontent.com/ficocelliguy/spec-tacle/refs/heads/master/assets/spec-tacle-logo-light.png" alt="spec-tacle logo" width="500px">
</picture>

spec-tacle turns dense technical docs into a page you can take in at a glance: a skimmable summary, architecture and flow diagrams, and charts of the data. The visualization is also an editor! Drag a node, redraw an arrow, or rewrite a caption, then hit **Update spec**, and your changes are written back into the spec file.

## See it live

**[ficocelliguy.github.io/spec-tacle](https://ficocelliguy.github.io/spec-tacle/)** — a static example visualizing a spec for "Snip" (a URL-shortener) . Everything is editable in the browser so you can feel the shape of the tool: drag nodes, bend arrows, rewrite captions. That page has no backend, so Update spec, Undo, and the agent's follow-up edits don't run there. To see those, run the [local demo](#full-local-demo).


## Get the skill

```sh
npx spec-tacle_skill install
```

That writes `SKILL.md` to `~/.claude/skills/spec-tacle/` for Claude Code. If Codex, Gemini CLI, Copilot CLI, or Windsurf is installed, it also writes a copy to `~/.agents/skills/spec-tacle/`, the shared skills folder those agents read. Cursor, OpenCode, and Amp already pick up the `~/.claude` copy. For any other agent, pass `--dir <path>` to point at whichever directory it reads skills from.

`install` also pre-approves the spec-tacle CLI for each agent it finds, so future sessions can run it without an approval prompt. Nothing broader than that is granted at the user level:

| Agent | File | What it allows |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | `Skill(spec-tacle)`, `Bash(npx spec-tacle_skill:*)`, `Bash(npx spec-tacle:*)` |
| Codex | `~/.codex/rules/spec-tacle.rules` | `npx spec-tacle_skill` / `npx spec-tacle` |
| Gemini CLI | `~/.gemini/settings.json` (`tools.allowed`) | `run_shell_command(npx spec-tacle_skill)` / `(npx spec-tacle)` |
| Cursor CLI | `~/.cursor/cli-config.json` | `Shell(npx:spec-tacle*)` |
| OpenCode | `~/.config/opencode/opencode.json` | bash `npx spec-tacle*` |

JSON configs are merged, not replaced, and a file that won't parse (such as JSONC with comments) is left alone. Read and edit permissions are scoped tighter: the first `serve --auto-agent` in a project writes `.claude/settings.local.json`, plus `.codex/rules/spec-tacle.rules`, `.gemini/settings.json`, `.cursor/cli.json`, or `opencode.json` for whichever of those agents you have installed. Existing project files are never overwritten. Copilot CLI, Windsurf, and Amp don't have a documented permissions file yet, so they'll still ask before running the CLI. Pass `--skip-user-perms` to install SKILL.md only.

Then in a session:

> spec-tacle docs/product-brief.md

Invoke it alone ("spec-tacle") and it'll ask what to include. Point it at a markdown file, a stack of files, a transcript, one or more images of a whiteboard, or a mix — it merges them into one spec first, then produces the visualizer.

Edit anything you want in the browser, hit Update spec. Your spec file now reflects your edits.

## Full local demo

```sh
npx spec-tacle_skill install   # once: installs the skill and CLI pre-approvals
npx spec-tacle_skill demo
```

`demo` copies the bundled Tasky example (a fictional shared to-do app spec, its data JSON, and its visualizer) into a new `./spec-tacle-demo` folder, numbered if that name is taken. It then starts the round-trip server with `--auto-agent` and opens the visualizer in your browser.

Update spec does two things. The server writes your edit into the spec between its markers, then queues a consistency pass: an agent reads what you changed, checks it against the whole spec (the original sections as well as the summary and diagrams), and rewrites whatever now disagrees with it. `--auto-agent` runs that second half. For every Update spec it spawns a headless agent (`claude -p` or `codex exec`), and the visualizer banner shows the agent's progress live.

Drag a node, rewrite a caption, or add a note, then hit Update spec. Your edit lands in `spec-tacle-demo/example-spec.md` right away. The banner then tracks the agent's commands and edits as it works (a pass usually takes one to two minutes), and the sections it rewrote get a blue highlight in the spec drawer. Click **Show changes** in the drawer to mark every change spec-tacle has made since its first Update spec, with removed lines struck through where they used to be. Each agent's full output is logged to `spec-tacle-demo/.spec-tacle-agent-logs/<entryId>.log`. Stop the server with Ctrl-C; the folder stays, so you can keep editing the spec, commit it, or delete it.

### Choosing the agent

The server picks the agent it was started from (running `demo` from inside Codex uses Codex), then whichever of `claude` or `codex` is on your `PATH`, Claude first. To choose, pass `--agent claude` or `--agent codex` to `demo` or `serve`, or set `SPEC_TACLE_AGENT`. `SPEC_TACLE_AGENT_BIN` points at a binary that isn't on `PATH`, and `SPEC_TACLE_AGENT_MODEL` overrides the model (Claude defaults to Haiku; Codex uses its own default).

- **Claude Code** runs as `claude -p … --output-format stream-json`. The first run writes `.claude/settings.local.json` into the folder, so the agent can read and edit the spec without stopping on a permission prompt.
- **Codex** runs as `codex exec --json --sandbox workspace-write` with network access on. The sandbox limits the agent's writes to the demo folder, and network access lets it reach the model API and the local server.
- **Any other agent CLI** works through `serve --on-consistency-pending`. `{prompt}` expands to the full consistency-pass prompt, already shell-quoted:

  ```sh
  npx spec-tacle_skill serve --open example-visualizer.html \
    --on-consistency-pending 'gemini -p {prompt} --yolo'
  ```

  A custom command gets no live progress in the banner, because the server can't parse its output. The banner flips to done when the agent posts its edits.

If no agent CLI is found, `demo` still runs and Update spec still writes your edits, but the consistency pass waits in the queue. To run it, open an agent session in the demo folder after an Update spec and invoke the skill:

| Agent | Say |
|---|---|
| Claude Code | `/spec-tacle run the pending spec-tacle consistency pass` |
| Codex | `$spec-tacle run the pending spec-tacle consistency pass` |
| Anything else | "Use the spec-tacle skill to run the pending spec-tacle consistency pass." |

The agent finds queued entries with `npx spec-tacle_skill consistency-check` and posts its edits back through the running server, so the banner clears and the changed cards reload. If your agent can't see the skill, run `npx spec-tacle_skill install`, or tell it to read the output of `npx spec-tacle_skill skill`.

Start the server from a plain terminal rather than from inside an agent's sandboxed shell. A sandboxed parent (Claude Code's Seatbelt sandbox, or Codex with network disabled) passes its restrictions to the agent it spawns, which then can't reach the model API; the log shows `ENOTFOUND`.

To watch the skill build a visualizer from scratch rather than use the bundled one, run `claude "spec-tacle example-spec.md"` (or the equivalent in your agent) in a folder with a copy of the spec.


## Round-trip, in one paragraph

Every editable region in the visualizer is mapped to an HTML-comment marker anchor added to the spec (`<!-- spec-tacle:summary:what -->`, `<!-- spec-tacle:diagram:architecture:caption -->`, and so on). The Update button POSTs your edits to the local server, which writes a timestamped backup of the spec into a `backups/` folder next to it and rewrites only the content between the markers. Anything outside the markers is left alone. Undo restores the most recent backup and pops it off the stack. Your spec stays yours; the visualizer just gives you a nice surface to edit it.

## Writing quality

The skill embeds a strict subset of the [no-ai-slop](https://github.com/petergyang/no-ai-slop) rules so the drafted prose reads like a human wrote it. No em-dashes. No fluffy short sentences. Concrete over abstract; every claim carries its own weight or gets cut.

## Development

```sh
git clone https://github.com/ficocelliguy/spec-tacle
cd spec-tacle
npm test
node bin/spec-tacle.js demo    # needs `claude` or `codex` on PATH for the consistency pass
```

Node 18+. Tests use `node:test`.

## License

MIT
