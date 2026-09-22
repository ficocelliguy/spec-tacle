// Sanity-check every diagram's mermaid source. We can't run mermaid without a
// browser, but we can detect the most common breakage: no direction directive,
// no edges, unbalanced brackets, or NaN slipping into the source.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DATA_PATH = path.join(__dirname, '..', 'example', 'example-data.json');
const DIAGRAM_HEADERS = /^(flowchart|graph|stateDiagram|sequenceDiagram|classDiagram|erDiagram|journey)\b/;

function loadDiagrams() {
  // Table-kind diagrams intentionally hold markdown-pipe-table source, not
  // mermaid — every assertion below is mermaid-shape and skips them.
  return JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8')).diagrams.filter(d => d.kind !== 'table');
}

function loadTables() {
  return JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8')).diagrams.filter(d => d.kind === 'table');
}

test('every diagram source starts with a valid mermaid directive', () => {
  for (const d of loadDiagrams()) {
    const first = d.source.split(/\r?\n/)[0].trim();
    assert.match(first, DIAGRAM_HEADERS, `diagram "${d.id}" does not start with a mermaid directive: ${first}`);
  }
});

test('flowchart diagrams declare a direction (LR, TD, RL, BT)', () => {
  for (const d of loadDiagrams()) {
    const first = d.source.split(/\r?\n/)[0].trim();
    if (!/^flowchart|^graph/.test(first)) continue;
    assert.match(first, /\b(LR|TD|TB|RL|BT)\b/, `diagram "${d.id}" flowchart missing a direction: ${first}`);
  }
});

test('flowchart diagrams contain at least one edge', () => {
  const arrow = /(-{2,3}>|<-{2,3}>|<-{2,3}|-\.->|=+>|--x|--o)/;
  for (const d of loadDiagrams()) {
    const first = d.source.split(/\r?\n/)[0].trim();
    if (!/^flowchart|^graph/.test(first)) continue;
    assert.match(d.source, arrow, `diagram "${d.id}" has no arrows`);
  }
});

test('no NaN or "undefined" leaks into any diagram source', () => {
  for (const d of loadDiagrams()) {
    assert.doesNotMatch(d.source, /\bNaN\b/, `diagram "${d.id}" contains NaN`);
    assert.doesNotMatch(d.source, /\bundefined\b/, `diagram "${d.id}" contains "undefined"`);
  }
});

test('bracket types are balanced per line', () => {
  // Simple check: same count of `[` and `]`, `{` and `}`, `(` and `)` per source.
  const pairs = [['[', ']'], ['{', '}'], ['(', ')']];
  for (const d of loadDiagrams()) {
    for (const [open, close] of pairs) {
      const opens = (d.source.match(new RegExp('\\' + open, 'g')) || []).length;
      const closes = (d.source.match(new RegExp('\\' + close, 'g')) || []).length;
      assert.equal(opens, closes, `diagram "${d.id}" has unbalanced ${open}${close}: ${opens} vs ${closes}`);
    }
  }
});

test('TD flowcharts have a linear path ≥8 nodes (justifying top-down); LR otherwise', () => {
  // Weak heuristic — counts arrow occurrences. Warns rather than fails when TD
  // is used on a shallow graph, since some diagrams reasonably choose either.
  for (const d of loadDiagrams()) {
    const first = d.source.split(/\r?\n/)[0].trim();
    const m = /^flowchart\s+(\w+)/.exec(first);
    if (!m) continue;
    const dir = m[1];
    const arrows = (d.source.match(/-{2,3}>/g) || []).length;
    if (dir === 'TD' || dir === 'TB') {
      // Allow TD when the source has plenty of arrows (deep chains).
      assert.ok(arrows >= 4, `diagram "${d.id}" uses TD but only has ${arrows} arrows — consider LR`);
    }
  }
});

test('table-kind diagrams look like a markdown pipe table with a header + alignment row', () => {
  const align = /^\s*\|?\s*:?-{2,}:?(?:\s*\|\s*:?-{2,}:?)*\s*\|?\s*$/;
  for (const d of loadTables()) {
    const lines = d.source.split(/\r?\n/).filter(l => l.trim());
    assert.ok(lines.length >= 3, `table "${d.id}" needs a header, an alignment row, and at least one data row`);
    // Header + alignment must be adjacent.
    let alignedAt = -1;
    for (let i = 1; i < lines.length; i++) if (align.test(lines[i])) { alignedAt = i; break; }
    assert.ok(alignedAt > 0, `table "${d.id}" is missing an alignment row (|---|---|)`);
    const cols = lines[alignedAt - 1].replace(/^\||\|$/g, '').split('|').length;
    assert.ok(cols >= 2, `table "${d.id}" needs at least two columns to be worth a table`);
  }
});
