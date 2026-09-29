// Tests for --auto-agent agent selection (Claude Code / Codex / custom
// command), the Codex progress parser, and a live hook run against a fake
// agent binary.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const {
  start, resolveAutoAgent, autoAgentCommand, AGENT_PRESETS,
  deriveProgressFromCodexJson, STREAM_PARSERS,
  interpolateHookCmd, fillPromptPlaceholders, consistencyPassPrompt,
  readConsistencyQueue, manualPassInstructions,
} = require(path.join(__dirname, '..', 'lib', 'serve.js'));

function fakeBinDir(...names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-tacle-bin-'));
  for (const n of names) {
    const f = path.join(dir, n);
    fs.writeFileSync(f, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(f, 0o755);
  }
  return dir;
}

test('resolveAutoAgent honors an explicit agent and rejects unknown ones', () => {
  const env = { PATH: '' };
  assert.equal(resolveAutoAgent('codex', { env }).name, 'codex');
  assert.equal(resolveAutoAgent(null, { env: { ...env, SPEC_TACLE_AGENT: 'claude' } }).name, 'claude');
  assert.match(resolveAutoAgent('gemini', { env }).error, /unknown agent "gemini".*\{prompt\}/);
});

test('resolveAutoAgent picks whichever preset binary is on PATH, Claude first', () => {
  assert.equal(resolveAutoAgent(null, { env: { PATH: fakeBinDir('codex') } }).name, 'codex');
  assert.equal(resolveAutoAgent(null, { env: { PATH: fakeBinDir('claude', 'codex') } }).name, 'claude');
  assert.match(resolveAutoAgent(null, { env: { PATH: fakeBinDir() } }).error, /no agent CLI found/);
});

test('resolveAutoAgent prefers the agent the server was started from', () => {
  const PATH = fakeBinDir('claude', 'codex');
  assert.equal(resolveAutoAgent(null, { env: { PATH, CODEX_SANDBOX: 'seatbelt' } }).name, 'codex');
  assert.equal(resolveAutoAgent(null, { env: { PATH, CLAUDECODE: '1' } }).name, 'claude');
});

test('SPEC_TACLE_AGENT_BIN overrides the binary for the chosen preset', () => {
  const r = resolveAutoAgent('codex', { env: { PATH: '', SPEC_TACLE_AGENT_BIN: '/opt/codex' } });
  assert.equal(r.bin, '/opt/codex');
  assert.match(autoAgentCommand(r, { env: {} }), /^\/opt\/codex exec /);
});

test('the Codex preset runs exec in a network-enabled workspace sandbox and passes no Claude model', () => {
  const cmd = autoAgentCommand({ preset: AGENT_PRESETS.codex, bin: 'codex' }, { env: {} });
  assert.match(cmd, /^codex exec --json --skip-git-repo-check --sandbox workspace-write -c sandbox_workspace_write\.network_access=true \{prompt\}$/);
  const withModel = autoAgentCommand({ preset: AGENT_PRESETS.codex, bin: 'codex' }, { env: { SPEC_TACLE_AGENT_MODEL: 'gpt-5-codex' } });
  assert.match(withModel, /--model gpt-5-codex \{prompt\}$/);
});

test('the Claude preset keeps Haiku and stream-json output', () => {
  const cmd = autoAgentCommand({ preset: AGENT_PRESETS.claude, bin: 'claude' }, { env: {} });
  assert.equal(cmd, 'claude -p {prompt} --model claude-haiku-4-5-20251001 --output-format stream-json --verbose');
});

test('{prompt} lands as one shell-quoted argument even with quotes inside', () => {
  const ctx = { entryId: 'e1', specPath: "it's.md", root: '/r', port: 8765 };
  ctx.prompt = fillPromptPlaceholders('Entry {entryId} for {specPath} on {port}', ctx);
  const cmd = interpolateHookCmd('agent {prompt}', ctx);
  assert.equal(cmd, "agent 'Entry e1 for it'\\''s.md on 8765'");
});

test('the shared prompt names the CLI by absolute path and fills every placeholder', () => {
  const filled = fillPromptPlaceholders(consistencyPassPrompt(), { entryId: 'abc', specPath: 's.md', root: '/r', port: 9 });
  assert.match(filled, /node "\/.*\/bin\/spec-tacle\.js" consistency-apply/);
  assert.match(filled, /Entry: abc/);
  assert.match(filled, /http:\/\/127\.0\.0\.1:9/);
  assert.doesNotMatch(filled, /\{(entryId|specPath|root|port)\}/);
});

test('deriveProgressFromCodexJson maps item events to phases', () => {
  assert.equal(deriveProgressFromCodexJson({ type: 'thread.started' }, 0).phase, 'auto-agent booting');
  const cmd = deriveProgressFromCodexJson({ type: 'item.started', item: { type: 'command_execution', command: 'bash -lc "node x consistency-apply e.json"' } }, 2);
  assert.equal(cmd.phase, 'shell');
  assert.equal(cmd.note, 'posting follow-up edits to /consistency-apply');
  assert.equal(cmd.percent, 29);
  const edit = deriveProgressFromCodexJson({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'spec.md', kind: 'update' }] } }, 1);
  assert.deepEqual([edit.phase, edit.note], ['Edit', 'spec.md']);
  assert.equal(deriveProgressFromCodexJson({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } }, 1), null);
  assert.equal(deriveProgressFromCodexJson({ type: 'turn.completed' }, 5).phase, 'wrapping up');
  const failed = deriveProgressFromCodexJson({ type: 'turn.failed', error: { message: 'quota' } }, 5);
  assert.deepEqual([failed.phase, failed.note], ['auto-agent errored', 'quota']);
});

