#!/usr/bin/env node
/*
 * spec-tacle CLI.
 *
 * Commands:
 *   spec-tacle_skill render <data.json> [output.html]  Render a data JSON to HTML
 *   spec-tacle_skill serve [--port N] [--root DIR]     Start the round-trip server
 *   spec-tacle_skill skill                             Print the skill instructions
 *   spec-tacle_skill install [--dir PATH]              Install or update SKILL.md in a skills dir
 *   spec-tacle_skill example [dir]                     Copy the example spec + data JSON to a dir
 *   spec-tacle_skill demo                              Copy the example into ./spec-tacle-demo and serve it with --auto-agent
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, 'lib');
const TEMPLATE = path.join(LIB, 'template.html');
const RENDER_MOD = path.join(LIB, 'render.js');
const SERVE_MOD = path.join(LIB, 'serve.js');
const AGENTS_MOD = path.join(LIB, 'agents.js');
const SKILL_MD = path.join(ROOT, 'skill', 'SKILL.md');
const EXAMPLE_DIR = path.join(ROOT, 'example');

const { render } = require(RENDER_MOD);
const { start: startServer, readConsistencyQueue, CONSISTENCY_QUEUE_FILENAME } = require(SERVE_MOD);

function usage() {
  process.stdout.write([
    'spec-tacle — turn a spec into an editable HTML visualizer',
    '',
    'Usage:',
    '  npx spec-tacle_skill render <data.json> [output.html]',
    '      Render a data JSON into an HTML visualizer.',
    '      Output defaults to <data-basename>-visualizer.html next to the input.',
    '',
    '  npx spec-tacle_skill serve [--port N] [--root DIR] [--open PATH] [--no-open] [--auto-agent [--agent claude|codex] | --on-consistency-pending CMD]',
    '      Start the round-trip server and open the root in your browser.',
    '      Root defaults to the current directory. Pass --open PATH to open a',
    '      specific file instead of the root, or --no-open to skip opening.',
    '      --auto-agent arms a hook that spawns a headless agent after every',
    '      Update spec, so the consistency pass runs without the user having to',
    '      ping their agent. --agent picks the CLI (`claude -p` or `codex',
    '      exec`); without it the server uses the agent it was started from,',
    '      then whichever of claude / codex is on PATH. $SPEC_TACLE_AGENT and',
    '      $SPEC_TACLE_AGENT_BIN do the same from the environment, and',
    '      $SPEC_TACLE_AGENT_MODEL overrides the model. For any other agent CLI,',
    '      --on-consistency-pending CMD runs your own shell string instead;',
    '      placeholders {prompt}, {entryId}, {specPath}, {root}, {port} are',
    '      shell-quoted before substitution ({prompt} is the full',
    '      consistency-pass prompt), e.g. `gemini -p {prompt} --yolo`. The child',
    '      also inherits $SPEC_TACLE_ENTRY_ID, $SPEC_TACLE_SPEC_PATH,',
    '      $SPEC_TACLE_SERVED_ROOT, $SPEC_TACLE_PORT.',
    '',
    '  npx spec-tacle_skill consistency-check [--root DIR] [--spec PATH] [--json]',
    '      List pending consistency-pass entries the server queued after each',
    '      Update spec. Every entry names the sections and diagrams that just',
    '      changed with their before/after content — hand this to a reasoning',
    '      agent to propose related edits to the summary, other diagrams, or',
    '      the plain-prose part of the spec. Default output is human-readable;',
    '      --json prints the raw queue for scripting.',
    '',
    '  npx spec-tacle_skill consistency-apply <edits.json> [--port N] [--host HOST]',
    '      POST a set of follow-up edits to a running server. The JSON payload',
    '      shape matches /update-spec plus an entryId that clears the queue:',
    '        { "specPath": "…", "entryId": "…", "sections": { … }, "diagrams": { … } }',
    '      The server writes the edits, backs the file up, and broadcasts a',
    '      consistency-applied SSE so the visualizer highlights the auto-updated',
    '      lines in a distinct color and hot-reloads the affected summary and',
    '      diagram cards without a full page reload.',
    '',
    '  npx spec-tacle_skill consistency-claim <entryId> [--agent NAME] [--ttl SECONDS] [--force] [--port N]',
    '      Stake a claim on a pending queue entry so the visualizer shows "an',
    '      agent is on it" instead of the unclaimed "ping your agent" state.',
    '      Refuses (409) if another agent already holds an unexpired claim,',
    '      unless --force is passed. Default TTL 300s; renew by re-claiming or',
    '      by sending a progress heartbeat.',
    '',
    '  npx spec-tacle_skill consistency-progress <entryId> --percent N [--phase LABEL] [--note TEXT] [--agent NAME] [--port N]',
    '      Report progress on a claimed entry and heartbeat the claim TTL. The',
    '      visualizer paints a progress bar at N% with the phase and note; the',
    '      claim expiry rolls forward from the moment the server receives this.',
    '',
    '  npx spec-tacle_skill consistency-release <entryId> [--port N]',
    '      Drop a claim without applying any edits — the entry stays in the',
    '      queue for another agent to pick up.',
    '',
    '  npx spec-tacle_skill demo [--agent claude|codex] [--port N] [--no-open]',
    '      Copy the bundled Tasky example (spec, data JSON, visualizer) into a',
    '      new ./spec-tacle-demo folder (numbered if that name is taken), then',
    '      start the round-trip server with --auto-agent and open the',
    '      visualizer. Every Update spec writes into that folder\'s',
    '      example-spec.md and spawns a headless agent for the consistency',
    '      pass. Needs Claude Code or Codex on PATH for the agent half.',
    ''
  ].join('\n'));
}

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function argFlag(args, name) {
  const i = args.indexOf(name);
  return i < 0 ? null : args[i + 1];
}

function hasFlag(args, name) {
  return args.indexOf(name) >= 0;
}

function openInBrowser(url) {
  let cmd, cmdArgs;
  if (process.platform === 'darwin')      { cmd = 'open';     cmdArgs = [url]; }
  else if (process.platform === 'win32')  { cmd = 'cmd';      cmdArgs = ['/c', 'start', '""', url]; }
  else                                    { cmd = 'xdg-open'; cmdArgs = [url]; }
  try {
    const child = spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' });
    child.on('error', () => {}); // no browser opener available — stay silent
    child.unref();
  } catch (_) { /* ignored */ }
}

