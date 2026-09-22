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
  const out = replaceBetweenMarkers(src, 'foo', 'new body');
  assert.match(out, /prefix/);
  assert.match(out, /suffix/);
  assert.match(out, /new body/);
  assert.doesNotMatch(out, /old body/);
});

test('replaceBetweenMarkers appends a new section when the marker is missing', () => {
  const src = 'only prefix';
  const out = replaceBetweenMarkers(src, 'new', 'first save');
  assert.match(out, /<!-- spec-tacle:new -->\nfirst save\n<!-- \/spec-tacle:new -->/);
});

test('applyUpdates rewrites sections and diagram mermaid blocks', () => {
  const src =
    '<!-- spec-tacle:summary:what -->\nold what\n<!-- /spec-tacle:summary:what -->\n\n' +
    '<!-- spec-tacle:diagram:arch -->\n```mermaid\nold mermaid\n```\n<!-- /spec-tacle:diagram:arch -->';
  const out = applyUpdates(src, {
    sections: { 'summary:what': '- new what bullet' },
    diagrams: { 'arch': 'flowchart LR\n  A --> B' }
  });
  assert.match(out, /- new what bullet/);
  assert.match(out, /flowchart LR\n {2}A --> B/);
  assert.doesNotMatch(out, /old what/);
  assert.doesNotMatch(out, /old mermaid/);
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
