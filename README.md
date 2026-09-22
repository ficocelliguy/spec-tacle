
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/ficocelliguy/spec-tacle/refs/heads/master/assets/spec-tacle-logo-dark.png">
  <img src="https://raw.githubusercontent.com/ficocelliguy/spec-tacle/refs/heads/master/assets/spec-tacle-logo-light.png" alt="spec-tacle logo" width="500px">
</picture>

spec-tacle turns any technical document into a page that is actually readable and understandable - and visually editable. The page is laid out for reading, and every part of it can be updated in-place. Hit **Update spec** and the changes are reflected in the spec file.

## See it live

**[ficocelliguy.github.io/spec-tacle](https://ficocelliguy.github.io/spec-tacle/)** — a static example visualizing a spec for "Snip" (a URL-shortener) . Everything is editable in the browser so you can feel the shape of the tool: drag nodes, bend arrows, rewrite captions. Note there is no backend on that demo for undo or saving — that's what `npx spec-tacle_skill demo` (below) adds.


## Get the skill

```sh
npx spec-tacle_skill install
```

That writes `SKILL.md` to `~/.claude/skills/spec-tacle_skill/`. For Codex or any other editor with named skills, pass `--dir <path>` to point at whichever directory it reads skills from.

Then in a session:

> spec-tacle this: docs/product-brief.md

Invoke it alone ("spec-tacle this") and it'll ask what to include. Point it at a markdown file, a stack of files, a transcript, one or more images of a whiteboard, or a mix — it merges them into one spec first, then produces the visualizer.

Edit anything you want in the browser, hit Update spec. Your spec file now reflects your edits.

## Full local demo

```sh
npx spec-tacle_skill demo
```

That stages the bundled Tasky example (a fictional shared to-do app spec) in a temp directory, renders it, and starts a local server. Open the URL it prints. Drag nodes around, rewrite a caption, add a note under a diagram, watch the source file change.


## Round-trip, in one paragraph

Every editable region in the visualizer is mapped to an HTML-comment marker anchor added to the spec (`<!-- spec-tacle:summary:what -->`, `<!-- spec-tacle:diagram:architecture:caption -->`, and so on). The Update button POSTs your edits to the local server, which writes a timestamped backup of the spec into a `backups/` folder next to it and rewrites only the content between the markers. Anything outside the markers is left alone. Undo restores the most recent backup and pops it off the stack. Your spec stays yours; the visualizer just gives you a nice surface to edit it.

## Writing quality

The skill embeds a strict subset of the [no-ai-slop](https://github.com/petergyang/no-ai-slop) rules so the drafted prose reads like a human wrote it. No em-dashes. No fluffy short sentences. Concrete over abstract; every claim carries its own weight or gets cut.

## Development

```sh
git clone https://github.com/ficocelliguy/spec-tacle
cd spec-tacle
npm test
node bin/spec-tacle.js demo
```

Node 18+. Tests use `node:test`.

## License

MIT
