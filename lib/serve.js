// spec-tacle round-trip server.
//
// Serves static files under --root and accepts two POST endpoints:
//   POST /update-spec { specPath, sections, diagrams }
//   POST /undo        { specPath }
// Plus read-only GET endpoints the drawer uses:
//   GET  /spec-source?specPath=…              raw current spec text
//   GET  /spec-history?specPath=…&limit=N     recent backups + unified diffs
//
// Sections are rewritten between <!-- spec-tacle:<name> --> markers. Diagrams
// keys are the diagram id; their value replaces the block inside the
// diagram-id marker section. The block shape depends on the diagram's kind:
//   - table               → the raw markdown table (no code fence)
//   - flowchart-family    → an agent-readable **Nodes** + **Edges** inventory
//                           (regenerated from the mermaid source + descriptions)
//                           followed by the ```mermaid``` fence
//   - state / sequence    → the corresponding States/Transitions or Actors/
//                           Messages inventory followed by the ```mermaid``` fence
//   - pie / xychart / …   → just the ```mermaid``` fence (the numbers are the
//                           inventory)
// Every update writes a timestamped backup of the spec into a `backups/`
// folder next to the spec.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const BACKUPS_DIRNAME = 'backups';
const CONSISTENCY_QUEUE_FILENAME = '.spec-tacle-consistency-pending.json';
const AGENT_LOGS_DIRNAME = '.spec-tacle-agent-logs';

// A subprocess that dies non-zero in under this many milliseconds almost
// never "ran the pass and failed" — it's a spawn/quoting/binary error that
// never reached the API. We surface those specially: log tail printed to
// stderr, spawnError stamped on the queue entry, dedicated SSE. Above the
// threshold we assume the pass actually ran and follow the normal release
// path (queue entry sits unclaimed, banner waits out the 30s handoff window).
const FAST_DEATH_MS = 5000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.md':   'text/markdown; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
};

function mimeFor(p) {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

function pad2(n) { return String(n).padStart(2, '0'); }
function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`;
}

// Timestamp resolution is 1s; two saves in the same second would collide and
// silently overwrite the earlier backup. Suffix with a counter if that happens.
function uniqueBackupPath(dir, stem, ext) {
  const base = `${stem}-${timestamp()}`;
  let candidate = path.join(dir, `${base}${ext}`);
  let i = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}.${i}${ext}`);
    i++;
  }
  return candidate;
}

// Matches a backup filename we produced ourselves: exact stem, then a hyphen,
// then a YYYY-MM-DDTHH-MM-SS timestamp (optionally .N for same-second collisions),
// then the original extension. Rejects unrelated files (e.g. backups of a
// differently-named spec whose stem happens to share a prefix).
function backupFilenameRegex(stem, ext) {
  return new RegExp(
    '^' + escapeRegex(stem) +
    '-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}(?:\\.\\d+)?' +
    escapeRegex(ext) + '$'
  );
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Returns { text, created }. `created` is true when the marker pair was not
// found in `text` and a new orphan section was appended at the end. Callers
// use that flag to warn the user, because an appended diagram-source section
// leaves the original mermaid block in place — the spec ends up with two.
function replaceBetweenMarkers(text, name, newContent) {
  const start = `<!-- spec-tacle:${name} -->`;
  const end = `<!-- /spec-tacle:${name} -->`;
  const pattern = new RegExp(escapeRegex(start) + '([\\s\\S]*?)' + escapeRegex(end));
  const replacement = `${start}\n${newContent}\n${end}`;
  if (pattern.test(text)) {
    return { text: text.replace(pattern, () => replacement), created: false };
  }
  const trail = text.endsWith('\n') ? '' : '\n';
  return { text: `${text}${trail}\n${replacement}\n`, created: true };
}

// --- Agent-readable inventory --------------------------------------------
// The block we write between the per-diagram markers is a Nodes + Edges
// inventory (or States + Transitions, or Actors + Messages) followed by the
// mermaid fence — so a coding agent that reads only the markdown spec can
// reconstruct the graph without parsing mermaid syntax. The inventory is
// regenerated deterministically from the mermaid source and the descriptions
// map on every Update; hand-editing the inventory in the spec is pointless
// because the next Update overwrites it.

function detectDiagramFamily(source) {
  // First non-empty, non-comment line drives the family. Unknown → 'other',
  // which suppresses inventory generation (we just wrap in a mermaid fence).
  for (const raw of String(source).split(/\r?\n/)) {
    const line = raw.replace(/%%.*$/, '').trim();
    if (!line) continue;
    if (/^%%\{/i.test(line)) continue; // frontmatter init directive
    if (/^(flowchart|graph)\b/i.test(line)) return 'flowchart';
    if (/^stateDiagram(?:-v2)?\b/i.test(line)) return 'state';
    if (/^sequenceDiagram\b/i.test(line)) return 'sequence';
    return 'other'; // pie, xychart-beta, quadrantChart, gantt, erDiagram, …
  }
  return 'other';
}

// Node-shape bracket pairs, longest opening first so `[[` beats `[` and
// stadium `([...])` beats bare `(...)`.
const NODE_SHAPES = [
  ['[[', ']]'], ['[(', ')]'], ['([', '])'], ['((', '))'],
  ['[/', '/]'], ['[\\', '\\]'],
  ['[', ']'], ['(', ')'],
  ['{{', '}}'], ['{', '}'],
  ['>', ']'],
];

function stripLabel(raw) {
  return String(raw)
    .replace(/^\s*["']|["']\s*$/g, '')
    .replace(/\\n|<br\s*\/?>/gi, ' / ')
    .trim();
}

function matchNode(s, from) {
  const rest = s.slice(from);
  const m = rest.match(/^([A-Za-z_][A-Za-z0-9_-]*)/);
  if (!m) return null;
  const id = m[1];
  let cursor = from + id.length;
  for (const [open, close] of NODE_SHAPES) {
    if (s.startsWith(open, cursor)) {
      const end = s.indexOf(close, cursor + open.length);
      if (end !== -1) {
        return { id, label: stripLabel(s.slice(cursor + open.length, end)), next: end + close.length };
      }
    }
  }
  return { id, label: '', next: cursor };
}

// Recognise a mermaid flowchart arrow at s[from]. Returns { next, label } or
// null. Handles: -->, ==>, -.->, <-->, plus pipe labels (-->|label|) and
// inline labels (-- text -->).
function matchArrow(s, from) {
  const rest = s.slice(from);
  const inline = rest.match(/^(<?[-=.]{2,4})\s+([^\-=<>|]+?)\s+([-=.]{2,4})([>xo])(?:\s*\|([^|]+)\|)?/);
  if (inline) {
    return { next: from + inline[0].length, label: (inline[5] || inline[2] || '').trim() };
  }
  const plain = rest.match(/^(<?[-=.]{2,4})([>xo])(?:\s*\|([^|]+)\|)?/);
  if (plain) {
    return { next: from + plain[0].length, label: plain[3] ? plain[3].trim() : '' };
  }
  return null;
}

function parseFlowchart(source) {
  const nodes = new Map(); // id -> label (first non-empty wins)
  const edges = []; // { source, target, label }
  for (const raw of String(source).split(/\r?\n/)) {
    const line = raw.replace(/%%.*$/, '').trim();
    if (!line) continue;
    // Directive keywords have to be followed by whitespace (or end of line);
    // otherwise a node named e.g. `Click["…"]` would be swallowed as a `click`
    // directive.
    if (/^(flowchart|graph|subgraph|end|classDef|class|click|style|linkStyle|direction)(?=\s|$)/i.test(line)) continue;
    let i = 0, lastNode = null, pendingLabel = '';
    while (i < line.length) {
      while (i < line.length && /\s/.test(line[i])) i++;
      if (i >= line.length) break;
      const arrow = matchArrow(line, i);
      if (arrow) { pendingLabel = arrow.label; i = arrow.next; continue; }
      const node = matchNode(line, i);
      if (node) {
        if (node.label && !nodes.get(node.id)) nodes.set(node.id, node.label);
        else if (!nodes.has(node.id)) nodes.set(node.id, '');
        if (lastNode) edges.push({ source: lastNode, target: node.id, label: pendingLabel });
        lastNode = node.id;
        pendingLabel = '';
        i = node.next;
        continue;
      }
      i++; // unknown character; skip
    }
  }
  return { nodes, edges };
}

function parseStateDiagram(source) {
  const states = new Map(); // id -> label
  const transitions = []; // { source, target, label }
  for (const raw of String(source).split(/\r?\n/)) {
    const line = raw.replace(/%%.*$/, '').trim();
    if (!line) continue;
    if (/^stateDiagram(?:-v2)?\b/i.test(line)) continue;
    if (/^(direction|note|end)\b/i.test(line)) continue;
    // `state "label" as Id` or `state Id`
    let m = line.match(/^state\s+(?:"([^"]+)"\s+as\s+)?([A-Za-z_][A-Za-z0-9_-]*)/i);
    if (m) { states.set(m[2], m[1] || states.get(m[2]) || ''); continue; }
    // `A --> B` or `A --> B : label`
    m = line.match(/^(\[\*\]|[A-Za-z_][A-Za-z0-9_-]*)\s*-->\s*(\[\*\]|[A-Za-z_][A-Za-z0-9_-]*)\s*(?::\s*(.+))?$/);
    if (m) {
      const src = m[1], tgt = m[2], lbl = (m[3] || '').trim();
      if (src !== '[*]' && !states.has(src)) states.set(src, '');
      if (tgt !== '[*]' && !states.has(tgt)) states.set(tgt, '');
      transitions.push({ source: src, target: tgt, label: lbl });
    }
  }
  return { states, transitions };
}

function parseSequenceDiagram(source) {
  const actors = new Map(); // id -> label
  const messages = []; // { source, target, label }
  for (const raw of String(source).split(/\r?\n/)) {
    const line = raw.replace(/%%.*$/, '').trim();
    if (!line) continue;
    if (/^sequenceDiagram\b/i.test(line)) continue;
    if (/^(autonumber|activate|deactivate|note|loop|alt|else|opt|par|and|rect|end)\b/i.test(line)) continue;
    let m = line.match(/^(participant|actor)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+(.+))?$/i);
    if (m) { actors.set(m[2], (m[3] || '').trim()); continue; }
    // Message arrows: ->>  -->>  ->  -->  -)  --)  x  --x. Ids for sequence
    // diagrams cannot contain `-`, or a name like `S` gets swallowed as `S-`
    // when the arrow starts with `-`.
    m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(-{1,2}(?:>>?|\)|x))\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/);
    if (m) {
      const src = m[1], tgt = m[3], lbl = m[4].trim();
      if (!actors.has(src)) actors.set(src, '');
      if (!actors.has(tgt)) actors.set(tgt, '');
      messages.push({ source: src, target: tgt, label: lbl });
    }
  }
  return { actors, messages };
}

// Look up an edge's user-authored description. Mermaid's edge id convention
// has shifted between versions (dashes in newer, underscores in older), so
// try both.
function lookupEdgeDescription(descriptions, source, target, nth) {
  if (!descriptions) return '';
  return descriptions[`edge:L-${source}-${target}-${nth}`]
      || descriptions[`edge:L_${source}_${target}_${nth}`]
      || '';
}

function bulletFor(label, ...parts) {
  const kept = parts.filter(p => p && String(p).trim().length);
  if (!kept.length) return `- ${label}`;
  const text = kept.join(' — ');
  const tail = /[.?!]$/.test(text) ? '' : '.';
  return `- ${label}: ${text}${tail}`;
}

function buildInventory(kind, source, descriptions) {
  const desc = descriptions || {};
  const family = kind === 'state' || kind === 'sequence' || kind === 'flowchart'
    ? kind
    : detectDiagramFamily(source);
  if (family === 'flowchart' || /^(architecture|user flow|information flow|dependency map|decision chart)$/i.test(kind || '')) {
    const { nodes, edges } = parseFlowchart(source);
    return renderInventory(
      { header: '**Nodes**', items: [...nodes].map(([id, label]) => bulletFor('`' + id + '`', label, desc[`node:${id}`])) },
      { header: '**Edges**', items: renderEdgeBullets(edges, desc) },
    );
  }
  if (family === 'state') {
    const { states, transitions } = parseStateDiagram(source);
    return renderInventory(
      { header: '**States**', items: [...states].map(([id, label]) => bulletFor('`' + id + '`', label, desc[`node:${id}`])) },
      { header: '**Transitions**', items: renderEdgeBullets(transitions, desc) },
    );
  }
  if (family === 'sequence') {
    const { actors, messages } = parseSequenceDiagram(source);
    return renderInventory(
      { header: '**Actors**', items: [...actors].map(([id, label]) => bulletFor('`' + id + '`', label, desc[`node:${id}`])) },
      { header: '**Messages**', items: renderEdgeBullets(messages, desc) },
    );
  }
  return ''; // pie / xychart / quadrant / unknown → no inventory
}

function renderEdgeBullets(edges, descriptions) {
  const counts = new Map();
  return edges.map(e => {
    const key = `${e.source}->${e.target}`;
    const nth = counts.get(key) || 0;
    counts.set(key, nth + 1);
    const d = lookupEdgeDescription(descriptions, e.source, e.target, nth);
    return bulletFor('`' + e.source + '` → `' + e.target + '`', e.label, d);
  });
}

function renderInventory(...sections) {
  const parts = [];
  for (const s of sections) {
    if (!s.items.length) continue;
    parts.push(s.header);
    parts.push('');
    parts.push(...s.items);
    parts.push('');
  }
  return parts.join('\n');
}

function buildDiagramBlock(entry) {
  const isObject = entry !== null && typeof entry === 'object';
  const source = isObject ? String(entry.source ?? '') : String(entry);
  const kind = isObject ? String(entry.kind || '') : '';
  const descriptions = isObject && entry.descriptions && typeof entry.descriptions === 'object'
    ? entry.descriptions
    : null;

  if (kind === 'table') return source;

  const fence = '```mermaid\n' + source + '\n```';
  const inventory = buildInventory(kind, source, descriptions);
  return inventory ? `${inventory}\n${fence}` : fence;
}

// --- Consistency-pass queue ------------------------------------------------
// After every user Update spec the server writes a queue entry that names the
// edits that just landed and the pre-edit contents of each changed section.
// A Claude Code session (or any other reasoning agent) reads the queue,
// decides what related sections in the same spec need to catch up, and posts
// them to POST /consistency-apply. That endpoint applies the follow-up edits
// via the same round-trip pipeline, tags the resulting spec-changed SSE with
// origin: 'consistency', and clears the queue entry.
//
// The queue file lives at <served-root>/<CONSISTENCY_QUEUE_FILENAME>. One
// file per served root, holding an array of entries (all specs share the
// queue so an invoker can watch a single file for pending work).
function queuePathFor(servedRoot) {
  return path.join(servedRoot, CONSISTENCY_QUEUE_FILENAME);
}

function readConsistencyQueue(servedRoot) {
  const p = queuePathFor(servedRoot);
  if (!fs.existsSync(p)) return { entries: [] };
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const obj = JSON.parse(raw);
    if (!obj || !Array.isArray(obj.entries)) return { entries: [] };
    return obj;
  } catch (_) {
    return { entries: [] };
  }
}