function cmdRender(args) {
  if (!args.length) {
    console.error('Usage: spec-tacle_skill render <data.json> [output.html]');
    process.exit(1);
  }
  const dataJson = path.resolve(args[0]);
  if (!fs.existsSync(dataJson)) {
    console.error(`spec-tacle: data file not found: ${dataJson}`);
    process.exit(1);
  }
  let outHtml = args[1] ? path.resolve(args[1]) : null;
  if (!outHtml) {
    const base = path.basename(dataJson, path.extname(dataJson)).replace(/-data$/, '');
    outHtml = path.join(path.dirname(dataJson), `${base}-visualizer.html`);
  }
  try {
    render(TEMPLATE, dataJson, outHtml);
    process.stdout.write(`Wrote ${outHtml}\n`);
  } catch (err) {
    console.error(`render error: ${err.message}`);
    process.exit(2);
  }
}

function parsePortArg(args, defaultPort) {
  const i = args.indexOf('--port');
  if (i < 0) return defaultPort;
  const raw = args[i + 1];
  // Reject bare --port and --port --other-flag: both leave us with no value,
  // and the fallback parseInt(undefined) would silently listen on a random port
  // that doesn't match the URL we print for the user.
  if (raw == null || raw.startsWith('--')) {
    console.error(`spec-tacle: --port needs an integer between 1 and 65535`);
    process.exit(1);
  }
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535 || String(n) !== String(raw).trim()) {
    console.error(`spec-tacle: --port needs an integer between 1 and 65535 (got "${raw}")`);
    process.exit(1);
  }
  return n;
}

function cmdServe(args) {
  const port = parsePortArg(args, 8765);
  const root = argFlag(args, '--root') || process.cwd();
  const noOpen = hasFlag(args, '--no-open');
  const openArg = argFlag(args, '--open');
  // Treat --open PATH as a specific path to open; bare --open (or none) means root.
  const rel = openArg && !openArg.startsWith('--') ? openArg.replace(/^\/+/, '') : '';
  const autoAgent = hasFlag(args, '--auto-agent');
  const onConsistencyPendingCmd = argFlag(args, '--on-consistency-pending');
  const agent = argFlag(args, '--agent');
  startServer({
    root: path.resolve(root),
    port,
    autoAgent,
    agent,
    onConsistencyPendingCmd,
    onListen: (actualPort) => {
      const url = `http://localhost:${actualPort}/${rel}`;
      console.log('');
      if (noOpen) console.log(`spec-tacle: open ${url}`);
      else        console.log(`spec-tacle: opening ${url}`);
      if (!noOpen) openInBrowser(url);
    },
  });
}

