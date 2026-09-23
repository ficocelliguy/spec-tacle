// Unit tests for the round-trip logic in serve.js. Exercises the pure functions
// (replaceBetweenMarkers, applyUpdates) plus a live localhost HTTP round-trip.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const {
  applyUpdates, replaceBetweenMarkers, start, makeServer,
  readConsistencyQueue, CONSISTENCY_QUEUE_FILENAME, extractMarkerContent,
} = require(path.join(__dirname, '..', 'lib', 'serve.js'));

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

test('applyUpdates prepends an agent-readable Nodes/Edges inventory for flowchart kinds', () => {
  const src = '<!-- spec-tacle:diagram:arch -->\n```mermaid\nold\n```\n<!-- /spec-tacle:diagram:arch -->';
  const mermaid = 'flowchart LR\n  API["API server"]\n  DB[(Postgres)]\n  API -->|"read/write"| DB';
  const { text } = applyUpdates(src, {
    sections: {},
    diagrams: {
      arch: {
        source: mermaid,
        kind: 'architecture',
        descriptions: { 'node:DB': 'Primary store.' },
      }
    }
  });
  assert.match(text, /\*\*Nodes\*\*/);
  assert.match(text, /- `API`: API server\./);
  assert.match(text, /- `DB`: Postgres — Primary store\./);
  assert.match(text, /\*\*Edges\*\*/);
  assert.match(text, /- `API` → `DB`: "read\/write"\./);
  // Inventory must come before the mermaid fence.
  const nodesIdx = text.indexOf('**Nodes**');
  const fenceIdx = text.indexOf('```mermaid');
  assert.ok(nodesIdx !== -1 && fenceIdx !== -1 && nodesIdx < fenceIdx, 'inventory should precede fence');
});

test('applyUpdates emits States + Transitions inventory for state diagrams', () => {
  const src = '<!-- spec-tacle:diagram:lifecycle -->\nold\n<!-- /spec-tacle:diagram:lifecycle -->';
  const mermaid = 'stateDiagram-v2\n  [*] --> Idle\n  Idle --> Running: start\n  Running --> Idle: complete';
  const { text } = applyUpdates(src, {
    sections: {},
    diagrams: { lifecycle: { source: mermaid, kind: 'state' } }
  });
  assert.match(text, /\*\*States\*\*/);
  assert.match(text, /- `Idle`/);
  assert.match(text, /\*\*Transitions\*\*/);
  assert.match(text, /- `Idle` → `Running`: start\./);
});