function writeConsistencyQueue(servedRoot, obj) {
  const p = queuePathFor(servedRoot);
  const body = JSON.stringify(obj, null, 2);
  fs.writeFileSync(p, body, 'utf-8');
}

function newEntryId() {
  return `${timestamp()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Build the queue entry from the pre-edit spec text, the post-edit spec text,
// and the payload that produced the edit. We store the raw before/after of
// each named marker section so the invoker has enough context to reason about
// related edits without having to diff the file itself.
function buildQueueEntry({ specPathRel, backupRel, originalText, updatedText, payload }) {
  const sections = [];
  for (const [name, after] of Object.entries(payload.sections || {})) {
    sections.push({
      name,
      before: extractMarkerContent(originalText, name),
      after: String(after),
    });
  }
  const diagrams = [];
  for (const [id, entry] of Object.entries(payload.diagrams || {})) {
    const isObject = entry !== null && typeof entry === 'object';
    const afterSource = isObject ? String(entry.source ?? '') : String(entry);
    const kind = isObject ? String(entry.kind || '') : '';
    diagrams.push({
      id,
      kind,
      beforeBlock: extractMarkerContent(originalText, `diagram:${id}`),
      afterSource,
    });
  }
  return {
    id: newEntryId(),
    specPath: specPathRel,
    backup: backupRel,
    changedAt: Date.now(),
    origin: 'user',
    sections,
    diagrams,
  };
}

function extractMarkerContent(text, name) {
  const start = `<!-- spec-tacle:${name} -->`;
  const end = `<!-- /spec-tacle:${name} -->`;
  const pattern = new RegExp(escapeRegex(start) + '\\n?([\\s\\S]*?)\\n?' + escapeRegex(end));
  const m = pattern.exec(text);
  return m ? m[1] : '';
}

function appendConsistencyEntry(servedRoot, entry) {
  const q = readConsistencyQueue(servedRoot);
  q.entries.push(entry);
  writeConsistencyQueue(servedRoot, q);
  return q;
}

function removeConsistencyEntry(servedRoot, entryId) {
  const q = readConsistencyQueue(servedRoot);
  const before = q.entries.length;
  q.entries = q.entries.filter(e => e.id !== entryId);
  if (q.entries.length !== before) writeConsistencyQueue(servedRoot, q);
  return before !== q.entries.length;
}

// Atomic read-modify-write of a single queue entry. Returns the mutated entry
// (or null if not found). Mutations happen under the same read/write pair, so
// concurrent claim/progress POSTs can't clobber each other on the queue file.
function updateConsistencyEntry(servedRoot, entryId, mutator) {
  const q = readConsistencyQueue(servedRoot);
  const idx = q.entries.findIndex(e => e.id === entryId);
  if (idx < 0) return null;
  const next = mutator({ ...q.entries[idx] });
  if (!next) return null;
  q.entries[idx] = next;
  writeConsistencyQueue(servedRoot, q);
  return next;
}

// Default claim time-to-live. Long enough for a Claude Code turn to drive a
// full consistency pass (read → scan → draft → apply → re-render), short
// enough that a crashed or abandoned claim doesn't wedge the queue.
const DEFAULT_CLAIM_TTL_MS = 300 * 1000;

// Strip everything spec-tacle has added to a spec so what's left reads as a
// normal markdown document: no `<!-- spec-tacle:x -->` marker comments, no
// auto-generated Nodes/Edges inventory blocks before the mermaid fence, no
// empty caption/detail/notes marker blocks left as holes. Pure function —
// used by the /finalize endpoint and covered by tests.
//
// Round-trip after finalize: spec-tacle can be re-run on the file, which
// re-adds markers and re-derives the inventory from mermaid on the next
// Update. Finalize is one-way from the visualizer's perspective but not
// destructive to the spec's content.
function stripSpecTacleArtifacts(text) {
  let cleaned = String(text);

  // Phase 1: inside each diagram *source* marker block (e.g.
  // `<!-- spec-tacle:diagram:arch -->`, NOT `:caption`/`:detail`/`:notes`),
  // keep only the mermaid fence or the table body. Drops the inventory
  // (`**Nodes**` / `**Edges**` / `**States**` / …) that the server
  // regenerates on every Update — a human reader has the fence, so the
  // bullet list is just clutter after finalize.
  //
  // The name pattern `diagram:[^\s>:]+` deliberately forbids a further `:`
  // in the captured id, so `diagram:arch:caption` (a sibling marker) does
  // NOT match this regex and its body is untouched here — it's handled by
  // Phase 2/3 below.
  const diagramSourceRe = /<!-- spec-tacle:(diagram:[^\s>:]+) -->[ \t]*\n?([\s\S]*?)\n?[ \t]*<!-- \/spec-tacle:\1 -->/g;
  cleaned = cleaned.replace(diagramSourceRe, (_, id, body) => {
    const trimmed = body.trim();
    const fenceMatch = trimmed.match(/```mermaid[\s\S]*?```/);
    // Fence present → keep just the fence (strip inventory). No fence →
    // treat body as a table (kind: 'table') or empty, and leave it alone.
    const kept = fenceMatch ? fenceMatch[0] : trimmed;
    return `<!-- spec-tacle:${id} -->\n${kept}\n<!-- /spec-tacle:${id} -->`;
  });

  // Phase 2: remove empty marker blocks whole — bare `:notes` markers
  // around no content are common (users often don't fill them), and just
  // stripping the marker lines in Phase 3 would leave an empty gap.
  const anyMarkerRe = /<!-- spec-tacle:([^\s>]+) -->[ \t]*\n?([\s\S]*?)\n?[ \t]*<!-- \/spec-tacle:\1 -->[ \t]*\r?\n?/g;
  cleaned = cleaned.replace(anyMarkerRe, (match, _name, body) => {
    return body.trim().length === 0 ? '' : match;
  });

  // Phase 3: strip all remaining spec-tacle marker comment lines (open +
  // close). Anchored to line starts so a spurious inline `<!-- spec-tacle:x
  // -->` inside a code sample wouldn't be touched — real markers always
  // sit on their own line.
  cleaned = cleaned.replace(/^[ \t]*<!-- \/?spec-tacle:[^\n]*? -->[ \t]*\r?\n?/gm, '');

  // Phase 4: collapse the runs of blank lines that marker removal leaves
  // behind. Never shrinks below the two-newline paragraph break markdown
  // needs to render as separate blocks.
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  return cleaned;
}

// Decorate a raw queue entry with server-computed claim state so clients don't
// have to reason about the wall clock themselves. Never mutates the source.
function decorateEntry(entry, now) {
  const claim = entry.claim || null;
  let claimState = 'unclaimed';
  let claimExpiresAt = null;
  if (claim && Number.isFinite(claim.claimedAt) && Number.isFinite(claim.ttlMs)) {
    claimExpiresAt = claim.claimedAt + claim.ttlMs;
    claimState = now < claimExpiresAt ? 'active' : 'stale';
  }
  return { ...entry, claimState, claimExpiresAt };
}

function applyUpdates(original, payload) {
  let text = original;
  const created = [];
  const sections = payload.sections || {};
  for (const [name, newContent] of Object.entries(sections)) {
    const r = replaceBetweenMarkers(text, name, newContent);
    text = r.text;
    if (r.created) created.push(name);
  }
  const diagrams = payload.diagrams || {};
  for (const [name, entry] of Object.entries(diagrams)) {
    // Three accepted shapes per diagram:
    //   "source"                       → mermaid fence, no inventory (legacy)
    //   { source, kind }               → mermaid fence + kind-appropriate
    //                                    inventory built from the source alone
    //                                    (edges/nodes labelled only by their
    //                                    mermaid labels; no descriptions)
    //   { source, kind, descriptions } → same, but descriptions decorate the
    //                                    inventory bullets. `kind: 'table'`
    //                                    always writes raw markdown.
    const body = buildDiagramBlock(entry);
    const r = replaceBetweenMarkers(text, `diagram:${name}`, body);
    text = r.text;
    if (r.created) created.push(`diagram:${name}`);
  }
  return { text, created };
}