function cmdSkill() {
  process.stdout.write(fs.readFileSync(SKILL_MD, 'utf-8'));
}

function cmdInstallSkill(args) {
  const dirFlag = argFlag(args, '--dir');
  const skipUserPerms = hasFlag(args, '--skip-user-perms');
  // --dir points at one target and skips the multi-editor default.
  // Otherwise install into ~/.claude/skills (always) and the shared
  // ~/.agents/skills when an agent that reads only that folder is installed.
  const { skillInstallTargets, legacySkillFiles, ensureOtherAgentsUserPermissions } = require(AGENTS_MOD);
  const targets = dirFlag
    ? [{ dir: path.resolve(dirFlag), agents: [] }]
    : skillInstallTargets();

  // Remove copies earlier versions wrote to folders current agents no longer
  // read, so the skill doesn't show up twice in an editor's skill listing.
  if (!dirFlag) {
    for (const legacy of legacySkillFiles()) {
      if (!fs.existsSync(legacy)) continue;
      try { fs.rmSync(legacy); } catch (_) { /* best-effort */ }
      try { fs.rmdirSync(path.dirname(legacy)); } catch (_) { /* keep parent if not empty */ }
      console.log(`Removed legacy skill install at ${legacy}`);
    }
  }

  // Always overwrite: re-running install is how users pick up a newer
  // SKILL.md. --force is still accepted (and ignored) for older instructions.
  for (const { dir, agents } of targets) {
    const targetFile = path.join(dir, 'SKILL.md');
    const existed = fs.existsSync(targetFile);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(SKILL_MD, targetFile);
    const forWhom = agents.length ? ` (${agents.join(', ')})` : '';
    console.log(`${existed ? 'Updated' : 'Installed'} skill at ${targetFile}${forWhom}`);
  }

  // Also pre-approve the spec-tacle CLI for each installed agent: Claude via
  // ~/.claude/settings.json, the rest via their own config formats (see
  // lib/agents.js). Deliberately does NOT grant Read/Edit/Write globs —
  // those stay per-project and install on first `serve --auto-agent`.
  // Idempotent; skipped only with --skip-user-perms.
  if (!skipUserPerms) {
    const { ensureUserLevelPermissions } = require(SERVE_MOD);
    ensureUserLevelPermissions({ logPrefix: 'spec-tacle_skill:' });
    ensureOtherAgentsUserPermissions({ logPrefix: 'spec-tacle_skill:' });
  } else {
    console.log('spec-tacle_skill: skipped user-level permissions (--skip-user-perms). Your agent will prompt before running `npx spec-tacle_skill …`.');
  }

  console.log('Restart your editor session, then try: "spec-tacle <path-to-spec.md>"');
}

function cmdExample(args) {
  const targetDir = args[0] ? path.resolve(args[0]) : process.cwd();
  fs.mkdirSync(targetDir, { recursive: true });
  // Only copy plain files at the top level. The bundled example may have
  // subdirs (like .claude/ or backups/) that don't belong in a fresh copy —
  // .claude/settings.local.json is installed on demand by `serve --auto-agent`
  // anyway, and backups are per-session artifacts.
  const files = fs.readdirSync(EXAMPLE_DIR).filter(f => {
    try { return fs.statSync(path.join(EXAMPLE_DIR, f)).isFile(); }
    catch (_) { return false; }
  });
  const conflicts = files.filter(f => fs.existsSync(path.join(targetDir, f)));
  if (conflicts.length) {
    console.error(`spec-tacle: refusing to overwrite existing file(s) in ${targetDir}:`);
    for (const f of conflicts) console.error(`  ${f}`);
    process.exit(1);
  }
  for (const f of files) {
    fs.copyFileSync(path.join(EXAMPLE_DIR, f), path.join(targetDir, f));
    console.log(`Copied ${f}`);
  }
  console.log('');
  console.log('Next steps:');
  console.log(`  cd ${path.relative(process.cwd(), targetDir) || '.'}`);
  console.log('  npx spec-tacle_skill render example-data.json');
  console.log('  npx spec-tacle_skill serve --auto-agent  # writes .claude/settings.local.json on first run');
  console.log('  open http://localhost:8765/example-visualizer.html');
}

function cmdInstallPerms(args) {
  const { ensureAutoAgentPermissions } = require(SERVE_MOD);
  const targetDir = argFlag(args, '--dir') ? path.resolve(argFlag(args, '--dir')) : process.cwd();
  const result = ensureAutoAgentPermissions(targetDir, { logPrefix: 'spec-tacle_skill:' });
  process.exit(result.action === 'skipped' ? 2 : 0);
}

