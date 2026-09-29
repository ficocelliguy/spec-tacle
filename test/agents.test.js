// Tests for lib/agents.js: skill install targets and the per-agent permission
// files mirrored from the Claude settings. Every test runs against a
// throwaway fake home dir.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  skillInstallTargets, legacySkillFiles,
  ensureOtherAgentsUserPermissions, ensureOtherAgentsProjectPermissions,
  CODEX_USER_RULES,
} = require(path.join(__dirname, '..', 'lib', 'agents.js'));
const { ensureAutoAgentPermissions } = require(path.join(__dirname, '..', 'lib', 'serve.js'));

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeHome(...agentDirs) {
  const home = tmpDir('spec-tacle-home-');
  for (const d of agentDirs) fs.mkdirSync(path.join(home, d), { recursive: true });
  return home;
}

const readJson = f => JSON.parse(fs.readFileSync(f, 'utf-8'));

// The writers log every action; keep test output readable.
function quiet(fn) {
  const out = process.stdout.write, err = process.stderr.write;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try { return fn(); } finally { process.stdout.write = out; process.stderr.write = err; }
}

test('skillInstallTargets is Claude-only when no other agent is installed', () => {
  const home = fakeHome();
  const dirs = skillInstallTargets({ homeDir: home }).map(t => t.dir);
  assert.deepEqual(dirs, [path.join(home, '.claude', 'skills', 'spec-tacle')]);
});

test('skillInstallTargets adds ~/.agents/skills when Codex or Gemini is installed', () => {
  const home = fakeHome('.codex', '.gemini');
  const targets = skillInstallTargets({ homeDir: home });
  assert.equal(targets.length, 2);
  assert.equal(targets[1].dir, path.join(home, '.agents', 'skills', 'spec-tacle'));
  assert.deepEqual(targets[1].agents, ['Codex', 'Gemini CLI']);
});

test('skillInstallTargets skips ~/.agents/skills for agents that already read ~/.claude/skills', () => {
  const home = fakeHome('.cursor', '.config/opencode');
  assert.equal(skillInstallTargets({ homeDir: home }).length, 1);
});

test('legacySkillFiles includes the old ~/.codex/skills copy', () => {
  const home = fakeHome();
  assert.ok(legacySkillFiles({ homeDir: home }).includes(path.join(home, '.codex', 'skills', 'spec-tacle', 'SKILL.md')));
});

test('user-level permissions touch nothing when no other agent is installed', () => {
  const home = fakeHome();
  const results = quiet(() => ensureOtherAgentsUserPermissions({ homeDir: home }));
  assert.deepEqual(results, []);
  assert.deepEqual(fs.readdirSync(home), []);
});

test('user-level permissions write each installed agent\'s config and are idempotent', () => {
  const home = fakeHome('.codex', '.gemini', '.cursor', '.config/opencode');
  const first = quiet(() => ensureOtherAgentsUserPermissions({ homeDir: home }));
  assert.deepEqual(first.map(r => r.action), ['wrote', 'wrote', 'wrote', 'wrote']);

  assert.equal(fs.readFileSync(path.join(home, '.codex', 'rules', 'spec-tacle.rules'), 'utf-8'), CODEX_USER_RULES);
  assert.ok(readJson(path.join(home, '.gemini', 'settings.json')).tools.allowed.includes('run_shell_command(npx spec-tacle_skill)'));
  assert.ok(readJson(path.join(home, '.cursor', 'cli-config.json')).permissions.allow.includes('Shell(npx:spec-tacle*)'));
  assert.equal(readJson(path.join(home, '.config', 'opencode', 'opencode.json')).permission.bash['npx spec-tacle*'], 'allow');

  const second = quiet(() => ensureOtherAgentsUserPermissions({ homeDir: home }));
  assert.deepEqual(second.map(r => r.action), ['unchanged', 'unchanged', 'unchanged', 'unchanged']);
});

test('user-level merge keeps existing settings and entries', () => {
  const home = fakeHome('.gemini', '.config/opencode');
  const gemini = path.join(home, '.gemini', 'settings.json');
  fs.writeFileSync(gemini, JSON.stringify({ theme: 'dark', tools: { allowed: ['read_file'] } }));
  const opencode = path.join(home, '.config', 'opencode', 'opencode.json');
  fs.writeFileSync(opencode, JSON.stringify({ model: 'x', permission: { bash: 'ask' } }));

  quiet(() => ensureOtherAgentsUserPermissions({ homeDir: home }));

  const g = readJson(gemini);
  assert.equal(g.theme, 'dark');
  assert.deepEqual(g.tools.allowed, ['read_file', 'run_shell_command(npx spec-tacle_skill)', 'run_shell_command(npx spec-tacle)']);
  const o = readJson(opencode);
  assert.equal(o.model, 'x');
  // The old catch-all string survives as the "*" entry, ahead of ours.
  assert.deepEqual(Object.entries(o.permission.bash), [['*', 'ask'], ['npx spec-tacle*', 'allow']]);
});

test('user-level merge leaves an unparseable config alone', () => {
  const home = fakeHome('.config/opencode');
  const file = path.join(home, '.config', 'opencode', 'opencode.json');
  const jsonc = '{\n  // comment\n  "model": "x"\n}\n';
  fs.writeFileSync(file, jsonc);
  const [r] = quiet(() => ensureOtherAgentsUserPermissions({ homeDir: home }));
  assert.equal(r.action, 'skipped');
  assert.equal(fs.readFileSync(file, 'utf-8'), jsonc);
});

test('project permissions mirror the Claude template for installed agents and never overwrite', () => {
  const home = fakeHome('.codex', '.gemini', '.cursor', '.config/opencode');
  const root = tmpDir('spec-tacle-root-');
  const existing = path.join(root, '.gemini', 'settings.json');
  fs.mkdirSync(path.dirname(existing), { recursive: true });
  fs.writeFileSync(existing, '{"mine":true}');

  const results = quiet(() => ensureOtherAgentsProjectPermissions(root, { homeDir: home }));
  assert.deepEqual(results.map(r => [r.agent, r.action]), [
    ['Codex', 'wrote'], ['Gemini CLI', 'kept'], ['Cursor', 'wrote'], ['OpenCode', 'wrote'],
  ]);
  assert.equal(fs.readFileSync(existing, 'utf-8'), '{"mine":true}');
  assert.match(fs.readFileSync(path.join(root, '.codex', 'rules', 'spec-tacle.rules'), 'utf-8'), /prefix_rule/);
  assert.ok(readJson(path.join(root, '.cursor', 'cli.json')).permissions.allow.includes('Write(**)'));
  assert.equal(readJson(path.join(root, 'opencode.json')).permission.edit, 'allow');
});

test('ensureAutoAgentPermissions writes the Claude file plus installed agents only', () => {
  const home = fakeHome('.cursor');
  const root = tmpDir('spec-tacle-root-');
  const result = quiet(() => ensureAutoAgentPermissions(root, { homeDir: home }));
  assert.equal(result.action, 'wrote');
  assert.ok(fs.existsSync(path.join(root, '.claude', 'settings.local.json')));
  assert.deepEqual(result.others.map(r => r.agent), ['Cursor']);
  assert.ok(!fs.existsSync(path.join(root, 'opencode.json')));
  assert.ok(!fs.existsSync(path.join(root, '.codex')));
});
