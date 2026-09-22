// Static-analysis checks on the template's inline JS. Catches classes of bugs
// that only manifest at runtime (e.g. stray backticks inside a template literal
// that JavaScript reads as string subtraction and renders as "NaN").
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TEMPLATE = fs.readFileSync(
  path.join(__dirname, '..', 'lib', 'template.html'),
  'utf-8'
);

test('no bare backticks appear inside title attributes within template literals', () => {
  // Any `title="…`  `…"` sequence inside a JS template literal is a lurking bug:
  // the inner backtick closes the template literal, and the surrounding pieces
  // get reduced by `-` to NaN at runtime. Ban the pattern outright.
  const re = /title="[^"`]*`/g;
  const matches = [];
  let m;
  while ((m = re.exec(TEMPLATE)) !== null) {
    // Show the offending snippet with a bit of surrounding context
    const start = Math.max(0, m.index - 20);
    matches.push(TEMPLATE.slice(start, m.index + 40));
  }
  assert.equal(matches.length, 0,
    `Found ${matches.length} title="…\`…" occurrences. Backticks inside title text will break the surrounding template literal:\n  ${matches.join('\n  ')}`);
});

test('template extracts render + serve + skill scripts from the same file', () => {
  // The template should contain the specdata placeholder and expected root elements.
  assert.match(TEMPLATE, /__SPEC_DATA__/, 'placeholder missing');
  assert.match(TEMPLATE, /id="specdata"/, 'specdata script tag missing');
  assert.match(TEMPLATE, /id="btn-update-spec"/, 'Update button id missing');
  assert.match(TEMPLATE, /id="btn-undo-spec"/, 'Undo button id missing');
});

test('renderAnnotations null-checks its container before writing innerHTML', () => {
  // The annotations UI was replaced by the free-form notes area. The old
  // renderAnnotations() must guard against querySelector returning null,
  // otherwise mermaid.render's post-processing throws "Cannot set properties
  // of null" and every diagram shows a bogus "Mermaid parse error".
  const fn = /function renderAnnotations\(idx\)\s*{([\s\S]*?)\n  }/.exec(TEMPLATE);
  assert.ok(fn, 'renderAnnotations function not found');
  assert.match(fn[1], /if\s*\(!container\)\s*return/,
    'renderAnnotations must early-return when container is null');
});

test('dirty check uses deepEqual + node-offset filter (not raw JSON.stringify + key count)', () => {
  // Object key order or zero-value offsets used to leak into the dirty check
  // and leave the "edited" indicator on after Ctrl+Z restored the state.
  // The fixed check uses a deepEqual helper and a hasNodeOffsets predicate.
  assert.match(TEMPLATE, /function\s+deepEqual\s*\(/, 'deepEqual helper missing');
  assert.match(TEMPLATE, /function\s+hasNodeOffsets\s*\(/, 'hasNodeOffsets helper missing');
  assert.match(TEMPLATE, /function\s+isDiagramDirty\s*\(/, 'isDiagramDirty predicate missing');
  // The dirty predicate should NOT use JSON.stringify on descriptions/positions
  // (order- and zero-sensitive; caused stale "edited" after undo).
  const isDirtyFn = /function\s+isDiagramDirty\s*\(d\)\s*{([\s\S]*?)\n  }/.exec(TEMPLATE);
  assert.ok(isDirtyFn, 'isDiagramDirty function body not found');
  assert.doesNotMatch(isDirtyFn[1], /JSON\.stringify/,
    'isDiagramDirty must not use JSON.stringify — use deepEqual instead');
  assert.doesNotMatch(isDirtyFn[1], /Object\.keys\(d\.nodePositions\)\.length/,
    'isDiagramDirty must use hasNodeOffsets, not a raw key count');
});

test('the template has no unmatched backtick count in inline scripts', () => {
  // Weak but useful sanity: extract every <script>…</script> body and count
  // top-level backticks (ignoring simple escapes). An odd count anywhere often
  // means a template literal was accidentally left open or closed early.
  const scriptRe = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g;
  let match;
  const oddScripts = [];
  while ((match = scriptRe.exec(TEMPLATE)) !== null) {
    const body = match[1];
    // Strip escaped backticks so they don't affect the count
    const stripped = body.replace(/\\`/g, '');
    const count = (stripped.match(/`/g) || []).length;
    if (count % 2 !== 0) {
      oddScripts.push(`script at offset ${match.index} has ${count} backticks`);
    }
  }
  assert.deepEqual(oddScripts, [],
    'Inline script(s) have an odd backtick count — likely an unclosed template literal:\n  ' + oddScripts.join('\n  '));
});