test('deriveProgressFromCodexJson handles the older msg-wrapped events', () => {
  const p = deriveProgressFromCodexJson({ msg: { type: 'exec_command_begin', command: ['ls', '-la'] } }, 1);
  assert.deepEqual([p.phase, p.note], ['shell', 'ls -la']);
});

test('the Codex parser counts commands and file changes as tool steps, not messages', () => {
  const { isTool } = STREAM_PARSERS.codex;
  assert.equal(isTool({ type: 'item.started', item: { type: 'command_execution' } }), true);
  assert.equal(isTool({ type: 'item.completed', item: { type: 'command_execution' } }), false);
  assert.equal(isTool({ type: 'item.completed', item: { type: 'file_change' } }), true);
  assert.equal(isTool({ type: 'item.completed', item: { type: 'agent_message' } }), false);
});

function httpPost(port, p, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf-8') || 'null') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function waitFor(fn, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('timed out');
}

test('--auto-agent with --agent codex spawns the Codex command and parses its JSONL output', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-tacle-codex-hook-'));
  fs.writeFileSync(path.join(tmp, 'spec.md'), '<!-- spec-tacle:summary:what -->\n- one\n<!-- /spec-tacle:summary:what -->\n');
  // Fake codex: record argv (one arg per line), emit a few JSONL events.
  const argvFile = path.join(tmp, 'argv.txt');
  const bin = path.join(tmp, 'fake-codex');
  fs.writeFileSync(bin, [
    '#!/bin/sh',
    `for a in "$@"; do printf '%s\\n' "$a" >> '${argvFile}'; done`,
    `echo '{"type":"thread.started","thread_id":"t"}'`,
    `echo '{"type":"item.started","item":{"type":"command_execution","command":"cat spec.md"}}'`,
    `echo '{"type":"turn.completed"}'`,
    `echo "sandbox=$CODEX_SANDBOX_NETWORK_DISABLED" >> '${argvFile}'`,
  ].join('\n') + '\n');
  fs.chmodSync(bin, 0o755);
  const saved = { bin: process.env.SPEC_TACLE_AGENT_BIN, sb: process.env.CODEX_SANDBOX_NETWORK_DISABLED };
  process.env.SPEC_TACLE_AGENT_BIN = bin;
  process.env.CODEX_SANDBOX_NETWORK_DISABLED = '1';
  const port = 21000 + Math.floor(Math.random() * 1000);
  const server = start({ root: tmp, port, autoAgent: true, agent: 'codex' });
  try {
    await new Promise(r => setTimeout(r, 80));
    const res = await httpPost(port, '/update-spec', JSON.stringify({ specPath: 'spec.md', sections: { 'summary:what': '- two' }, diagrams: {} }));
    assert.equal(res.status, 200);
    const id = res.json.consistencyPending;
    const argv = await waitFor(() => {
      const t = fs.existsSync(argvFile) && fs.readFileSync(argvFile, 'utf-8');
      return t && t.includes('sandbox=') ? t.split('\n') : null;
    });
    assert.deepEqual(argv.slice(0, 7), ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true']);
    assert.match(argv[7], new RegExp(`^A spec-tacle consistency pass is pending\\..*Entry: ${id} `));
    assert.ok(argv.includes('sandbox='), 'the parent Codex sandbox marker is scrubbed from the child env');
    const log = path.join(tmp, '.spec-tacle-agent-logs', `${id}.log`);
    await waitFor(() => fs.existsSync(log) && fs.readFileSync(log, 'utf-8').includes('turn.completed'));
    // The child exited without applying, so the auto-claim is released and
    // the entry stays queued for a retry.
    const entry = await waitFor(() => {
      const e = readConsistencyQueue(tmp).entries.find(x => x.id === id);
      return e && !e.claim ? e : null;
    });
    assert.equal(entry.id, id);
  } finally {
    await new Promise(r => server.close(r));
    for (const [k, v] of [['SPEC_TACLE_AGENT_BIN', saved.bin], ['CODEX_SANDBOX_NETWORK_DISABLED', saved.sb]]) {
      if (v == null) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('manualPassInstructions names the folder and how to invoke the skill in each agent', () => {
  const text = manualPassInstructions('/work/spec-tacle-demo');
  assert.match(text, /open an agent session in \/work\/spec-tacle-demo/);
  assert.match(text, /Claude Code +\/spec-tacle run the pending spec-tacle consistency pass/);
  assert.match(text, /Codex +\$spec-tacle run the pending spec-tacle consistency pass/);
  assert.match(text, /consistency-check/);
});