function makeServer({ root, port }) {
  const servedRoot = path.resolve(root);
  // Set by start() once the port is bound and any --on-consistency-pending /
  // --auto-agent hook is wired. handleUpdate() calls it after enqueue so a
  // headless agent (or any user-configured shell command) can start the pass
  // without the user having to ping anything.
  let onConsistencyPending = null;
  function setConsistencyPendingHook(fn) { onConsistencyPending = fn; }

  // --- SSE fan-out ------------------------------------------------------
  // One connection per open visualizer tab. On disk changes we broadcast to
  // every subscriber; the client hot-reloads its drawer without touching
  // in-progress diagram state.
  const sseClients = new Set();
  function sseSend(res, event, payload) {
    // A dropped connection surfaces as ERR_STREAM_WRITE_AFTER_END on the next
    // write; catch silently so one dead tab doesn't take down the broadcast.
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (_) { /* client is gone; the 'close' handler will drop it */ }
  }
  function sseBroadcast(event, payload) {
    for (const c of sseClients) sseSend(c, event, payload);
  }

  // Ping every 25s so intermediary proxies don't idle the connection out and
  // so a half-closed socket surfaces to the client sooner.
  const sseHeartbeat = setInterval(() => {
    for (const c of sseClients) {
      try { c.write(': ping\n\n'); } catch (_) { /* handled by close */ }
    }
  }, 25000);
  sseHeartbeat.unref();

  function handleEvents(req, res, urlObj) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Nudge the client's EventSource open right away.
    res.write('retry: 2000\n\n');
    sseClients.add(res);
    const drop = () => { sseClients.delete(res); };
    req.on('close', drop);
    req.on('error', drop);
    // Arm a watcher for the spec this tab cares about, so an on-disk edit
    // fires even if the drawer was never opened (which is when a
    // /spec-source fetch would otherwise install the watcher). Silently
    // skip a bad specPath — the endpoint stays useful for tabs that don't
    // pass one.
    const raw = urlObj && urlObj.searchParams.get('specPath');
    if (raw) {
      try {
        const abs = resolveSpec(raw);
        if (fs.existsSync(abs)) ensureWatch(abs);
      } catch (_) { /* out-of-root or bad path: ignore */ }
    }
  }

  // --- File watching ---------------------------------------------------
  // One watcher per spec file we've been asked about. Debounced because
  // fs.watch fires 1-3 events per save on macOS/Linux. The stored
  // lastMtime + lastSize lets us skip identical-content events (e.g. a
  // touch that leaves the bytes unchanged).
  const watchers = new Map(); // absPath -> { watcher, timer, lastMtime, lastSize }
  function ensureWatch(absPath) {
    if (watchers.has(absPath)) return;
    let entry;
    try {
      const stat = fs.statSync(absPath);
      const watcher = fs.watch(absPath, { persistent: false }, () => {
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => onSpecChanged(absPath), 120);
      });
      watcher.on('error', () => {
        // Editors that atomically replace files (write to tmp + rename) can
        // invalidate the watcher. Drop it so the next /spec-source rewatches.
        try { watcher.close(); } catch (_) {}
        watchers.delete(absPath);
      });
      entry = { watcher, timer: null, lastMtime: stat.mtimeMs, lastSize: stat.size };
      watchers.set(absPath, entry);
    } catch (_) {
      // File disappeared between /spec-source and the watch call — skip
      // silently; the next fetch will retry.
    }
  }

  function onSpecChanged(absPath) {
    const entry = watchers.get(absPath);
    if (!entry) return;
    let stat, text;
    try { stat = fs.statSync(absPath); }
    catch (_) {
      // Removed. Tell subscribers, drop the watcher.
      sseBroadcast('spec-removed', { specPath: path.relative(servedRoot, absPath) });
      try { entry.watcher.close(); } catch (_) {}
      watchers.delete(absPath);
      return;
    }
    if (stat.mtimeMs === entry.lastMtime && stat.size === entry.lastSize) return;
    entry.lastMtime = stat.mtimeMs;
    entry.lastSize = stat.size;
    try { text = fs.readFileSync(absPath, 'utf-8'); }
    catch (_) { return; }
    sseBroadcast('spec-changed', {
      specPath: path.relative(servedRoot, absPath),
      mtime: stat.mtimeMs,
      text,
    });
  }

  function resolveSpec(rawPath) {
    const abs = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(servedRoot, rawPath);
    if (abs !== servedRoot && !abs.startsWith(servedRoot + path.sep)) {
      throw Object.assign(new Error(`spec path ${abs} is outside served root ${servedRoot}`), { code: 'EACCES' });
    }
    return abs;
  }

  // Directories the fallback scanner never descends into. `.git` and dependency
  // dirs would balloon the walk; `backups/` holds timestamped copies of past
  // spec versions that must never be picked as a fallback for a live edit.
  const SPEC_FALLBACK_SKIP = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', BACKUPS_DIRNAME]);

  // Walks the served root for markdown files whose basename matches `basename`.
  // Bounded depth so a huge monorepo doesn't wedge a request. Returns absolute
  // paths sorted by nesting depth so the shallowest hit wins ties in the caller.
  function findByBasename(basename, { maxDepth = 6 } = {}) {
    const hits = [];
    const walk = (dir, depth) => {
      if (depth > maxDepth) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch { return; }
      for (const ent of entries) {
        if (ent.name.startsWith('.') && ent.name !== '.') continue;
        if (SPEC_FALLBACK_SKIP.has(ent.name)) continue;
        const abs = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(abs, depth + 1);
        else if (ent.isFile() && ent.name === basename) hits.push(abs);
      }
    };
    walk(servedRoot, 0);
    hits.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
    return hits;
  }

  // Resolve `rawPath` against servedRoot; if that file doesn't exist, try to
  // recover by finding a single file under servedRoot with the same basename.
  // Returns { specPath, corrected, requestedRel, resolvedRel, hint? } and never
  // silently picks between ambiguous candidates — a 0-or-many hit still fails
  // (with a hint that names what we did find), so the caller can 404 with a
  // useful message. This catches the `specPath` / `--root` mismatch that a
  // freshly-generated data JSON hits when the two disagree.
  function resolveSpecWithFallback(rawPath) {
    const requested = resolveSpec(rawPath);
    if (fs.existsSync(requested)) {
      return {
        specPath: requested,
        corrected: false,
        requestedRel: path.relative(servedRoot, requested),
        resolvedRel: path.relative(servedRoot, requested),
      };
    }
    const basename = path.basename(requested);
    const matches = findByBasename(basename).filter(p => p !== requested);
    if (matches.length === 1) {
      return {
        specPath: matches[0],
        corrected: true,
        requestedRel: path.relative(servedRoot, requested),
        resolvedRel: path.relative(servedRoot, matches[0]),
        hint: `no file at "${path.relative(servedRoot, requested)}"; using "${path.relative(servedRoot, matches[0])}" instead — update specPath in the data JSON to stop the fallback`,
      };
    }
    const hint = matches.length === 0
      ? `no file named "${basename}" under served root "${servedRoot}"`
      : `multiple files named "${basename}" under served root: ${matches.map(m => path.relative(servedRoot, m)).join(', ')} — set specPath to the one you mean`;
    const err = Object.assign(new Error(`spec not found: ${requested} (${hint})`), { code: 'ENOENT', status: 404 });
    throw err;
  }

  function sendJson(res, status, obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf-8');
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': String(body.length),
      'Cache-Control': 'no-store',
    });
    res.end(body);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')); }
        catch (e) { reject(e); }
      });
      req.on('error', reject);
    });
  }

  function serveStatic(req, res) {
    // Strip query string
    const url = req.url.split('?')[0];
    const rel = decodeURIComponent(url.replace(/^\/+/, ''));
    const abs = rel ? path.resolve(servedRoot, rel) : servedRoot;
    if (abs !== servedRoot && !abs.startsWith(servedRoot + path.sep)) {
      res.writeHead(403); res.end('Forbidden');
      return;
    }
    fs.stat(abs, (err, stat) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      let target = abs;
      if (stat.isDirectory()) {
        const idx = path.join(abs, 'index.html');
        if (fs.existsSync(idx)) {
          target = idx;
        } else {
          const items = fs.readdirSync(abs).sort();
          // If the directory has exactly one *-visualizer.html and no index.html,
          // that's the file the user wants — redirect straight to it. Covers the
          // common demo/serve case where a stale `/` tab or a plain-root click
          // would otherwise land the user on a bare listing (or 404 against an
          // earlier build).
          const visualizers = items.filter(n => n.endsWith('-visualizer.html'));
          if (visualizers.length === 1) {
            const dest = (rel ? `/${rel}/` : '/') + encodeURIComponent(visualizers[0]);
            res.writeHead(302, { Location: dest });
            res.end();
            return;
          }
          // Simple directory listing. Filenames come from disk — escape them
          // so a file named e.g. `<script>alert(1)</script>` doesn't execute.
          const displayPath = escapeHtml(rel ? `/${rel}` : '/');
          const html = `<!doctype html><meta charset="utf-8"><title>${displayPath}</title>` +
            `<h1>Index of ${displayPath}</h1><ul>` +
            items.map(n => {
              const isDir = fs.statSync(path.join(abs, n)).isDirectory();
              const href = encodeURIComponent(n) + (isDir ? '/' : '');
              return `<li><a href="${escapeHtml(href)}">${escapeHtml(n)}</a></li>`;
            }).join('') +
            `</ul>`;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(html);
          return;
        }
      }
      fs.readFile(target, (err2, buf) => {
        if (err2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, {
          'Content-Type': mimeFor(target),
          'Content-Length': String(buf.length),
          'Cache-Control': 'no-store',
        });
        res.end(buf);
      });
    });
  }

  // Applies a marker-anchored payload to a spec file. Shared between the user
  // Update spec path (POST /update-spec) and the consistency-pass path
  // (POST /consistency-apply). Returns { changed, backupPath, updated, original }
  // or a { ok: false, error } shape when the spec isn't found. Does NOT emit
  // any SSE — callers decide what event(s) to broadcast.
  function runUpdate(specPath, payload) {
    if (!fs.existsSync(specPath)) {
      return { ok: false, status: 404, error: `spec not found: ${specPath}` };
    }
    const original = fs.readFileSync(specPath, 'utf-8');
    const { text: updated, created } = applyUpdates(original, payload);
    if (updated === original) {
      return { ok: true, changed: false, created, original, updated };
    }
    const backupDir = path.join(path.dirname(specPath), BACKUPS_DIRNAME);
    fs.mkdirSync(backupDir, { recursive: true });
    const stem = path.basename(specPath, path.extname(specPath));
    const backupPath = uniqueBackupPath(backupDir, stem, path.extname(specPath));
    fs.writeFileSync(backupPath, original, 'utf-8');
    fs.writeFileSync(specPath, updated, 'utf-8');
    return { ok: true, changed: true, created, original, updated, backupPath };
  }

  async function handleUpdate(req, res) {
    try {
      const payload = await readJson(req);
      const resolved = resolveSpecWithFallback(payload.specPath || '');
      const specPath = resolved.specPath;
      const specPathRel = resolved.resolvedRel;
      if (resolved.corrected) {
        process.stdout.write(`[spec-tacle] specPath fallback: ${resolved.hint}\n`);
      }
      const result = runUpdate(specPath, payload);
      if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });
      if (!result.changed) {
        return sendJson(res, 200, { ok: true, changed: false, message: 'no edits to apply', created: result.created });
      }
      // Record a pending consistency-pass entry so an agent can propose the
      // related-section catch-up. Best-effort — a queue write failure never
      // fails the primary update.
      let pendingEntry = null;
      try {
        pendingEntry = buildQueueEntry({
          specPathRel,
          backupRel: path.relative(servedRoot, result.backupPath),
          originalText: result.original,
          updatedText: result.updated,
          payload,
        });
        appendConsistencyEntry(servedRoot, pendingEntry);
        // Broadcast the full decorated entry so the visualizer paints the
        // banner instantly — no round-trip to /consistency-pending needed
        // just to fill in the fields the SSE already knows.
        sseBroadcast('consistency-pending', {
          specPath: specPathRel,
          entryId: pendingEntry.id,
          sectionCount: pendingEntry.sections.length,
          diagramCount: pendingEntry.diagrams.length,
          entry: decorateEntry(pendingEntry, Date.now()),
          hookArmed: typeof onConsistencyPending === 'function',
        });
        process.stdout.write(`[spec-tacle] consistency-pass pending for ${specPathRel} (id ${pendingEntry.id}) — see ${CONSISTENCY_QUEUE_FILENAME}\n`);
        // Fire the auto-agent hook (or user's shell command) so the pass runs
        // without the user having to ping their agent. Best-effort — a hook
        // failure never fails the primary update.
        if (typeof onConsistencyPending === 'function') {
          try { onConsistencyPending(pendingEntry, { servedRoot }); }
          catch (e) { process.stderr.write(`[spec-tacle] consistency-pending hook failed: ${e.message}\n`); }
        }
      } catch (e) {
        process.stderr.write(`[spec-tacle] failed to enqueue consistency pass: ${e.message}\n`);
      }
      sendJson(res, 200, {
        ok: true,
        changed: true,
        backup: path.relative(servedRoot, result.backupPath),
        specPath: specPathRel,
        created: result.created,
        consistencyPending: pendingEntry ? pendingEntry.id : null,
      });
    } catch (err) {
      const code = err.code === 'EACCES' ? 403 : (err.status || (err.code === 'ENOENT' ? 404 : 500));
      sendJson(res, code, { ok: false, error: String(err.message || err) });
    }
  }

  // Applies a follow-up "consistency pass" edit and tags the outgoing
  // spec-changed SSE with origin: 'consistency' so the client can hot-reload
  // the affected summary/diagram fields and paint the highlight in a distinct
  // color. Payload matches /update-spec plus an entryId to clear from the queue.
  async function handleConsistencyApply(req, res) {
    try {
      const payload = await readJson(req);
      const resolved = resolveSpecWithFallback(payload.specPath || '');
      const specPath = resolved.specPath;
      const specPathRel = resolved.resolvedRel;
      if (resolved.corrected) {
        process.stdout.write(`[spec-tacle] specPath fallback (consistency-apply): ${resolved.hint}\n`);
      }
      const result = runUpdate(specPath, payload);
      if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });
      const entryId = payload.entryId || null;
      const cleared = entryId ? removeConsistencyEntry(servedRoot, entryId) : false;
      if (result.changed) {
        // Emit a targeted event so the client can highlight + partial-hot-reload
        // exactly the sections/diagrams that the pass touched, rather than
        // re-parsing the whole spec for a diff.
        const appliedSectionNames = Object.keys(payload.sections || {});
        const appliedDiagramIds = Object.keys(payload.diagrams || {});
        // Include the raw new content per section/diagram so the client can
        // update its in-memory state without re-fetching the spec.
        const sectionContents = {};
        for (const name of appliedSectionNames) sectionContents[name] = String(payload.sections[name]);
        const diagramContents = {};
        for (const id of appliedDiagramIds) {
          const entry = payload.diagrams[id];
          const isObject = entry !== null && typeof entry === 'object';
          diagramContents[id] = {
            source: isObject ? String(entry.source ?? '') : String(entry),
            kind: isObject ? String(entry.kind || '') : '',
          };
        }
        sseBroadcast('consistency-applied', {
          specPath: specPathRel,
          entryId,
          appliedSections: sectionContents,
          appliedDiagrams: diagramContents,
        });
      }
      sendJson(res, 200, {
        ok: true,
        changed: result.changed,
        cleared,
        backup: result.backupPath ? path.relative(servedRoot, result.backupPath) : null,
        specPath: specPathRel,
        created: result.created,
      });
    } catch (err) {
      const code = err.code === 'EACCES' ? 403 : (err.status || (err.code === 'ENOENT' ? 404 : 500));
      sendJson(res, code, { ok: false, error: String(err.message || err) });
    }
  }

  async function handleConsistencyDismiss(req, res) {
    try {
      const payload = await readJson(req);
      const entryId = payload.entryId;
      if (!entryId) return sendJson(res, 400, { ok: false, error: 'entryId required' });
      const cleared = removeConsistencyEntry(servedRoot, entryId);
      const specPathRaw = payload.specPath || '';
      if (cleared) sseBroadcast('consistency-dismissed', { specPath: specPathRaw, entryId });
      sendJson(res, 200, { ok: true, cleared });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err.message || err) });
    }
  }

  function handleConsistencyPending(req, res, urlObj) {
    try {
      const q = readConsistencyQueue(servedRoot);
      const wantSpec = urlObj.searchParams.get('specPath');
      const now = Date.now();
      const raw = wantSpec
        ? q.entries.filter(e => e.specPath === wantSpec)
        : q.entries;
      const entries = raw.map(e => decorateEntry(e, now));
      // hookArmed lets the visualizer stay optimistic on a fresh unclaimed
      // entry: "queued — auto-agent picking this up" instead of the loud
      // "nobody has claimed this yet — ping your agent". Only true when the
      // server was started with --auto-agent or --on-consistency-pending.
      sendJson(res, 200, { ok: true, entries, now, hookArmed: typeof onConsistencyPending === 'function' });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err.message || err) });
    }
  }

  // Agent stakes a claim on a queue entry: "I'm on this pass, don't expect
  // another agent to grab it." Claim carries an agent label and a TTL; a
  // second claim while an earlier claim is still active is refused with 409
  // unless `force: true` is passed (the visualizer's "release stale claim"
  // button uses release, not force-claim). Once the TTL elapses the claim is
  // effectively released — any agent may re-claim.
  async function handleConsistencyClaim(req, res) {
    try {
      const payload = await readJson(req);
      const entryId = payload.entryId;
      if (!entryId) return sendJson(res, 400, { ok: false, error: 'entryId required' });
      const agent = String(payload.agent || 'anonymous').slice(0, 200);
      const ttlSeconds = Number(payload.ttlSeconds);
      const ttlMs = Number.isFinite(ttlSeconds) && ttlSeconds > 0
        ? Math.min(ttlSeconds, 3600) * 1000
        : DEFAULT_CLAIM_TTL_MS;
      const force = payload.force === true;
      const now = Date.now();
      let refused = null;
      const updated = updateConsistencyEntry(servedRoot, entryId, (e) => {
        const existing = e.claim || null;
        if (!force && existing && Number.isFinite(existing.claimedAt) && Number.isFinite(existing.ttlMs)
            && now < existing.claimedAt + existing.ttlMs
            && existing.agent !== agent) {
          refused = existing;
          return null;
        }
        return {
          ...e,
          claim: { agent, claimedAt: now, ttlMs },
          // A fresh claim clears prior progress unless the same agent is
          // extending (renewing) — a renew keeps the progress bar in place.
          progress: (existing && existing.agent === agent) ? e.progress : null,
        };
      });
      if (!updated && refused) {
        return sendJson(res, 409, {
          ok: false,
          error: 'entry already claimed',
          claim: refused,
          claimExpiresAt: refused.claimedAt + refused.ttlMs,
        });
      }
      if (!updated) return sendJson(res, 404, { ok: false, error: 'entry not found' });
      const decorated = decorateEntry(updated, now);
      sseBroadcast('consistency-claimed', {
        specPath: updated.specPath,
        entryId,
        agent: updated.claim.agent,
        claimedAt: updated.claim.claimedAt,
        ttlMs: updated.claim.ttlMs,
        claimExpiresAt: decorated.claimExpiresAt,
        entry: decorated,
      });
      sendJson(res, 200, { ok: true, entry: decorated });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err.message || err) });
    }
  }

  // Agent reports progress on a claimed entry. Also extends the claim's TTL
  // (a heartbeat) so a long pass doesn't hit the stale line mid-work. Rejects
  // when no active claim exists — an agent must claim before reporting.
  async function handleConsistencyProgress(req, res) {
    try {
      const payload = await readJson(req);
      const entryId = payload.entryId;
      if (!entryId) return sendJson(res, 400, { ok: false, error: 'entryId required' });
      const percentRaw = Number(payload.percent);
      const percent = Number.isFinite(percentRaw)
        ? Math.max(0, Math.min(100, Math.round(percentRaw)))
        : null;
      const phase = payload.phase != null ? String(payload.phase).slice(0, 120) : null;
      const note = payload.note != null ? String(payload.note).slice(0, 400) : null;
      const agent = payload.agent != null ? String(payload.agent).slice(0, 200) : null;
      const now = Date.now();
      let reason = null;
      const updated = updateConsistencyEntry(servedRoot, entryId, (e) => {
        const claim = e.claim;
        if (!claim || !Number.isFinite(claim.claimedAt) || !Number.isFinite(claim.ttlMs)) {
          reason = 'no active claim';
          return null;
        }
        if (now >= claim.claimedAt + claim.ttlMs) {
          reason = 'claim expired';
          return null;
        }
        if (agent && agent !== claim.agent) {
          reason = `claim held by ${claim.agent}`;
          return null;
        }
        const progress = {
          percent: percent != null ? percent : (e.progress ? e.progress.percent : 0),
          phase: phase != null ? phase : (e.progress ? e.progress.phase : null),
          note: note != null ? note : (e.progress ? e.progress.note : null),
          updatedAt: now,
        };
        // Heartbeat: refresh claimedAt so TTL rolls forward from this beat.
        return {
          ...e,
          claim: { ...claim, claimedAt: now },
          progress,
        };
      });
      if (!updated) {
        const code = reason === 'no active claim' || reason === 'claim expired' ? 409 : 404;
        return sendJson(res, code, { ok: false, error: reason || 'entry not found' });
      }
      const decorated = decorateEntry(updated, now);
      sseBroadcast('consistency-progress', {
        specPath: updated.specPath,
        entryId,
        agent: updated.claim.agent,
        progress: updated.progress,
        claimExpiresAt: decorated.claimExpiresAt,
        entry: decorated,
      });
      sendJson(res, 200, { ok: true, entry: decorated });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err.message || err) });
    }
  }

  // Agent (or the visualizer, on a "release stale claim" click) drops a claim
  // without applying edits. Progress is cleared so a fresh claim starts empty.
  async function handleConsistencyRelease(req, res) {
    try {
      const payload = await readJson(req);
      const entryId = payload.entryId;
      if (!entryId) return sendJson(res, 400, { ok: false, error: 'entryId required' });
      let hadClaim = false;
      const updated = updateConsistencyEntry(servedRoot, entryId, (e) => {
        hadClaim = !!e.claim;
        return { ...e, claim: null, progress: null };
      });
      if (!updated) return sendJson(res, 404, { ok: false, error: 'entry not found' });
      if (hadClaim) {
        sseBroadcast('consistency-released', { specPath: updated.specPath, entryId });
      }
      sendJson(res, 200, { ok: true, entry: decorateEntry(updated, Date.now()) });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err.message || err) });
    }
  }

  function handleSpecSource(req, res, urlObj) {
    try {
      const raw = urlObj.searchParams.get('specPath') || '';
      const specPath = resolveSpec(raw);
      if (!fs.existsSync(specPath)) {
        return sendJson(res, 404, { ok: false, error: `spec not found: ${specPath}` });
      }
      const text = fs.readFileSync(specPath, 'utf-8');
      ensureWatch(specPath);
      sendJson(res, 200, {
        ok: true,
        specPath: path.relative(servedRoot, specPath),
        text,
        mtime: fs.statSync(specPath).mtimeMs,
      });
    } catch (err) {
      const code = err.code === 'EACCES' ? 403 : 500;
      sendJson(res, code, { ok: false, error: String(err.message || err) });
    }
  }

  // Line-level unified-ish diff (LCS via dynamic programming). Small specs,
  // ≤ ~10K lines — the O(m·n) memory cost is fine and beats pulling in a diff
  // library for a tool that otherwise ships with zero deps.
  function lineDiff(a, b) {
    const aLines = a.split('\n');
    const bLines = b.split('\n');
    const m = aLines.length, n = bLines.length;
    const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (aLines[i] === bLines[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
        else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const ops = [];
    let i = 0, j = 0;
    while (i < m && j < n) {
      if (aLines[i] === bLines[j]) { ops.push({ op: ' ', line: aLines[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ op: '-', line: aLines[i] }); i++; }
      else { ops.push({ op: '+', line: bLines[j] }); j++; }
    }
    while (i < m) { ops.push({ op: '-', line: aLines[i++] }); }
    while (j < n) { ops.push({ op: '+', line: bLines[j++] }); }
    return ops;
  }

  function handleSpecHistory(req, res, urlObj) {
    try {
      const raw = urlObj.searchParams.get('specPath') || '';
      const limitRaw = urlObj.searchParams.get('limit');
      const limit = Math.max(1, Math.min(20, parseInt(limitRaw, 10) || 5));
      const specPath = resolveSpec(raw);
      const backupDir = path.join(path.dirname(specPath), BACKUPS_DIRNAME);
      if (!fs.existsSync(specPath)) {
        return sendJson(res, 404, { ok: false, error: `spec not found: ${specPath}` });
      }
      const current = fs.readFileSync(specPath, 'utf-8');
      if (!fs.existsSync(backupDir)) {
        return sendJson(res, 200, { ok: true, entries: [] });
      }
      const ext = path.extname(specPath);
      const stem = path.basename(specPath, ext);
      const re = backupFilenameRegex(stem, ext);
      const files = fs.readdirSync(backupDir)
        .filter(f => re.test(f))
        .sort() // ISO-like timestamps sort chronologically
        .reverse()
        .slice(0, limit);
      // Diff each backup against the next-newer version (or the current spec for
      // the newest backup). That way each entry answers "what did this Update do?"
      // in isolation — rather than an ever-growing diff back to some baseline.
      const entries = [];
      let newer = current;
      for (const name of files) {
        const abs = path.join(backupDir, name);
        const older = fs.readFileSync(abs, 'utf-8');
        entries.push({
          backup: name,
          mtime: fs.statSync(abs).mtimeMs,
          ops: lineDiff(older, newer),
        });
        newer = older;
      }
      sendJson(res, 200, { ok: true, entries });
    } catch (err) {
      const code = err.code === 'EACCES' ? 403 : 500;
      sendJson(res, code, { ok: false, error: String(err.message || err) });
    }
  }

  // Finalize a spec-tacle workflow: strip markers + auto-inventories from
  // the spec so it reads like a normal markdown document, then delete the
  // per-spec backups directory and (best-effort) the consistency queue and
  // agent-logs directories that spec-tacle created. Returns a summary of
  // what was removed. Also broadcasts a `spec-finalized` SSE with the
  // cleaned text so open drawers hot-reload to the new source of truth.
  //
  // Not destructive: `git checkout <spec>` restores it, and re-running
  // spec-tacle on the file will re-insert markers on the next Update.
  // Backups, however, are gone once this runs — that's the point.
  async function handleFinalize(req, res) {
    try {
      const payload = await readJson(req);
      const resolved = resolveSpecWithFallback(payload.specPath || '');
      const specPath = resolved.specPath;
      const specPathRel = resolved.resolvedRel;
      const removed = [];

      // 1. Rewrite the spec if the strip changed anything.
      const original = fs.readFileSync(specPath, 'utf-8');
      const cleaned = stripSpecTacleArtifacts(original);
      let specChanged = false;
      if (cleaned !== original) {
        fs.writeFileSync(specPath, cleaned, 'utf-8');
        specChanged = true;
        removed.push(`markers + auto-inventories in ${specPathRel}`);
      }

      // 2. Delete the per-spec backups directory. Sitting right next to
      //    the spec, it's the biggest visible spec-tacle footprint and
      //    the one users most often want gone.
      const backupDir = path.join(path.dirname(specPath), BACKUPS_DIRNAME);
      if (fs.existsSync(backupDir)) {
        try {
          const bcount = fs.readdirSync(backupDir).length;
          fs.rmSync(backupDir, { recursive: true, force: true });
          removed.push(`${bcount} backup${bcount === 1 ? '' : 's'} in ${path.relative(servedRoot, backupDir) || BACKUPS_DIRNAME}/`);
        } catch (e) {
          removed.push(`(could not remove ${path.relative(servedRoot, backupDir)}: ${e.message})`);
        }
      }

      // 3. Drop this spec's consistency queue entries. If the queue is
      //    empty afterward, delete the file too so a finalized served
      //    root has no spec-tacle state at all.
      try {
        const q = readConsistencyQueue(servedRoot);
        const before = q.entries.length;
        q.entries = q.entries.filter(e => e.specPath !== specPathRel);
        const dropped = before - q.entries.length;
        if (dropped > 0) {
          if (q.entries.length === 0) {
            try { fs.unlinkSync(queuePathFor(servedRoot)); } catch (_) {}
            removed.push(`${dropped} consistency queue entr${dropped === 1 ? 'y' : 'ies'} (${CONSISTENCY_QUEUE_FILENAME} removed)`);
          } else {
            writeConsistencyQueue(servedRoot, q);
            removed.push(`${dropped} consistency queue entr${dropped === 1 ? 'y' : 'ies'}`);
          }
        }
      } catch (_) { /* not fatal */ }

      // 4. Best-effort: delete the agent-logs directory. It's per-served-
      //    root, not per-spec, so on a multi-spec root this is a bit
      //    aggressive — but a fresh log dir will be created for the next
      //    consistency pass anyway.
      const logsDir = path.join(servedRoot, AGENT_LOGS_DIRNAME);
      if (fs.existsSync(logsDir)) {
        try {
          const lcount = fs.readdirSync(logsDir).length;
          fs.rmSync(logsDir, { recursive: true, force: true });
          removed.push(`${lcount} agent log${lcount === 1 ? '' : 's'} in ${AGENT_LOGS_DIRNAME}/`);
        } catch (e) {
          removed.push(`(could not remove ${AGENT_LOGS_DIRNAME}: ${e.message})`);
        }
      }

      sseBroadcast('spec-finalized', {
        specPath: specPathRel,
        text: specChanged ? cleaned : original,
        mtime: fs.existsSync(specPath) ? fs.statSync(specPath).mtimeMs : null,
        removed,
      });

      sendJson(res, 200, {
        ok: true,
        specPath: specPathRel,
        specChanged,
        removed,
      });
    } catch (err) {
      const code = err.code === 'EACCES' ? 403 : (err.status || (err.code === 'ENOENT' ? 404 : 500));
      sendJson(res, code, { ok: false, error: String(err.message || err) });
    }
  }

  async function handleUndo(req, res) {
    try {
      const payload = await readJson(req);
      const specPath = resolveSpec(payload.specPath || '');
      const backupDir = path.join(path.dirname(specPath), BACKUPS_DIRNAME);
      if (!fs.existsSync(backupDir)) {
        return sendJson(res, 404, { ok: false, error: `no backup directory at ${backupDir}` });
      }
      const ext = path.extname(specPath);
      const stem = path.basename(specPath, ext);
      const re = backupFilenameRegex(stem, ext);
      const candidates = fs.readdirSync(backupDir)
        .filter(f => re.test(f))
        .sort();
      if (!candidates.length) {
        return sendJson(res, 404, { ok: false, error: `no backups for ${path.basename(specPath)}` });
      }
      const latest = candidates[candidates.length - 1];
      const latestPath = path.join(backupDir, latest);
      const content = fs.readFileSync(latestPath, 'utf-8');
      fs.writeFileSync(specPath, content, 'utf-8');
      fs.unlinkSync(latestPath);
      sendJson(res, 200, {
        ok: true,
        restored_from: latest,
        remaining_backups: candidates.length - 1,
      });
    } catch (err) {
      const code = err.code === 'EACCES' ? 403 : 500;
      sendJson(res, code, { ok: false, error: String(err.message || err) });
    }
  }

  // We bind to loopback and don't need cross-origin requests: the visualizer
  // is served from the same origin. Reply 204 to preflights without adding
  // CORS-allow headers — any cross-origin caller's fetch will be refused.
  const handler = (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.method === 'POST' && req.url === '/update-spec')         return handleUpdate(req, res);
    if (req.method === 'POST' && req.url === '/undo')                return handleUndo(req, res);
    if (req.method === 'POST' && req.url === '/finalize')            return handleFinalize(req, res);
    if (req.method === 'POST' && req.url === '/consistency-apply')   return handleConsistencyApply(req, res);
    if (req.method === 'POST' && req.url === '/consistency-dismiss') return handleConsistencyDismiss(req, res);
    if (req.method === 'POST' && req.url === '/consistency-claim')   return handleConsistencyClaim(req, res);
    if (req.method === 'POST' && req.url === '/consistency-progress')return handleConsistencyProgress(req, res);
    if (req.method === 'POST' && req.url === '/consistency-release') return handleConsistencyRelease(req, res);
    if (req.method === 'GET' || req.method === 'HEAD') {
      const urlObj = new URL(req.url, `http://localhost`);
      if (urlObj.pathname === '/events')              return handleEvents(req, res, urlObj);
      if (urlObj.pathname === '/spec-source')         return handleSpecSource(req, res, urlObj);
      if (urlObj.pathname === '/spec-history')        return handleSpecHistory(req, res, urlObj);
      if (urlObj.pathname === '/consistency-pending') return handleConsistencyPending(req, res, urlObj);
      return serveStatic(req, res);
    }
    res.writeHead(405); res.end('Method Not Allowed');
  };

  const server = http.createServer(handler);
  return { server, handler, port, servedRoot, setConsistencyPendingHook, sseBroadcast };
}

// The permissions template installed at <servedRoot>/.claude/settings.local.json
// so the headless `claude -p` subprocess the auto-agent hook spawns can Read,
// Edit, Write, and run the spec-tacle CLI without hitting an unanswerable
// permission dialog. Kept cwd-relative so the same template works in any
// served root — the demo dir, an example copy, or a real project.
const AUTO_AGENT_SETTINGS_TEMPLATE = {
  "$note": "Pre-approves the tools a spec-tacle consistency-pass subprocess needs, and lifts the sandbox restriction that would otherwise block `serve` from binding 127.0.0.1. Installed by `spec-tacle_skill serve --auto-agent` (and `demo`/`example`/`install-perms`) into <servedRoot>/.claude/settings.local.json when missing. Scoped to a claude session whose cwd is this directory. Safe to delete or narrow; the auto-agent will then stall on permission dialogs and you'll drive the pass manually.",
  permissions: {
    allow: [
      "Read(**)",
      "Edit(**)",
      "Bash(node:*)",
      "Bash(npx spec-tacle_skill:*)",
      "Bash(npx spec-tacle:*)",
      "Bash(node ./bin/spec-tacle.js serve:*)",
      "Bash(npx spec-tacle_skill serve:*)",
      "Bash(npx spec-tacle serve:*)",
      "Bash(curl:*)",
      "Bash(grep:*)",
      "Bash(sed:*)",
      "Bash(mkdir:*)",
      "Skill(spec-tacle)"
    ]
  },
  // The Seatbelt sandbox blocks a sandboxed command from binding a local TCP
  // port by default, which stops `node ./bin/spec-tacle.js serve` from ever
  // starting. allowLocalBinding lifts just that restriction for this project
  // — no other sandbox rule changes.
  sandbox: {
    network: {
      allowLocalBinding: true
    }
  }
};

// Idempotent installer for the auto-agent permissions template. Never
// overwrites an existing file — the user may have narrowed it or the repo
// may ship a project-specific version. Returns { path, action } where
// action is 'wrote' | 'kept' | 'skipped'. Best-effort; a filesystem error
// only surfaces as an action=skipped with a note in the log.
function ensureAutoAgentPermissions(servedRoot, { logPrefix } = {}) {
  const label = logPrefix || '[spec-tacle]';
  const dir = path.join(servedRoot, '.claude');
  const file = path.join(dir, 'settings.local.json');
  try {
    if (fs.existsSync(file)) {
      process.stdout.write(`${label} auto-agent permissions already at ${file} (kept as-is)\n`);
      return { path: file, action: 'kept' };
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(AUTO_AGENT_SETTINGS_TEMPLATE, null, 2) + '\n', 'utf-8');
    process.stdout.write(`${label} wrote auto-agent permissions to ${file}\n`);
    process.stdout.write(`${label} the headless claude subprocess can now Read/Edit/Write in this dir and run node/npx/curl/grep/sed/mkdir. Delete or narrow that file to opt out.\n`);
    return { path: file, action: 'wrote' };
  } catch (e) {
    process.stderr.write(`${label} could not install auto-agent permissions at ${file}: ${e.message}\n`);
    process.stderr.write(`${label} the auto-agent subprocess will likely stall on permission dialogs; run the pass manually if it does.\n`);
    return { path: file, action: 'skipped', error: e.message };
  }
}

// Narrow, safe rules to write into ~/.claude/settings.json when the skill is
// installed globally. Only pre-approves the spec-tacle CLI and skill entry —
// deliberately NOT Read/Edit/Write globs (those belong per-project in
// AUTO_AGENT_SETTINGS_TEMPLATE where their blast radius is scoped to the
// spec's directory). With just these rules, a fresh claude session can run
// `npx spec-tacle_skill ...` without a Bash-approval prompt for the CLI
// itself, and the first `serve --auto-agent` fills in the rest at the
// project level.
const USER_LEVEL_PERMISSIONS = [
  "Skill(spec-tacle)",
  "Bash(npx spec-tacle_skill:*)",
  "Bash(npx spec-tacle:*)",
];

// Idempotent, merging installer for ~/.claude/settings.json. Reads any
// existing file (an install-per-machine may already have user rules), unions
// USER_LEVEL_PERMISSIONS into permissions.allow[], writes back. Never
// removes existing rules. Returns { path, action, added } where action is
// 'wrote' | 'unchanged' | 'skipped' and `added` names the rules added.
function ensureUserLevelPermissions({ homeDir, logPrefix } = {}) {
  const label = logPrefix || '[spec-tacle]';
  const home = homeDir || require('os').homedir();
  const dir = path.join(home, '.claude');
  const file = path.join(dir, 'settings.json');
  try {
    let settings = {};
    if (fs.existsSync(file)) {
      try {
        settings = JSON.parse(fs.readFileSync(file, 'utf-8') || '{}');
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {};
      } catch (e) {
        process.stderr.write(`${label} could not parse ${file}: ${e.message} (leaving file alone)\n`);
        return { path: file, action: 'skipped', error: e.message };
      }
    }
    if (!settings.permissions || typeof settings.permissions !== 'object') settings.permissions = {};
    if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];
    const before = new Set(settings.permissions.allow);
    const added = USER_LEVEL_PERMISSIONS.filter(r => !before.has(r));
    if (!added.length) {
      process.stdout.write(`${label} user-level permissions already present at ${file} (nothing to add)\n`);
      return { path: file, action: 'unchanged', added: [] };
    }
    settings.permissions.allow = [...settings.permissions.allow, ...added];
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    process.stdout.write(`${label} added ${added.length} spec-tacle permission${added.length === 1 ? '' : 's'} to ${file}:\n`);
    for (const r of added) process.stdout.write(`${label}   + ${r}\n`);
    process.stdout.write(`${label} future claude sessions can now invoke the skill and run \`npx spec-tacle_skill …\` without a Bash-approval prompt. Delete the entries to opt out.\n`);
    return { path: file, action: 'wrote', added };
  } catch (e) {
    process.stderr.write(`${label} could not update user-level permissions at ${file}: ${e.message}\n`);
    return { path: file, action: 'skipped', error: e.message };
  }
}