function cmdDemo(args) {
  // Copy the example into a fresh folder so the user's edits survive the
  // demo: they can keep hacking on the spec, commit it, or delete it. Never
  // overwrite; take the first free spec-tacle-demo[-N] name.
  const cwd = process.cwd();
  let dirName = 'spec-tacle-demo';
  for (let n = 1; fs.existsSync(path.join(cwd, dirName)); n++) dirName = `spec-tacle-demo-${n}`;
  const demoDir = path.join(cwd, dirName);
  fs.mkdirSync(demoDir, { recursive: true });

  const specName = 'example-spec.md';
  const dataName = 'example-data.json';
  const htmlName = 'example-visualizer.html';
  copyFile(path.join(EXAMPLE_DIR, specName), path.join(demoDir, specName));
  // The bundled data JSON names the spec relative to the repo root
  // (example/example-spec.md). Point it at the copy next to it, then
  // re-render so the visualizer posts edits to the right file.
  const data = JSON.parse(fs.readFileSync(path.join(EXAMPLE_DIR, dataName), 'utf-8'));
  data.specPath = specName;
  fs.writeFileSync(path.join(demoDir, dataName), JSON.stringify(data, null, 2) + '\n', 'utf-8');
  try {
    render(TEMPLATE, path.join(demoDir, dataName), path.join(demoDir, htmlName));
  } catch (err) {
    console.error(`spec-tacle: render error: ${err.message}`);
    process.exit(2);
  }
  console.log(`spec-tacle: copied the Tasky example to ./${dirName}/`);
  console.log(`spec-tacle: Update spec writes into ./${dirName}/${specName}. Stop the server with Ctrl-C; the folder stays.`);
  console.log('');

  const port = parsePortArg(args, 8765);
  const noOpen = hasFlag(args, '--no-open');
  startServer({
    root: demoDir,
    port,
    autoAgent: true,
    agent: argFlag(args, '--agent'),
    onListen: (actualPort) => {
      const url = `http://localhost:${actualPort}/${htmlName}`;
      console.log('');
      console.log(`spec-tacle: ${noOpen ? 'open' : 'opening'} ${url}`);
      if (!noOpen) openInBrowser(url);
    },
  });
}

function cmdConsistencyCheck(args) {
  const root = path.resolve(argFlag(args, '--root') || process.cwd());
  const specFilter = argFlag(args, '--spec');
  const asJson = hasFlag(args, '--json');
  const queuePath = path.join(root, CONSISTENCY_QUEUE_FILENAME);
  const queue = readConsistencyQueue(root);
  let entries = queue.entries || [];
  if (specFilter) entries = entries.filter(e => e.specPath === specFilter);
  if (asJson) {
    process.stdout.write(JSON.stringify({ ok: true, root, queuePath, entries }, null, 2) + '\n');
    return;
  }
  if (!entries.length) {
    console.log(`spec-tacle: no pending consistency-pass entries at ${queuePath}`);
    return;
  }
  console.log(`spec-tacle: ${entries.length} pending consistency-pass entr${entries.length === 1 ? 'y' : 'ies'} (queue: ${queuePath})`);
  for (const e of entries) {
    console.log('');
    console.log(`  entry ${e.id}`);
    console.log(`    spec:     ${e.specPath}`);
    console.log(`    backup:   ${e.backup}`);
    console.log(`    changed:  ${new Date(e.changedAt).toISOString()}`);
    if (e.sections && e.sections.length) {
      console.log(`    sections: ${e.sections.map(s => s.name).join(', ')}`);
    }
    if (e.diagrams && e.diagrams.length) {
      console.log(`    diagrams: ${e.diagrams.map(d => d.id).join(', ')}`);
    }
  }
  console.log('');
  console.log('Reason over each entry, then POST the follow-up edits with:');
  console.log('  npx spec-tacle_skill consistency-apply <edits.json>');
}

function cmdConsistencyApply(args) {
  const positional = args.filter(a => !a.startsWith('--'));
  const editsPath = positional[0];
  if (!editsPath) {
    console.error('Usage: spec-tacle_skill consistency-apply <edits.json> [--port N] [--host HOST]');
    process.exit(1);
  }
  const abs = path.resolve(editsPath);
  if (!fs.existsSync(abs)) {
    console.error(`spec-tacle: edits file not found: ${abs}`);
    process.exit(1);
  }
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(abs, 'utf-8'));
  } catch (err) {
    console.error(`spec-tacle: could not parse ${abs}: ${err.message}`);
    process.exit(1);
  }
  postToServer(args, '/consistency-apply', payload);
}

