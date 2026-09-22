#!/usr/bin/env node
/*
 * spec-tacle CLI. Pure Node — no Python dependency.
 *
 * Commands:
 *   spec-tacle render <data.json> [output.html]     Render a data JSON to HTML
 *   spec-tacle serve [--port N] [--root DIR]        Start the round-trip server
 *   spec-tacle skill                                 Print the skill instructions
 *   spec-tacle example [dir]                         Copy the example spec + data JSON to a dir
 *   spec-tacle demo [--port N]                       Render the bundled example and start the server
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
const SKILL_MD = path.join(ROOT, 'skill', 'SKILL.md');
const EXAMPLE_DIR = path.join(ROOT, 'example');

const { render } = require(RENDER_MOD);
const { start: startServer } = require(SERVE_MOD);

function usage() {
  process.stdout.write([
    'spec-tacle — turn a spec into an editable HTML visualizer',
    '',
    'Usage:',
    '  npx spec-tacle render <data.json> [output.html]',
    '      Render a data JSON into an HTML visualizer.',
    '      Output defaults to <data-basename>-visualizer.html next to the input.',
    '',
    '  npx spec-tacle serve [--port N] [--root DIR] [--open PATH] [--no-open]',
    '      Start the round-trip server and open the root in your browser.',
    '      Root defaults to the current directory. Pass --open PATH to open a',
    '      specific file instead of the root, or --no-open to skip opening.',
    '',
    '  npx spec-tacle skill',
    '      Print the skill instructions (for use with Claude or other AI editors).',
    '',
    '  npx spec-tacle example [dir]',
    '      Copy the bundled example spec + data JSON into <dir> (default: cwd).',
    '',
    '  npx spec-tacle demo [--port N] [--no-open]',
    '      Copy the example into a temp dir, render it, start the server, and',
    '      open the visualizer in your browser. Pass --no-open to skip opening.',
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
    console.error('Usage: spec-tacle render <data.json> [output.html]');
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

function cmdServe(args) {
  const portArg = argFlag(args, '--port');
  const port = portArg ? parseInt(portArg, 10) : 8765;
  const root = argFlag(args, '--root') || process.cwd();
  const noOpen = hasFlag(args, '--no-open');
  const openArg = argFlag(args, '--open');
  // Treat --open PATH as a specific path to open; bare --open (or none) means root.
  const rel = openArg && !openArg.startsWith('--') ? openArg.replace(/^\/+/, '') : '';
  startServer({
    root: path.resolve(root),
    port,
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

function cmdExample(args) {
  const targetDir = args[0] ? path.resolve(args[0]) : process.cwd();
  fs.mkdirSync(targetDir, { recursive: true });
  for (const f of fs.readdirSync(EXAMPLE_DIR)) {
    const src = path.join(EXAMPLE_DIR, f);
    const dst = path.join(targetDir, f);
    if (fs.existsSync(dst)) {
      console.error(`spec-tacle: refusing to overwrite existing file: ${dst}`);
      process.exit(1);
    }
    fs.copyFileSync(src, dst);
    console.log(`Copied ${f}`);
  }
  console.log('');
  console.log('Next steps:');
  console.log(`  cd ${path.relative(process.cwd(), targetDir) || '.'}`);
  console.log('  npx spec-tacle render example-data.json');
  console.log('  npx spec-tacle serve');
  console.log('  open http://localhost:8765/example-visualizer.html');
}

function cmdDemo(args) {
  const portArg = argFlag(args, '--port');
  const port = portArg ? parseInt(portArg, 10) : 8765;
  const noOpen = hasFlag(args, '--no-open');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-tacle-demo-'));
  console.log(`spec-tacle: staging demo in ${tmpDir}`);
  for (const f of fs.readdirSync(EXAMPLE_DIR)) copyFile(path.join(EXAMPLE_DIR, f), path.join(tmpDir, f));
  const dataJson = path.join(tmpDir, 'example-data.json');
  const outHtml = path.join(tmpDir, 'example-visualizer.html');
  try { render(TEMPLATE, dataJson, outHtml); }
  catch (err) { console.error(`render error: ${err.message}`); process.exit(2); }
  startServer({
    root: tmpDir,
    port,
    onListen: (actualPort) => {
      const url = `http://localhost:${actualPort}/example-visualizer.html`;
      console.log('');
      if (noOpen) console.log(`spec-tacle: open ${url}`);
      else        console.log(`spec-tacle: opening ${url}`);
      console.log('spec-tacle: Update spec / Undo will round-trip into the copy of example-spec.md in the temp dir.');
      if (!noOpen) openInBrowser(url);
    },
  });
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
    case 'render':  return cmdRender(rest);
    case 'serve':   return cmdServe(rest);
    case 'skill':   return cmdSkill();
    case 'example': return cmdExample(rest);
    case 'demo':    return cmdDemo(rest);
    default:
      console.error(`spec-tacle: unknown command "${cmd}"\n`);
      usage();
      process.exit(1);
  }
}

main();
