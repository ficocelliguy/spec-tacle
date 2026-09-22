// spec-tacle round-trip server.
//
// Serves static files under --root and accepts two POST endpoints:
//   POST /update-spec { specPath, sections, diagrams }
//   POST /undo        { specPath }
//
// Sections are rewritten between <!-- spec-tacle:<name> --> markers. Diagrams
// keys are the diagram id; their value replaces the ```mermaid``` fenced block
// inside the diagram-id marker section. Every update writes a timestamped
// backup of the spec into a `backups/` folder next to the spec.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const BACKUPS_DIRNAME = 'backups';

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
  for (const [name, mermaidSource] of Object.entries(diagrams)) {
    const wrapped = '```mermaid\n' + mermaidSource + '\n```';
    const r = replaceBetweenMarkers(text, `diagram:${name}`, wrapped);
    text = r.text;
    if (r.created) created.push(`diagram:${name}`);
  }
  return { text, created };
}

function makeServer({ root, port }) {
  const servedRoot = path.resolve(root);

  function resolveSpec(rawPath) {
    const abs = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(servedRoot, rawPath);
    if (abs !== servedRoot && !abs.startsWith(servedRoot + path.sep)) {
      throw Object.assign(new Error(`spec path ${abs} is outside served root ${servedRoot}`), { code: 'EACCES' });
    }
    return abs;
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

  async function handleUpdate(req, res) {
    try {
      const payload = await readJson(req);
      const specPath = resolveSpec(payload.specPath || '');
      if (!fs.existsSync(specPath)) {
        return sendJson(res, 404, { ok: false, error: `spec not found: ${specPath}` });
      }
      const original = fs.readFileSync(specPath, 'utf-8');
      const { text: updated, created } = applyUpdates(original, payload);
      if (updated === original) {
        return sendJson(res, 200, { ok: true, changed: false, message: 'no edits to apply', created });
      }
      const backupDir = path.join(path.dirname(specPath), BACKUPS_DIRNAME);
      fs.mkdirSync(backupDir, { recursive: true });
      const stem = path.basename(specPath, path.extname(specPath));
      const backupPath = uniqueBackupPath(backupDir, stem, path.extname(specPath));
      fs.writeFileSync(backupPath, original, 'utf-8');
      fs.writeFileSync(specPath, updated, 'utf-8');
      sendJson(res, 200, {
        ok: true,
        changed: true,
        backup: path.relative(servedRoot, backupPath),
        specPath: path.relative(servedRoot, specPath),
        created,
      });
    } catch (err) {
      const code = err.code === 'EACCES' ? 403 : 500;
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
    if (req.method === 'POST' && req.url === '/update-spec') return handleUpdate(req, res);
    if (req.method === 'POST' && req.url === '/undo')        return handleUndo(req, res);
    if (req.method === 'GET' || req.method === 'HEAD')       return serveStatic(req, res);
    res.writeHead(405); res.end('Method Not Allowed');
  };

  const server = http.createServer(handler);
  return { server, handler, port, servedRoot };
}

function start({ root = '.', port = 8765, portRetries = 10, onListen } = {}) {
  // Bind both loopback families (127.0.0.1 AND ::1). Binding only IPv4 meant a
  // stale process on IPv6 loopback could shadow us: browsers on modern macOS
  // resolve `localhost` to `::1` first, so they'd hit the other process and
  // 404 while our IPv4 server sat idle.
  const { handler, servedRoot } = makeServer({ root, port });
  const server4 = http.createServer(handler);
  const server6 = http.createServer(handler);
  let currentPort = port;
  const maxPort = port + portRetries;
  let v6Skipped = false;
  let bound = false;

  const announceReady = () => {
    if (bound) return;
    bound = true;
    process.stdout.write(`spec-tacle server on http://localhost:${currentPort}\n`);
    process.stdout.write(`serving   ${servedRoot}\n`);
    process.stdout.write(`backups   ${servedRoot}/**/${BACKUPS_DIRNAME}/\n`);
    process.stdout.write('POST /update-spec  { specPath, sections, diagrams }\n');
    process.stdout.write('POST /undo         { specPath }\n');
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

module.exports = { start, makeServer, applyUpdates, replaceBetweenMarkers };

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
