// spec-tacle round-trip server (Node port of serve.py).
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

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceBetweenMarkers(text, name, newContent) {
  const start = `<!-- spec-tacle:${name} -->`;
  const end = `<!-- /spec-tacle:${name} -->`;
  const pattern = new RegExp(escapeRegex(start) + '([\\s\\S]*?)' + escapeRegex(end));
  const replacement = `${start}\n${newContent}\n${end}`;
  if (pattern.test(text)) {
    return text.replace(pattern, () => replacement);
  }
  const trail = text.endsWith('\n') ? '' : '\n';
  return `${text}${trail}\n${replacement}\n`;
}

function applyUpdates(original, payload) {
  let text = original;
  const sections = payload.sections || {};
  for (const [name, newContent] of Object.entries(sections)) {
    text = replaceBetweenMarkers(text, name, newContent);
  }
  const diagrams = payload.diagrams || {};
  for (const [name, mermaidSource] of Object.entries(diagrams)) {
    const wrapped = '```mermaid\n' + mermaidSource + '\n```';
    text = replaceBetweenMarkers(text, `diagram:${name}`, wrapped);
  }
  return text;
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
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.end(body);
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
    let rel = decodeURIComponent(url.replace(/^\/+/, ''));
    if (!rel) rel = 'index.html';
    const abs = path.resolve(servedRoot, rel);
    if (abs !== servedRoot && !abs.startsWith(servedRoot + path.sep)) {
      res.writeHead(403); res.end('Forbidden');
      return;
    }
    fs.stat(abs, (err, stat) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      let target = abs;
      if (stat.isDirectory()) {
        target = path.join(abs, 'index.html');
        if (!fs.existsSync(target)) {
          // Simple directory listing
          const items = fs.readdirSync(abs).sort();
          const html = `<!doctype html><meta charset="utf-8"><title>${rel || '/'}</title>` +
            `<h1>Index of /${rel}</h1><ul>` +
            items.map(n => `<li><a href="${encodeURIComponent(n)}${fs.statSync(path.join(abs, n)).isDirectory() ? '/' : ''}">${n}</a></li>`).join('') +
            `</ul>`;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
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
          'Access-Control-Allow-Origin': '*',
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
      const updated = applyUpdates(original, payload);
      if (updated === original) {
        return sendJson(res, 200, { ok: true, changed: false, message: 'no edits to apply' });
      }
      const backupDir = path.join(path.dirname(specPath), BACKUPS_DIRNAME);
      fs.mkdirSync(backupDir, { recursive: true });
      const stem = path.basename(specPath, path.extname(specPath));
      const backupPath = path.join(backupDir, `${stem}-${timestamp()}${path.extname(specPath)}`);
      fs.writeFileSync(backupPath, original, 'utf-8');
      fs.writeFileSync(specPath, updated, 'utf-8');
      sendJson(res, 200, {
        ok: true,
        changed: true,
        backup: path.relative(servedRoot, backupPath),
        specPath: path.relative(servedRoot, specPath),
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
      const stem = path.basename(specPath, path.extname(specPath));
      const candidates = fs.readdirSync(backupDir)
        .filter(f => f.startsWith(stem + '-'))
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

  const server = http.createServer((req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }
    if (req.method === 'POST' && req.url === '/update-spec') return handleUpdate(req, res);
    if (req.method === 'POST' && req.url === '/undo')        return handleUndo(req, res);
    if (req.method === 'GET' || req.method === 'HEAD')       return serveStatic(req, res);
    res.writeHead(405); res.end('Method Not Allowed');
  });

  return { server, port, servedRoot };
}

function start({ root = '.', port = 8765, portRetries = 10, onListen } = {}) {
  const { server, servedRoot } = makeServer({ root, port });
  let currentPort = port;
  const maxPort = port + portRetries;

  const onListenError = (err) => {
    if (err.code === 'EADDRINUSE' && currentPort < maxPort) {
      const next = currentPort + 1;
      process.stdout.write(`spec-tacle: port ${currentPort} in use, trying ${next}\n`);
      currentPort = next;
      server.once('error', onListenError);
      setImmediate(() => server.listen(currentPort));
      return;
    }
    if (err.code === 'EADDRINUSE') {
      console.error(`spec-tacle: no free port in range ${port}-${maxPort} (${err.message})`);
    } else {
      console.error(`spec-tacle server error: ${err.message}`);
    }
    process.exit(1);
  };

  server.once('error', onListenError);
  server.once('listening', () => {
    server.removeListener('error', onListenError);
    process.stdout.write(`spec-tacle server on http://localhost:${currentPort}\n`);
    process.stdout.write(`serving   ${servedRoot}\n`);
    process.stdout.write(`backups   ${servedRoot}/**/${BACKUPS_DIRNAME}/\n`);
    process.stdout.write('POST /update-spec  { specPath, sections, diagrams }\n');
    process.stdout.write('POST /undo         { specPath }\n');
    if (typeof onListen === 'function') onListen(currentPort);
  });

  server.listen(currentPort);

  let shuttingDown = false;
  process.on('SIGINT', () => {
    if (shuttingDown) {
      process.stdout.write('\nforce exit\n');
      process.exit(1);
    }
    shuttingDown = true;
    process.stdout.write('\nshutting down (Ctrl+C again to force)\n');
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    server.close(() => process.exit(0));
    // Browsers hold keep-alive sockets open; drop them after a short grace period.
    setTimeout(() => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      setTimeout(() => process.exit(0), 200).unref();
    }, 500).unref();
  });

  return server;
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