function cmdConsistencyClaim(args) {
  const positional = args.filter(a => !a.startsWith('--'));
  const entryId = positional[0];
  if (!entryId) {
    console.error('Usage: spec-tacle_skill consistency-claim <entryId> [--agent NAME] [--ttl SECONDS] [--force] [--port N] [--host HOST]');
    process.exit(1);
  }
  const agent = argFlag(args, '--agent') || defaultAgentLabel();
  const ttlRaw = argFlag(args, '--ttl');
  const payload = { entryId, agent };
  if (ttlRaw != null) {
    const n = Number(ttlRaw);
    if (!Number.isFinite(n) || n <= 0) {
      console.error('spec-tacle: --ttl must be a positive number of seconds');
      process.exit(1);
    }
    payload.ttlSeconds = n;
  }
  if (args.includes('--force')) payload.force = true;
  postToServer(args, '/consistency-claim', payload);
}

function cmdConsistencyProgress(args) {
  const positional = args.filter(a => !a.startsWith('--'));
  const entryId = positional[0];
  if (!entryId) {
    console.error('Usage: spec-tacle_skill consistency-progress <entryId> --percent N [--phase LABEL] [--note TEXT] [--agent NAME] [--port N] [--host HOST]');
    process.exit(1);
  }
  const percentRaw = argFlag(args, '--percent');
  if (percentRaw == null) {
    console.error('spec-tacle: --percent is required');
    process.exit(1);
  }
  const percent = Number(percentRaw);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    console.error('spec-tacle: --percent must be between 0 and 100');
    process.exit(1);
  }
  const payload = { entryId, percent };
  const phase = argFlag(args, '--phase');
  const note = argFlag(args, '--note');
  const agent = argFlag(args, '--agent') || defaultAgentLabel();
  if (phase != null) payload.phase = phase;
  if (note != null) payload.note = note;
  if (agent != null) payload.agent = agent;
  postToServer(args, '/consistency-progress', payload);
}

function cmdConsistencyRelease(args) {
  const positional = args.filter(a => !a.startsWith('--'));
  const entryId = positional[0];
  if (!entryId) {
    console.error('Usage: spec-tacle_skill consistency-release <entryId> [--port N] [--host HOST]');
    process.exit(1);
  }
  postToServer(args, '/consistency-release', { entryId });
}

function defaultAgentLabel() {
  const sess = process.env.CLAUDE_SESSION_ID || process.env.SESSION_ID;
  if (sess) return `claude-code:${String(sess).slice(0, 24)}`;
  return `claude-code:${process.pid}`;
}

function postToServer(args, endpoint, payload) {
  const port = parsePortArg(args, 8765);
  const host = argFlag(args, '--host') || '127.0.0.1';
  const http = require('http');
  const body = Buffer.from(JSON.stringify(payload), 'utf-8');
  const req = http.request({
    host, port, method: 'POST', path: endpoint,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(body.length),
    },
  }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8');
      let parsed;
      try { parsed = JSON.parse(text); } catch (_) { parsed = { raw: text }; }
      process.stdout.write(JSON.stringify(parsed, null, 2) + '\n');
      process.exit(res.statusCode >= 400 || parsed.ok === false ? 2 : 0);
    });
  });
  req.on('error', (err) => {
    console.error(`spec-tacle: request to http://${host}:${port}${endpoint} failed: ${err.message}`);
    console.error(`spec-tacle: is \`npx spec-tacle_skill serve\` running on that port?`);
    process.exit(1);
  });
  req.write(body);
  req.end();
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') { usage(); process.exit(0); }
  if (cmd === '-v' || cmd === '--version') {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
    console.log(pkg.version);
    process.exit(0);
  }
  switch (cmd) {
    case 'render':              return cmdRender(rest);
    case 'serve':               return cmdServe(rest);
    case 'skill':               return cmdSkill();
    case 'install':             return cmdInstallSkill(rest);
    case 'example':             return cmdExample(rest);
    case 'demo':                return cmdDemo(rest);
    case 'install-perms':        return cmdInstallPerms(rest);
    case 'consistency-check':    return cmdConsistencyCheck(rest);
    case 'consistency-apply':    return cmdConsistencyApply(rest);
    case 'consistency-claim':    return cmdConsistencyClaim(rest);
    case 'consistency-progress': return cmdConsistencyProgress(rest);
    case 'consistency-release':  return cmdConsistencyRelease(rest);
    default:
      console.error(`spec-tacle: unknown command "${cmd}"\n`);
      usage();
      process.exit(1);
  }
}

main();