test('applyUpdates emits no inventory for pie / xychart kinds', () => {
  const src = '<!-- spec-tacle:diagram:mix -->\nold\n<!-- /spec-tacle:diagram:mix -->';
  const mermaid = 'pie showData\n  title Mix\n  "A" : 60\n  "B" : 40';
  const { text } = applyUpdates(src, {
    sections: {},
    diagrams: { mix: { source: mermaid, kind: 'data summary' } }
  });
  assert.doesNotMatch(text, /\*\*Nodes\*\*/);
  assert.doesNotMatch(text, /\*\*Edges\*\*/);
  assert.match(text, /```mermaid\npie showData/);
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

test('extractMarkerContent returns the raw text between a spec-tacle marker pair', () => {
  const src =
    '# Spec\n<!-- spec-tacle:summary:what -->\n- one\n- two\n<!-- /spec-tacle:summary:what -->\n\n' +
    '<!-- spec-tacle:diagram:arch -->\nBODY\n<!-- /spec-tacle:diagram:arch -->';
  assert.equal(extractMarkerContent(src, 'summary:what'), '- one\n- two');
  assert.equal(extractMarkerContent(src, 'diagram:arch'), 'BODY');
  assert.equal(extractMarkerContent(src, 'missing'), '');
});

test('HTTP round-trip: /update-spec enqueues a consistency-pass entry and /consistency-apply clears it', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-tacle-consistency-test-'));
  const specFile = path.join(tmp, 'spec.md');
  fs.writeFileSync(
    specFile,
    '# Spec\n\n' +
    '<!-- spec-tacle:summary:what -->\n- one\n- two\n<!-- /spec-tacle:summary:what -->\n\n' +
    '<!-- spec-tacle:diagram:arch -->\n```mermaid\nflowchart LR\n  A --> B\n```\n<!-- /spec-tacle:diagram:arch -->\n'
  );
  const port = 19000 + Math.floor(Math.random() * 1000);
  const server = start({ root: tmp, port });
  try {
    await new Promise((res) => setTimeout(res, 60));
    const userUpdate = await httpPost(port, '/update-spec', JSON.stringify({
      specPath: 'spec.md',
      sections: { 'summary:what': '- one\n- three' },
      diagrams: {}
    }));
    assert.equal(userUpdate.status, 200);
    assert.equal(userUpdate.json.ok, true);
    assert.equal(userUpdate.json.changed, true);
    assert.ok(userUpdate.json.consistencyPending, 'server returns the pending entry id');

    const queuePath = path.join(tmp, CONSISTENCY_QUEUE_FILENAME);
    assert.ok(fs.existsSync(queuePath), 'queue file was written');
    const q = readConsistencyQueue(tmp);
    assert.equal(q.entries.length, 1);
    const entry = q.entries[0];
    assert.equal(entry.specPath, 'spec.md');
    assert.equal(entry.origin, 'user');
    assert.equal(entry.sections.length, 1);
    assert.equal(entry.sections[0].name, 'summary:what');
    assert.match(entry.sections[0].before, /- one\n- two/);
    assert.match(entry.sections[0].after, /- one\n- three/);

    // GET /consistency-pending mirrors what readConsistencyQueue sees.
    const pendingList = await httpGet(port, `/consistency-pending?specPath=${encodeURIComponent('spec.md')}`);
    assert.equal(pendingList.status, 200);
    assert.equal(pendingList.json.entries.length, 1);
    assert.equal(pendingList.json.entries[0].id, entry.id);

    // Consistency-apply lands a follow-up edit + clears the queue entry.
    const applyResp = await httpPost(port, '/consistency-apply', JSON.stringify({
      specPath: 'spec.md',
      entryId: entry.id,
      sections: { 'diagram:arch:caption': 'Auto-updated caption reflecting the summary change.' },
      diagrams: {}
    }));
    assert.equal(applyResp.status, 200);
    assert.equal(applyResp.json.ok, true);
    assert.equal(applyResp.json.changed, true);
    assert.equal(applyResp.json.cleared, true);

    // Queue is empty after apply.
    const qAfter = readConsistencyQueue(tmp);
    assert.equal(qAfter.entries.length, 0);

    // Spec now contains the auto-applied caption.
    const finalText = fs.readFileSync(specFile, 'utf-8');
    assert.match(finalText, /Auto-updated caption reflecting the summary change\./);
    // Two backups exist (one per write).
    const backups = fs.readdirSync(path.join(tmp, 'backups'));
    assert.equal(backups.length, 2);
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('HTTP: /consistency-dismiss clears a queue entry without touching the spec', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-tacle-dismiss-test-'));
  const specFile = path.join(tmp, 'spec.md');
  fs.writeFileSync(specFile,
    '<!-- spec-tacle:summary:what -->\n- one\n<!-- /spec-tacle:summary:what -->\n');
  const port = 20000 + Math.floor(Math.random() * 1000);
  const server = start({ root: tmp, port });
  try {
    await new Promise((res) => setTimeout(res, 60));
    const userUpdate = await httpPost(port, '/update-spec', JSON.stringify({
      specPath: 'spec.md',
      sections: { 'summary:what': '- two' },
      diagrams: {}
    }));
    const entryId = userUpdate.json.consistencyPending;
    assert.ok(entryId);
    const dismissed = await httpPost(port, '/consistency-dismiss', JSON.stringify({
      specPath: 'spec.md', entryId,
    }));
    assert.equal(dismissed.status, 200);
    assert.equal(dismissed.json.cleared, true);
    assert.equal(readConsistencyQueue(tmp).entries.length, 0);
    // Spec content is what /update-spec wrote — dismiss doesn't touch it.
    assert.match(fs.readFileSync(specFile, 'utf-8'), /- two/);
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
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
    req.end();
  });
}

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
