// Unit tests for the round-trip logic in serve.js. Exercises the pure functions
// (replaceBetweenMarkers, applyUpdates) plus a live localhost HTTP round-trip.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { applyUpdates, replaceBetweenMarkers, start, makeServer } =
  require(path.join(__dirname, '..', 'lib', 'serve.js'));

test('replaceBetweenMarkers rewrites content between spec-tacle markers', () => {
  const src = 'prefix\n<!-- spec-tacle:foo -->\nold body\n<!-- /spec-tacle:foo -->\nsuffix';
  const { text, created } = replaceBetweenMarkers(src, 'foo', 'new body');
  assert.equal(created, false);
  assert.match(text, /prefix/);
  assert.match(text, /suffix/);
  assert.match(text, /new body/);
  assert.doesNotMatch(text, /old body/);
});

test('replaceBetweenMarkers appends a new section when the marker is missing and flags it as created', () => {
  const src = 'only prefix';
  const { text, created } = replaceBetweenMarkers(src, 'new', 'first save');
  assert.equal(created, true);
  assert.match(text, /<!-- spec-tacle:new -->\nfirst save\n<!-- \/spec-tacle:new -->/);
});

test('applyUpdates rewrites sections and diagram mermaid blocks', () => {
  const src =
    '<!-- spec-tacle:summary:what -->\nold what\n<!-- /spec-tacle:summary:what -->\n\n' +
    '<!-- spec-tacle:diagram:arch -->\n```mermaid\nold mermaid\n```\n<!-- /spec-tacle:diagram:arch -->';
  const { text, created } = applyUpdates(src, {
    sections: { 'summary:what': '- new what bullet' },
    diagrams: { 'arch': 'flowchart LR\n  A --> B' }
  });
  assert.deepEqual(created, []);
  assert.match(text, /- new what bullet/);
  assert.match(text, /flowchart LR\n {2}A --> B/);
  assert.doesNotMatch(text, /old what/);
  assert.doesNotMatch(text, /old mermaid/);
});

test('applyUpdates writes table-kind diagrams as raw markdown (no mermaid fence)', () => {
  const src =
    '<!-- spec-tacle:diagram:roles -->\n' +
    '| Old | Header |\n|---|---|\n| a | b |\n' +
    '<!-- /spec-tacle:diagram:roles -->';
  const newTable = '| Capability | Member | Guest |\n|---|---|---|\n| Read list | y | y |\n| Invite    | y | n |';
  const { text, created } = applyUpdates(src, {
    sections: {},
    diagrams: { 'roles': { source: newTable, kind: 'table' } }
  });
  assert.deepEqual(created, []);
  assert.match(text, /Capability \| Member \| Guest/);
  assert.doesNotMatch(text, /```mermaid/);
  assert.doesNotMatch(text, /Old \| Header/);
});

test('applyUpdates keeps the mermaid fence for non-table kinds passed in object form', () => {
  const src = '<!-- spec-tacle:diagram:arch -->\n```mermaid\nold\n```\n<!-- /spec-tacle:diagram:arch -->';
  const { text } = applyUpdates(src, {
    sections: {},
    diagrams: { 'arch': { source: 'flowchart LR\n  A --> B', kind: 'architecture' } }
  });
  assert.match(text, /```mermaid\nflowchart LR\n {2}A --> B\n```/);
});

test('applyUpdates reports every missing marker as created', () => {
  const src = '# Spec\n\nno markers here';
  const { text, created } = applyUpdates(src, {
    sections: { 'summary:what': '- bullet', 'diagram:arch:caption': 'cap' },
    diagrams: { 'arch': 'flowchart LR\n  A --> B' }
  });
  assert.deepEqual(created.sort(), ['diagram:arch', 'diagram:arch:caption', 'summary:what'].sort());
  assert.match(text, /- bullet/);
  assert.match(text, /flowchart LR\n {2}A --> B/);
});

test('HTTP round-trip: POST /update-spec writes a backup and rewrites the spec', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-tacle-serve-test-'));
  const specFile = path.join(tmp, 'test-spec.md');
  fs.writeFileSync(specFile,
    '# Test\n\n<!-- spec-tacle:summary:what -->\noriginal\n<!-- /spec-tacle:summary:what -->\n');
  const port = 18000 + Math.floor(Math.random() * 1000);
  const server = start({ root: tmp, port });
  try {
    await new Promise((res) => setTimeout(res, 60)); // let server bind
    const body = JSON.stringify({
      specPath: 'test-spec.md',
      sections: { 'summary:what': '- updated bullet' }
    });
    const resp = await httpPost(port, '/update-spec', body);
    assert.equal(resp.status, 200);
    assert.equal(resp.json.ok, true);
    assert.equal(resp.json.changed, true);
    // Spec was rewritten
    const rewritten = fs.readFileSync(specFile, 'utf-8');
    assert.match(rewritten, /- updated bullet/);
    assert.doesNotMatch(rewritten, /^original$/m);
    // Backup exists
    const backupDir = path.join(tmp, 'backups');
    const backups = fs.readdirSync(backupDir);
    assert.equal(backups.length, 1);
    const backupContent = fs.readFileSync(path.join(backupDir, backups[0]), 'utf-8');
    assert.match(backupContent, /original/);
    // Undo restores and removes the backup
    const undoResp = await httpPost(port, '/undo', JSON.stringify({ specPath: 'test-spec.md' }));
    assert.equal(undoResp.status, 200);
    assert.equal(undoResp.json.ok, true);
    const restored = fs.readFileSync(specFile, 'utf-8');
    assert.match(restored, /original/);
    assert.equal(fs.readdirSync(backupDir).length, 0);
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function httpPost(port, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