// Translate one `claude -p --output-format stream-json --verbose` event into
// a progress delta the visualizer can render. The auto-agent hook pipes the
// child's stdout through this so the operator sees real-time feedback — tool
// name in the phase line, tool target in the note, percent stepped per tool
// call — without depending on the sub-agent to remember to POST
// /consistency-progress itself. Returns null for events that don't advance
// the bar (empty text turns, deltas, unrecognized shapes).
//
// Percent formula: base 15 (after "auto-agent booting"), +7 per tool call,
// capped at 90 so the exit-side "wrapping up" beat can still show motion.
function deriveProgressFromStreamJson(ev, toolCount) {
  if (!ev || typeof ev !== 'object') return null;
  if (ev.type === 'system' && (ev.subtype === 'init' || ev.subtype == null)) {
    return { percent: 10, phase: 'auto-agent booting', note: 'session initializing' };
  }
  if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    for (const block of ev.message.content) {
      if (!block || block.type !== 'tool_use') continue;
      const name = String(block.name || 'tool');
      const input = block.input && typeof block.input === 'object' ? block.input : {};
      let note = '';
      if (name === 'Bash') {
        const cmd = String(input.command || '');
        // A curl to /consistency-apply is the money shot — call it out so the
        // user sees the pass is about to land, not just "another Bash".
        if (/\/consistency-apply\b/.test(cmd))       note = 'posting follow-up edits to /consistency-apply';
        else if (/\/consistency-claim\b/.test(cmd))  note = 'claiming the queue entry';
        else if (/\/consistency-release\b/.test(cmd)) note = 'releasing the claim';
        else if (/\/consistency-progress\b/.test(cmd)) note = 'reporting progress';
        else                                         note = truncateForProgress(cmd, 200);
      } else if (name === 'Read' || name === 'Edit' || name === 'Write' || name === 'NotebookEdit') {
        note = truncateForProgress(String(input.file_path || input.notebook_path || ''), 200);
      } else if (name === 'Grep' || name === 'Glob') {
        note = truncateForProgress(String(input.pattern || ''), 120);
      } else if (name === 'TodoWrite') {
        note = 'planning follow-up steps';
      } else if (name === 'Task' || name === 'Agent') {
        note = truncateForProgress(String(input.description || input.prompt || ''), 200);
      } else if (name === 'WebFetch' || name === 'WebSearch') {
        note = truncateForProgress(String(input.url || input.query || ''), 200);
      } else {
        // Fallback: first stringy field, or the tool name alone.
        for (const v of Object.values(input)) {
          if (typeof v === 'string' && v.trim().length) { note = truncateForProgress(v, 200); break; }
        }
      }
      const percent = Math.min(15 + toolCount * 7, 90);
      return { percent, phase: name, note };
    }
    return null; // text-only assistant turn; wait for the next event
  }
  if (ev.type === 'result') {
    const errored = ev.is_error === true || ev.subtype === 'error';
    return {
      percent: errored ? 95 : 95,
      phase: errored ? 'auto-agent errored' : 'wrapping up',
      note: errored ? String(ev.error || 'see agent log').slice(0, 200) : '',
    };
  }
  return null;
}

