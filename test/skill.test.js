// SKILL.md sanity — checks it documents every marker anchor the server writes
// to, every data-JSON field the visualizer reads, and the writing rules we
// promise to enforce.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SKILL_PATH = path.join(__dirname, '..', 'skill', 'SKILL.md');
const skill = fs.readFileSync(SKILL_PATH, 'utf-8');

test('SKILL.md documents every marker anchor pair the server round-trips', () => {
  const required = [
    'spec-tacle:summary:what',
    'spec-tacle:summary:why',
    'spec-tacle:diagram:<id>:caption',
    'spec-tacle:diagram:<id>:detail',
    'spec-tacle:diagram:<id>:notes',
    'spec-tacle:diagram:<id>',
  ];
  for (const m of required) {
    assert.match(skill, new RegExp(m.replace(/[<>\/]/g, s => '\\' + s)),
      `SKILL.md missing marker documentation for "${m}"`);
  }
});

test('SKILL.md describes every top-level data JSON field', () => {
  const fields = ['title', 'specPath', 'summary', 'diagrams', 'sectionMap', 'serverUrl'];
  for (const f of fields) {
    assert.match(skill, new RegExp(`"${f}"|\\b${f}\\b`),
      `SKILL.md missing field "${f}"`);
  }
});

test('SKILL.md describes every per-diagram field', () => {
  const fields = ['id', 'kind', 'title', 'caption', 'detail', 'source', 'descriptions', 'notes'];
  for (const f of fields) {
    assert.match(skill, new RegExp(`"${f}"|\\b${f}\\b`),
      `SKILL.md missing diagram field "${f}"`);
  }
});

test('SKILL.md carries the strict writing rules (em-dash ban, banned words, bolding budget)', () => {
  assert.match(skill, /em[- ]?dash/i, 'em-dash rule missing');
  assert.match(skill, /banned/i, 'banned words section missing');
  assert.match(skill, /bolding/i, 'bolding rules missing');
  // At least one of the concrete banned words should appear in the list
  assert.match(skill, /\b(leverage|delve|utilize|robust|meticulous)\b/i,
    'banned-word examples missing');
});

test('SKILL.md describes hover-tooltip + click-to-edit for descriptions', () => {
  assert.match(skill, /hover/i, 'hover behavior missing');
  assert.match(skill, /tooltip|Click to edit|click.*edit/i, 'edit-on-click behavior missing');
});

test('SKILL.md describes nested bullet support', () => {
  assert.match(skill, /nested|indent|sub-?bullet/i, 'nested bullets not documented');
});

test('SKILL.md explains the LR default and TD threshold rule', () => {
  assert.match(skill, /LR/, 'LR mention missing');
  assert.match(skill, /TD/, 'TD mention missing');
  assert.match(skill, /\b8\b|\beight\b/, '8-node threshold missing');
});
