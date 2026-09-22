// Schema and content sanity for example-data.json — catches most drift between
// the skill's expected output shape and what the visualizer actually consumes.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DATA_PATH = path.join(__dirname, '..', 'example', 'example-data.json');

test('example data JSON parses', () => {
  const raw = fs.readFileSync(DATA_PATH, 'utf-8');
  const data = JSON.parse(raw);
  assert.ok(data, 'expected an object');
});

test('example data JSON has required top-level fields', () => {
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  for (const key of ['title', 'specPath', 'summary', 'diagrams']) {
    assert.ok(key in data, `missing top-level "${key}"`);
  }
  assert.equal(typeof data.title, 'string');
  assert.notEqual(data.title.trim(), '');
});

test('summary has what/why as non-empty string arrays of short bullets', () => {
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  for (const key of ['what', 'why']) {
    const arr = data.summary[key];
    assert.ok(Array.isArray(arr), `summary.${key} must be an array`);
    assert.ok(arr.length > 0, `summary.${key} must have at least one bullet`);
    for (const bullet of arr) {
      assert.equal(typeof bullet, 'string', `summary.${key} bullet must be a string`);
      const firstLine = bullet.split(/\r?\n/)[0].trim();
      assert.notEqual(firstLine, '', `summary.${key} bullet must not be empty on first line`);
      assert.ok(firstLine.length <= 200, `summary.${key} bullet first line unusually long (>200 chars): ${firstLine}`);
    }
  }
});

test('every diagram has id/kind/title/caption/source, all as non-empty strings', () => {
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  assert.ok(Array.isArray(data.diagrams) && data.diagrams.length > 0, 'diagrams must be a non-empty array');
  const seenIds = new Set();
  for (const d of data.diagrams) {
    for (const key of ['id', 'kind', 'title', 'caption', 'source']) {
      assert.equal(typeof d[key], 'string', `diagram missing "${key}"`);
      assert.notEqual(d[key].trim(), '', `diagram "${key}" empty`);
    }
    assert.ok(!seenIds.has(d.id), `duplicate diagram id: ${d.id}`);
    seenIds.add(d.id);
    // detail is optional (may be empty) but should be a string if present
    if ('detail' in d) assert.equal(typeof d.detail, 'string');
    if ('descriptions' in d) assert.equal(typeof d.descriptions, 'object');
    if ('notes' in d) assert.equal(typeof d.notes, 'string');
  }
});

test('bold markers are balanced (** ... **) across all prose fields', () => {
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  const strings = [];
  for (const b of data.summary.what) strings.push(b);
  for (const b of data.summary.why) strings.push(b);
  for (const d of data.diagrams) {
    strings.push(d.caption || '');
    strings.push(d.detail || '');
    strings.push(d.notes || '');
    if (d.descriptions) for (const v of Object.values(d.descriptions)) strings.push(v);
  }
  for (const s of strings) {
    const count = (s.match(/\*\*/g) || []).length;
    assert.equal(count % 2, 0, `unbalanced "**" markers in: ${s.slice(0, 80)}…`);
  }
});