function truncateForProgress(s, n) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// Substitute {entryId}, {specPath}, {root}, {port}, {id} into a shell command
// string. String values get single-quote-wrapped with the standard
// close-quote/escape-quote/re-open dance so a wild character in a spec path
// or entry id can't break out. Numeric-only values (like port) pass through
// unquoted so they slot cleanly into URLs (`http://.../{port}`) without
// growing embedded quotes.
function interpolateHookCmd(template, ctx) {
  const shellQuote = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
  return String(template).replace(/\{(entryId|id|specPath|root|port)\}/g, (_, key) => {
    if (key === 'id') key = 'entryId';
    const raw = ctx[key] != null ? ctx[key] : '';
    const s = String(raw);
    return /^\d+$/.test(s) ? s : shellQuote(s);
  });
}

// Build the callback plumbed into makeServer's setConsistencyPendingHook.
// Spawns the configured shell command in a detached child so it outlives the
// enqueue request. The child inherits env plus the interpolation vars, so a
// user's script can read $SPEC_TACLE_ENTRY_ID / $SPEC_TACLE_SPEC_PATH etc.
// even without using the template placeholders.
function makeConsistencyPendingHook({ commandTemplate, port, logPrefix, broadcast, parseStreamJson }) {
  if (!commandTemplate) return null;
  const { spawn } = require('child_process');
  const readline = require('readline');
  const label = logPrefix || '[spec-tacle]';
  return (entry, { servedRoot }) => {
    // Stamp hookFiredAt onto the queue entry so the visualizer can distinguish
    // "queued, waiting for handoff (< 30s since hook fired)" from "queued and
    // stalled (nobody claimed after the threshold)". Also auto-claim on the
    // subprocess's behalf so the visualizer flips to "active" the moment the
    // hook fires — the sub-agent posting /consistency-claim itself would leave
    // the UI painting "stalled" through the whole (successful) pass. The auto
    // claim is released in the exit handler if the entry is still in the
    // queue when the child dies. Best-effort — a queue write failure never
    // blocks the spawn.
    const autoAgentLabel = 'spec-tacle-auto-agent';
    const autoClaim = { agent: autoAgentLabel, claimedAt: Date.now(), ttlMs: DEFAULT_CLAIM_TTL_MS };
    let claimedByUs = false;
    try {
      const updated = updateConsistencyEntry(servedRoot, entry.id, (e) => {
        const existing = e.claim || null;
        const now = Date.now();
        // Don't stomp on a live claim held by a different agent — the user
        // might have taken over manually and is heartbeating. But an expired
        // or absent claim, or one we already hold, is ours to renew.
        if (existing && existing.agent !== autoAgentLabel && Number.isFinite(existing.claimedAt) && Number.isFinite(existing.ttlMs)
            && now < existing.claimedAt + existing.ttlMs) {
          return { ...e, hookFiredAt: now };
        }
        claimedByUs = true;
        // Seed the progress bar so the banner shows "active + working" from
        // the moment the subprocess is spawned. With parseStreamJson the
        // stdout parser will overwrite this within a second (first system
        // init event, then per-tool progress); without it, this is what the
        // user sees for the whole pass.
        const seededProgress = parseStreamJson
          ? { percent: 5, phase: 'auto-agent spawning', note: 'streaming tool events', updatedAt: now }
          : { percent: 5, phase: 'auto-agent spawning', note: 'headless subprocess; output flushes at completion', updatedAt: now };
        return { ...e, hookFiredAt: now, claim: autoClaim, progress: seededProgress };
      });
      if (claimedByUs && updated && typeof broadcast === 'function') {
        const decorated = decorateEntry(updated, Date.now());
        broadcast('consistency-claimed', {
          specPath: updated.specPath,
          entryId: updated.id,
          claim: autoClaim,
          entry: decorated,
        });
        broadcast('consistency-progress', {
          specPath: updated.specPath,
          entryId: updated.id,
          progress: updated.progress,
          entry: decorated,
        });
      }
    } catch (_) { /* not fatal */ }
    const ctx = {
      entryId: entry.id,
      specPath: entry.specPath,
      root: servedRoot,
      port,
    };
    const cmd = interpolateHookCmd(commandTemplate, ctx);
    const env = {
      ...process.env,
      SPEC_TACLE_ENTRY_ID: entry.id,
      SPEC_TACLE_SPEC_PATH: entry.specPath,
      SPEC_TACLE_SERVED_ROOT: servedRoot,
      SPEC_TACLE_PORT: String(port),
    };
    // If spec-tacle itself was started from inside a Claude Code session
    // (i.e. a developer iterating on the tool), the parent's env includes
    // session-scoped proxy variables pointing at a filtering proxy on
    // localhost:5xxxx whose credentials expire with the parent's active
    // tool_use. A subprocess that inherits them fails every API call with
    // `ERR_PROXY_TUNNEL` and the pass silently stalls. Scrub them so the
    // headless subprocess reaches api.anthropic.com directly through
    // whatever proxy the OS actually has (usually none, or a corporate one
    // set outside Claude). Also drop the parent's Claude Code session
    // markers so the child boots as its own top-level session rather than a
    // child of ours. A normal terminal invocation has none of these set, so
    // the scrub is a no-op there.
    if (env.CLAUDECODE === '1' || env.CLAUDE_CODE_ENTRYPOINT) {
      for (const k of [
        'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
        'http_proxy', 'https_proxy', 'no_proxy',
        'ALL_PROXY', 'all_proxy',
        'GRPC_PROXY', 'grpc_proxy',
        'FTP_PROXY', 'ftp_proxy',
        'RSYNC_PROXY',
        'DOCKER_HTTP_PROXY', 'DOCKER_HTTPS_PROXY',
        'CLOUDSDK_PROXY_TYPE', 'CLOUDSDK_PROXY_ADDRESS', 'CLOUDSDK_PROXY_PORT',
        'GIT_SSH_COMMAND', 'GIT_CONFIG_PARAMETERS',
        'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT',
        'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
        'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION',
        'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_TMPDIR',
        'CLAUDE_CODE_EXECPATH', 'CLAUDE_TMPDIR', 'CLAUDE_PID',
        'CLAUDE_EFFORT',
      ]) delete env[k];
    }
    // Per-entry log file so operators can see what the headless subprocess did
    // — auth failure, missing skill, model error, permission stall, wrong cwd.
    // Without this the subprocess is a black box and a stalled pass looks like
    // "nothing happened". Best-effort; on any filesystem error, fall back to
    // ignoring stdio so the spawn itself still fires.
    const logsDir = path.join(servedRoot, AGENT_LOGS_DIRNAME);
    let logStream = null;
    let logPath = null;
    try {
      fs.mkdirSync(logsDir, { recursive: true });
      logPath = path.join(logsDir, `${entry.id}.log`);
      const header = [
        `# spec-tacle auto-agent log`,
        `# entry:  ${entry.id}`,
        `# spec:   ${entry.specPath}`,
        `# root:   ${servedRoot}`,
        `# server: http://127.0.0.1:${port}`,
        `# spawn:  ${new Date().toISOString()}`,
        `# cmd:    ${cmd}`,
        ''
      ].join('\n');
      fs.writeFileSync(logPath, header, 'utf-8');
      logStream = fs.openSync(logPath, 'a');
    } catch (e) {
      process.stderr.write(`${label} could not open auto-agent log for ${entry.id}: ${e.message}\n`);
    }
    // With parseStreamJson we need stdout on a pipe so the parent can read
    // each JSON event, translate it to a /consistency-progress broadcast,
    // and tee the raw line into the per-entry log file. Without it we keep
    // the original two-fd redirect: stdout and stderr both write into the
    // log directly, unwatched.
    const stdio = parseStreamJson
      ? ['ignore', 'pipe', logStream != null ? logStream : 'ignore']
      : (logStream != null ? ['ignore', logStream, logStream] : 'ignore');
    process.stdout.write(`${label} consistency-pending hook firing for ${entry.id}${logPath ? ` — log ${path.relative(servedRoot, logPath)}` : ''}\n`);
    const child = spawn(process.env.SHELL || '/bin/sh', ['-c', cmd], {
      cwd: servedRoot,
      env,
      stdio,
      detached: true,
    });
    child.on('error', (err) => {
      process.stderr.write(`${label} hook spawn error for ${entry.id}: ${err.message}\n`);
    });
    // Two independent close signals hold the log fd open: the child's exit,
    // and (with parseStreamJson) readline finishing on the piped stdout. We
    // can't close the fd on exit alone because readline may still be
    // draining the last few JSON lines. Close only once BOTH have fired,
    // then run finalizeSpawn — the log tail read for fast-death diagnostics
    // has to happen AFTER the fd is closed so nothing is buffered.
    let childExited = false;
    let readerClosed = !parseStreamJson;
    let finalized = false;
    let exitInfo = null; // { code, signal, durationMs } — set by the exit handler
    function maybeCloseLog() {
      if (!childExited || !readerClosed || finalized) return;
      if (logStream != null) {
        try { fs.closeSync(logStream); } catch (_) { /* not fatal */ }
        logStream = null;
      }
      finalized = true;
      finalizeSpawn();
    }

    function readLogTail(maxLines) {
      if (!logPath) return '';
      try {
        const raw = fs.readFileSync(logPath, 'utf-8');
        // Strip the `# …` header we wrote ourselves so the tail is only
        // subprocess output (shell errors, claude stream-json events).
        const body = raw.split('\n').filter(l => !l.startsWith('#')).join('\n').trim();
        if (!body) return '';
        return body.split('\n').slice(-maxLines).join('\n');
      } catch (_) { return ''; }
    }

    function finalizeSpawn() {
      if (!exitInfo) return;
      const { code, signal, durationMs } = exitInfo;
      const dur = (durationMs / 1000).toFixed(1);
      const how = signal ? `signal ${signal}` : `exit ${code}`;
      const tailPointer = logPath ? ` — tail ${path.relative(servedRoot, logPath)}` : '';
      process.stdout.write(`${label} auto-agent for ${entry.id} finished (${how}, ${dur}s)${tailPointer}\n`);

      const failed = (code != null && code !== 0) || signal != null;
      const fastDeath = failed && durationMs < FAST_DEATH_MS;
      const tail = fastDeath ? readLogTail(10) : '';
      if (fastDeath) {
        const header = `${label} AUTO-AGENT SPAWN FAILED for ${entry.id} — ${how} in ${dur}s. Likely a shell-quoting error in the prompt, a missing \`${process.env.SPEC_TACLE_AGENT_BIN || 'claude'}\` binary, an unrecognized --model, or an immediate auth refusal. Full log: ${logPath || '(disabled)'}`;
        const tailBlock = tail
          ? tail.split('\n').map(l => `${label}   | ${l}`).join('\n') + '\n'
          : `${label}   | (no output captured before exit)\n`;
        process.stderr.write(`${header}\n${tailBlock}`);
      }

      // Stamp spawnError onto the queue entry BEFORE clearing our claim so
      // the release SSE carries the failure reason. Then release, and (on
      // fast death) emit a distinct SSE so the visualizer flips the banner
      // immediately instead of waiting out the 30s handoff timer.
      if (claimedByUs && typeof broadcast === 'function') {
        try {
          let released = false;
          const spawnError = fastDeath ? {
            exitCode: code,
            signal,
            durationMs,
            tail,
            logPath: logPath ? path.relative(servedRoot, logPath) : null,
            firedAt: Date.now(),
          } : null;
          const updated = updateConsistencyEntry(servedRoot, entry.id, (e) => {
            if (e.claim && e.claim.agent === autoAgentLabel) {
              released = true;
              return {
                ...e,
                claim: null,
                progress: null,
                ...(spawnError ? { spawnError } : {}),
              };
            }
            return null;
          });
          if (released && updated) {
            const decorated = decorateEntry(updated, Date.now());
            if (spawnError) {
              broadcast('consistency-spawn-failed', {
                specPath: updated.specPath,
                entryId: updated.id,
                spawnError,
                entry: decorated,
              });
            }
            broadcast('consistency-released', {
              specPath: updated.specPath,
              entryId: updated.id,
              entry: decorated,
            });
          }
        } catch (_) { /* not fatal */ }
      }
    }
    if (parseStreamJson && child.stdout) {
      // Read line-by-line so partial writes from claude -p don't get
      // interpreted as broken JSON. readline handles the buffering.
      const rl = readline.createInterface({ input: child.stdout, terminal: false });
      let toolCount = 0;
      rl.on('line', (line) => {
        // Tee the raw event into the log file so an operator investigating a
        // stalled pass can still `jq` through the full stream.
        if (logStream != null) {
          try { fs.writeSync(logStream, line + '\n'); } catch (_) { /* not fatal */ }
        }
        let ev;
        try { ev = JSON.parse(line); } catch (_) { return; }
        // Increment toolCount only when a tool_use event actually advances
        // the bar; text-only assistant turns and unrecognized shapes return
        // null and shouldn't push the percent forward.
        const isToolUse = ev && ev.type === 'assistant' && ev.message
          && Array.isArray(ev.message.content)
          && ev.message.content.some((b) => b && b.type === 'tool_use');
        const nextCount = isToolUse ? toolCount + 1 : toolCount;
        const progressUpdate = deriveProgressFromStreamJson(ev, nextCount);
        if (!progressUpdate) return;
        toolCount = nextCount;
        const now = Date.now();
        try {
          const updated = updateConsistencyEntry(servedRoot, entry.id, (e) => {
            const claim = e.claim;
            // Only heartbeat if we still hold the claim. If the user (or a
            // manual agent) has taken over, back off — their /consistency-
            // progress calls are authoritative now.
            if (!claim || claim.agent !== autoAgentLabel) return null;
            return {
              ...e,
              claim: { ...claim, claimedAt: now },
              progress: { ...progressUpdate, updatedAt: now },
            };
          });
          if (updated && typeof broadcast === 'function') {
            const decorated = decorateEntry(updated, now);
            broadcast('consistency-progress', {
              specPath: updated.specPath,
              entryId: updated.id,
              agent: updated.claim.agent,
              progress: updated.progress,
              claimExpiresAt: decorated.claimExpiresAt,
              entry: decorated,
            });
          }
        } catch (_) { /* not fatal — next event will retry */ }
      });
      rl.on('close', () => { readerClosed = true; maybeCloseLog(); });
      rl.on('error', () => { readerClosed = true; maybeCloseLog(); });
    }
    // Record exit info and delegate to finalizeSpawn via maybeCloseLog. The
    // exit handler used to duplicate the release-claim logic, but that ran
    // before the log's last bytes had flushed — a fast-death tail read
    // would come back empty. Now finalizeSpawn runs after the fd is closed
    // so the tail is complete.
    const spawnedAt = Date.now();
    child.on('exit', (code, signal) => {
      exitInfo = { code, signal, durationMs: Date.now() - spawnedAt };
      childExited = true;
      maybeCloseLog();
    });
    child.unref();
  };
}

// The default command used when the CLI passes --auto-agent. It spawns
// headless claude-code (`claude -p …`) with a tight prompt that names the
// entry + server + spec so the skill has everything it needs to run the pass.
//
// Deliberately does NOT include --dangerously-skip-permissions. A headless
// subprocess cannot answer permission dialogs, so this default will stall
// silently unless the user has pre-approved the tools it needs in their
// claude settings. The tradeoff (auto-agent works out of the box vs. auto-
// agent runs an unattended agent that can Read/Edit/Write/Bash without
// challenge) is the user's to make: they pass `--on-consistency-pending`
// with their own flags — commonly including `--dangerously-skip-permissions`
// — when they want the auto-run behavior without pre-configuring approvals.
function defaultAutoAgentCommand() {
  const bin = process.env.SPEC_TACLE_AGENT_BIN || 'claude';
  // Default to Haiku for the consistency pass. It's rote reconciliation
  // (read spec, mirror an edit into 1-3 sibling sections, run no-ai-slop),
  // not deep reasoning — Sonnet or Opus costs 3-5x the wall time and
  // credits for no material quality gain, and the user is watching a
  // progress bar. Override with SPEC_TACLE_AGENT_MODEL when a pass needs
  // a bigger model.
  const model = process.env.SPEC_TACLE_AGENT_MODEL || 'claude-haiku-4-5-20251001';
  const prompt = [
    'A spec-tacle consistency pass is pending — run it end to end without stopping to ask.',
    'Invoke the spec-tacle skill.',
    'Entry: {entryId}',
    'Spec path (relative to served root): {specPath}',
    'Served root: {root}',
    'Server: http://127.0.0.1:{port}',
    'CRITICAL: every edit inside a marker-anchored section (any summary:* or diagram:<id>:* block) MUST be POSTed to /consistency-apply. Do NOT use the Edit tool on those blocks — a direct file edit only refreshes the spec drawer; the pending banner stays up, the diagram cards do not hot-reload, and the queue entry never clears. The Edit tool is only for prose OUTSIDE every marker anchor.',
    'Steps: claim the entry, build the edits JSON (same shape as /update-spec plus the entryId), POST it to /consistency-apply via the CLI (npx spec-tacle_skill consistency-apply path/to/edits.json). That is what applies the follow-up, hot-reloads the visualizer, and clears the queue. Then re-sync the data JSON and re-render the HTML.',
    'Progress: the server translates every tool call you make (Read/Edit/Bash/…) into a live progress line in the visualizer banner, so just work naturally — no manual /consistency-progress POSTs needed.',
    'Take best guesses for invented facts and tag them with **Assumption:** in the spec plus an Open Questions bullet — do not stop to ask.',
    'If no related sections need to change, dismiss the entry (POST /consistency-dismiss with the entryId) so the banner clears. If you cannot make a confident set of edits, POST /consistency-release with the entry id and exit. Never exit while the entry is still active — the banner would spin forever.',
  ].join(' ');
  // --output-format stream-json (with --verbose, required) makes the child
  // emit one JSON event per line to stdout: system init, per-tool_use
  // assistant turns, tool_result user turns, final result. The hook parses
  // that stream and pushes /consistency-progress broadcasts as it reads
  // events, so the visualizer banner updates in real time as the sub-agent
  // works — no dependence on the sub-agent to remember to POST progress.
  return `${bin} -p ${JSON.stringify(prompt)} --model ${model} --output-format stream-json --verbose`;
}

function start({ root = '.', port = 8765, portRetries = 10, onListen, onConsistencyPendingCmd, autoAgent } = {}) {
  // Bind both loopback families (127.0.0.1 AND ::1). Binding only IPv4 meant a
  // stale process on IPv6 loopback could shadow us: browsers on modern macOS
  // resolve `localhost` to `::1` first, so they'd hit the other process and
  // 404 while our IPv4 server sat idle.
  const { handler, servedRoot, setConsistencyPendingHook, sseBroadcast } = makeServer({ root, port });
  const server4 = http.createServer(handler);
  const server6 = http.createServer(handler);
  let currentPort = port;
  const maxPort = port + portRetries;
  let v6Skipped = false;
  let bound = false;

  const announceReady = () => {
    if (bound) return;
    bound = true;
    // Wire the auto-agent / consistency-pending hook AFTER bind so it captures
    // the final port (retries above may have bumped it).
    //
    // parseStreamJson only makes sense for the default --auto-agent command,
    // which appends `--output-format stream-json --verbose`. A user's
    // --on-consistency-pending script may print anything (bash noise, its
    // own progress prints, plain claude text output); trying to json-parse
    // its stdout would just silently drop most lines. Fall back to the
    // original "redirect straight to the log file" path for user commands.
    const usingDefaultAutoAgent = !onConsistencyPendingCmd && !!autoAgent;
    const cmdTemplate = onConsistencyPendingCmd
      || (autoAgent ? defaultAutoAgentCommand() : null);
    if (cmdTemplate && typeof setConsistencyPendingHook === 'function') {
      // Provision the auto-agent's pre-approved permissions in the served
      // root before we announce the hook is armed. Without this, the first
      // Update spec spawns a headless subprocess that stalls silently on
      // the first Edit/Bash permission dialog. Idempotent — never
      // overwrites an existing settings.local.json.
      ensureAutoAgentPermissions(servedRoot, { logPrefix: 'spec-tacle:' });
      const hook = makeConsistencyPendingHook({
        commandTemplate: cmdTemplate,
        port: currentPort,
        logPrefix: '[spec-tacle]',
        broadcast: sseBroadcast,
        parseStreamJson: usingDefaultAutoAgent,
      });
      if (hook) {
        setConsistencyPendingHook(hook);
        process.stdout.write(`spec-tacle: consistency-pending hook armed — every Update spec will run:\n  ${cmdTemplate}\n`);
        // Backlog drain: any unclaimed entries already sitting in the queue
        // when the server came up (a prior server died mid-pass; the user
        // added --auto-agent on restart; a bare restart) never fired the
        // hook, so the visualizer would show them as "queued, ping your
        // agent" forever. Fire the hook for each one now, staggered so a
        // burst doesn't spawn every subprocess in the same tick.
        try {
          // Fire the hook for anything without an active claim: unclaimed
          // entries AND entries whose claim's TTL already elapsed (a prior
          // subprocess died mid-work and never released). Skipping the
          // stale-claimed case stranded entries after a crash-restart.
          const drainNow = Date.now();
          const backlog = readConsistencyQueue(servedRoot).entries.filter(e => {
            const c = e.claim;
            if (!c || !Number.isFinite(c.claimedAt) || !Number.isFinite(c.ttlMs)) return true;
            return drainNow >= c.claimedAt + c.ttlMs;
          });
          if (backlog.length) {
            process.stdout.write(`spec-tacle: draining ${backlog.length} queue entr${backlog.length === 1 ? 'y' : 'ies'} from the previous session (unclaimed or claim expired)\n`);
            backlog.forEach((entry, i) => {
              setTimeout(() => {
                // Clear a stale claim so the fresh subprocess can grab it
                // without --force. Best-effort — a stray claim will simply
                // be overwritten by the incoming claim call anyway.
                try {
                  updateConsistencyEntry(servedRoot, entry.id, (e) => ({ ...e, claim: null, progress: null }));
                } catch (_) { /* not fatal */ }
                try { hook(entry, { servedRoot }); }
                catch (e) { process.stderr.write(`[spec-tacle] backlog hook failed for ${entry.id}: ${e.message}\n`); }
              }, i * 1500);
            });
          }
        } catch (e) {
          process.stderr.write(`[spec-tacle] backlog drain skipped: ${e.message}\n`);
        }
      }
    }
    process.stdout.write(`spec-tacle server on http://localhost:${currentPort}\n`);
    process.stdout.write(`serving   ${servedRoot}\n`);
    process.stdout.write(`backups   ${servedRoot}/**/${BACKUPS_DIRNAME}/\n`);
    process.stdout.write('POST /update-spec         { specPath, sections, diagrams }\n');
    process.stdout.write('POST /undo                { specPath }\n');
    process.stdout.write('POST /finalize            { specPath }                                        (strip markers + inventories, delete backups/queue/logs)\n');
    process.stdout.write('POST /consistency-apply    { specPath, sections, diagrams, entryId }  (agent follow-up)\n');
    process.stdout.write('POST /consistency-dismiss  { specPath, entryId }                       (agent drops queue entry)\n');
    process.stdout.write('POST /consistency-claim    { entryId, agent, ttlSeconds? }             (agent stakes a claim)\n');
    process.stdout.write('POST /consistency-progress { entryId, percent?, phase?, note?, agent? }(agent reports progress + heartbeat)\n');
    process.stdout.write('POST /consistency-release  { entryId }                                 (agent drops claim without applying)\n');
    process.stdout.write('GET  /consistency-pending  [?specPath=…]                              (agent reads queue with computed claim state)\n');
    process.stdout.write('GET  /events               SSE — `spec-changed`, `spec-finalized`, `consistency-pending`, `consistency-claimed`, `consistency-progress`, `consistency-released`, `consistency-applied`, `consistency-dismissed`\n');
    if (typeof onListen === 'function') onListen(currentPort);
  };

  const bumpAndRetry = (why) => {
    const next = currentPort + 1;
    process.stdout.write(`spec-tacle: port ${currentPort} in use${why ? ` (${why})` : ''}, trying ${next}\n`);
    currentPort = next;
    setImmediate(bindV4);
  };

  function bindV4() {
    const onErr = (err) => {
      if (err.code === 'EADDRINUSE' && currentPort < maxPort) return bumpAndRetry('IPv4');
      if (err.code === 'EADDRINUSE') console.error(`spec-tacle: no free port in range ${port}-${maxPort} (${err.message})`);
      else console.error(`spec-tacle server error: ${err.message}`);
      process.exit(1);
    };
    server4.once('error', onErr);
    server4.once('listening', () => {
      server4.removeListener('error', onErr);
      bindV6();
    });
    server4.listen(currentPort, '127.0.0.1');
  }

  function bindV6() {
    const onErr = (err) => {
      if (err.code === 'EADDRINUSE' && currentPort < maxPort) {
        // v6 loopback is taken on this port but v4 is ours. Release v4 and try
        // the next port on both families so browsers resolve to a live listener
        // whichever family they prefer.
        server4.close();
        return bumpAndRetry('IPv6');
      }
      // IPv6 loopback genuinely unavailable (system without ::1, sandbox, etc.).
      // Keep IPv4 and warn — most local dev flows still work.
      process.stdout.write(`spec-tacle: IPv6 loopback unavailable (${err.code || err.message}) — serving 127.0.0.1 only\n`);
      v6Skipped = true;
      announceReady();
    };
    server6.once('error', onErr);
    server6.once('listening', () => {
      server6.removeListener('error', onErr);
      announceReady();
    });
    server6.listen(currentPort, '::1');
  }

  bindV4();

  const activeServers = () => v6Skipped ? [server4] : [server4, server6];

  let shuttingDown = false;
  process.on('SIGINT', () => {
    if (shuttingDown) {
      process.stdout.write('\nforce exit\n');
      process.exit(1);
    }
    shuttingDown = true;
    process.stdout.write('\nshutting down (Ctrl+C again to force)\n');
    for (const s of activeServers()) {
      if (typeof s.closeIdleConnections === 'function') s.closeIdleConnections();
      s.close();
    }
    // Browsers hold keep-alive sockets open; drop them after a short grace period.
    setTimeout(() => {
      for (const s of activeServers()) {
        if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
      }
      setTimeout(() => process.exit(0), 200).unref();
    }, 500).unref();
  });

  return {
    close(cb) {
      const servers = activeServers();
      let pending = servers.length;
      if (!pending) return cb && cb();
      const done = () => { if (--pending === 0 && cb) cb(); };
      for (const s of servers) s.close(done);
    },
  };
}

module.exports = {
  start, makeServer, applyUpdates, replaceBetweenMarkers,
  buildDiagramBlock, buildInventory,
  parseFlowchart, parseStateDiagram, parseSequenceDiagram,
  readConsistencyQueue, writeConsistencyQueue, extractMarkerContent,
  ensureAutoAgentPermissions, AUTO_AGENT_SETTINGS_TEMPLATE,
  ensureUserLevelPermissions, USER_LEVEL_PERMISSIONS,
  CONSISTENCY_QUEUE_FILENAME,
  deriveProgressFromStreamJson,
  stripSpecTacleArtifacts,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') args.port = parseInt(argv[++i], 10);
    else if (argv[i] === '--root') args.root = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') {
      process.stdout.write('Usage: node serve.js [--port N] [--root DIR]\n');
      process.exit(0);
    }
  }
  start(args);
}
