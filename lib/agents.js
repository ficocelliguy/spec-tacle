// Per-agent install targets and permission files for editors other than
// Claude Code. Claude's own settings live in serve.js
// (AUTO_AGENT_SETTINGS_TEMPLATE, USER_LEVEL_PERMISSIONS); this module mirrors
// the same grants into each other agent's config format.
//
// Every writer here only touches an agent that is installed on this machine
// (its home config dir exists), so a Claude-only user never gets stray
// .gemini/ or opencode.json files.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------- skills ----------

// ~/.agents/skills is the shared Agent Skills location. Codex, Gemini CLI,
// Cursor, Copilot CLI, OpenCode, Windsurf, and Amp all read it; Claude Code
// does not, so Claude keeps its own copy in ~/.claude/skills.
//
// Cursor, OpenCode, and Amp also read ~/.claude/skills, so for them a second
// copy would list the skill twice. We only write ~/.agents/skills when an
// agent that can't see ~/.claude/skills is installed.
const AGENTS_SKILLS_READERS = [
  { name: 'Codex',       dirs: ['.codex'] },
  { name: 'Gemini CLI',  dirs: ['.gemini'] },
  { name: 'Copilot CLI', dirs: ['.copilot'] },
  { name: 'Windsurf',    dirs: ['.codeium/windsurf', '.config/devin'] },
];

function isInstalled(home, rel) {
  return fs.existsSync(path.join(home, rel));
}

// Returns [{ dir, agents }] for every skills directory `install` should write.
function skillInstallTargets({ homeDir } = {}) {
  const home = homeDir || os.homedir();
  const targets = [{ dir: path.join(home, '.claude', 'skills', 'spec-tacle'), agents: ['Claude Code'] }];
  const readers = AGENTS_SKILLS_READERS
    .filter(a => a.dirs.some(d => isInstalled(home, d)))
    .map(a => a.name);
  if (readers.length || isInstalled(home, '.agents/skills')) {
    targets.push({ dir: path.join(home, '.agents', 'skills', 'spec-tacle'), agents: readers });
  }
  return targets;
}

// Skill folders earlier versions wrote that current agents either no longer
// read (~/.codex/skills, superseded by ~/.agents/skills) or that used the old
// `spec-tacle_skill` name. Removing them keeps the skill from listing twice.
function legacySkillFiles({ homeDir } = {}) {
  const home = homeDir || os.homedir();
  return [
    path.join(home, '.claude', 'skills', 'spec-tacle_skill', 'SKILL.md'),
    path.join(home, '.codex', 'skills', 'spec-tacle_skill', 'SKILL.md'),
    path.join(home, '.codex', 'skills', 'spec-tacle', 'SKILL.md'),
  ];
}

// ---------- permission content ----------

// Codex execpolicy rules. An "allow" rule runs the command outside the
// sandbox without prompting, which is also what lets `serve` bind its
// localhost port. That makes each allowed prefix more powerful than Claude's
// equivalent, so the project file leaves out generic `node`, grep, sed, and
// mkdir; those already run inside Codex's workspace sandbox.
const CODEX_USER_RULES = [
  '# Written by `npx spec-tacle_skill install`. Lets Codex run the spec-tacle',
  '# CLI without an approval prompt. Delete this file to opt out.',
  'prefix_rule(',
  '    pattern = ["npx", ["spec-tacle_skill", "spec-tacle"]],',
  '    decision = "allow",',
  ')',
  '',
].join('\n');

const CODEX_PROJECT_RULES = [
  '# Written by spec-tacle_skill (serve --auto-agent / demo / install-perms).',
  '# Lets Codex start the spec-tacle server and POST edits to it on localhost',
  '# without approval prompts. Codex only loads project rules for trusted',
  '# projects. Delete or narrow this file to opt out.',
  'prefix_rule(',
  '    pattern = ["npx", ["spec-tacle_skill", "spec-tacle"]],',
  '    decision = "allow",',
  ')',
  'prefix_rule(',
  '    pattern = ["node", "./bin/spec-tacle.js"],',
  '    decision = "allow",',
  ')',
  'prefix_rule(',
  '    pattern = ["curl"],',
  '    decision = "allow",',
  ')',
  '',
].join('\n');

const GEMINI_USER_ALLOWED = [
  'run_shell_command(npx spec-tacle_skill)',
  'run_shell_command(npx spec-tacle)',
];

const GEMINI_PROJECT_SETTINGS = {
  tools: {
    allowed: [
      'read_file',
      'replace',
      'write_file',
      'run_shell_command(node)',
      'run_shell_command(npx spec-tacle_skill)',
      'run_shell_command(npx spec-tacle)',
      'run_shell_command(curl)',
      'run_shell_command(grep)',
      'run_shell_command(sed)',
      'run_shell_command(mkdir)',
    ],
  },
};

// Cursor's Shell(cmd:args) form globs the arguments, so the user-level rule
// covers only the spec-tacle CLI rather than every npx package.
const CURSOR_USER_ALLOWED = ['Shell(npx:spec-tacle*)'];

const CURSOR_PROJECT_SETTINGS = {
  permissions: {
    allow: [
      'Read(**)',
      'Write(**)',
      'Shell(node)',
      'Shell(npx:spec-tacle*)',
      'Shell(curl)',
      'Shell(grep)',
      'Shell(sed)',
      'Shell(mkdir)',
    ],
  },
};

// OpenCode applies the last matching bash pattern, so the "*" catch-all
// comes first.
const OPENCODE_USER_BASH = { 'npx spec-tacle*': 'allow' };

const OPENCODE_PROJECT_SETTINGS = {
  $schema: 'https://opencode.ai/config.json',
  permission: {
    edit: 'allow',
    bash: {
      '*': 'ask',
      'node *': 'allow',
      'npx spec-tacle*': 'allow',
      'curl *': 'allow',
      'grep *': 'allow',
      'sed *': 'allow',
      'mkdir *': 'allow',
    },
  },
};

// ---------- file helpers ----------

// Read-modify-write a JSON config. `mutate(obj)` returns the list of entries
// it added; nothing is written when that list is empty. A file that doesn't
// parse (OpenCode allows JSONC comments, for one) is left alone.
function mergeJsonFile(file, mutate) {
  let obj = {};
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf-8');
    try { obj = JSON.parse(raw || '{}'); }
    catch (e) { return { path: file, action: 'skipped', error: `could not parse (${e.message}); leaving it alone` }; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return { path: file, action: 'skipped', error: 'not a JSON object; leaving it alone' };
    }
  }
  const added = mutate(obj);
  if (!added.length) return { path: file, action: 'unchanged', added };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
  return { path: file, action: 'wrote', added };
}

function unionInto(arr, entries) {
  const have = new Set(arr);
  const added = entries.filter(e => !have.has(e));
  arr.push(...added);
  return added;
}

function objAt(obj, key) {
  if (!obj[key] || typeof obj[key] !== 'object' || Array.isArray(obj[key])) obj[key] = {};
  return obj[key];
}

// Project-level files follow the Claude template's rule: write when missing,
// never overwrite. The user or repo may have narrowed an existing one.
function writeIfMissing(file, content) {
  if (fs.existsSync(file)) return { path: file, action: 'kept' };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n', 'utf-8');
  return { path: file, action: 'wrote' };
}

// ---------- agent registry ----------

const AGENTS = [
  {
    name: 'Codex',
    home: ['.codex'],
    user(home) {
      const file = path.join(home, '.codex', 'rules', 'spec-tacle.rules');
      const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
      if (current === CODEX_USER_RULES) return { path: file, action: 'unchanged', added: [] };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, CODEX_USER_RULES, 'utf-8');
      return { path: file, action: 'wrote', added: ['prefix_rule npx spec-tacle_skill / spec-tacle'] };
    },
    project: root => writeIfMissing(path.join(root, '.codex', 'rules', 'spec-tacle.rules'), CODEX_PROJECT_RULES),
  },
  {
    name: 'Gemini CLI',
    home: ['.gemini'],
    user: home => mergeJsonFile(path.join(home, '.gemini', 'settings.json'), s => {
      const tools = objAt(s, 'tools');
      if (!Array.isArray(tools.allowed)) tools.allowed = [];
      return unionInto(tools.allowed, GEMINI_USER_ALLOWED);
    }),
    project: root => writeIfMissing(path.join(root, '.gemini', 'settings.json'), GEMINI_PROJECT_SETTINGS),
  },
  {
    name: 'Cursor',
    home: ['.cursor'],
    user: home => mergeJsonFile(path.join(home, '.cursor', 'cli-config.json'), s => {
      const perms = objAt(s, 'permissions');
      if (!Array.isArray(perms.allow)) perms.allow = [];
      return unionInto(perms.allow, CURSOR_USER_ALLOWED);
    }),
    project: root => writeIfMissing(path.join(root, '.cursor', 'cli.json'), CURSOR_PROJECT_SETTINGS),
  },
  {
    name: 'OpenCode',
    home: ['.config/opencode'],
    user: home => mergeJsonFile(path.join(home, '.config', 'opencode', 'opencode.json'), s => {
      if (!s.$schema) s.$schema = 'https://opencode.ai/config.json';
      const perm = objAt(s, 'permission');
      // A bare string ("ask") is a catch-all; keep it as the "*" entry.
      if (typeof perm.bash === 'string') perm.bash = { '*': perm.bash };
      const bash = objAt(perm, 'bash');
      const added = Object.keys(OPENCODE_USER_BASH).filter(k => bash[k] !== OPENCODE_USER_BASH[k]);
      for (const k of added) bash[k] = OPENCODE_USER_BASH[k];
      return added;
    }),
    project: root => writeIfMissing(path.join(root, 'opencode.json'), OPENCODE_PROJECT_SETTINGS),
  },
];

function installedAgents(home) {
  return AGENTS.filter(a => a.home.some(d => isInstalled(home, d)));
}

function runEach(agents, fn, label) {
  return agents.map(agent => {
    try {
      return { agent: agent.name, ...fn(agent) };
    } catch (e) {
      process.stderr.write(`${label} could not write ${agent.name} permissions: ${e.message}\n`);
      return { agent: agent.name, action: 'skipped', error: e.message };
    }
  });
}

// User-level: pre-approve the spec-tacle CLI for every installed agent, the
// same narrow grant ensureUserLevelPermissions gives Claude.
function ensureOtherAgentsUserPermissions({ homeDir, logPrefix } = {}) {
  const label = logPrefix || '[spec-tacle]';
  const home = homeDir || os.homedir();
  const results = runEach(installedAgents(home), a => a.user(home), label);
  for (const r of results) {
    if (r.action === 'wrote') process.stdout.write(`${label} pre-approved the spec-tacle CLI for ${r.agent} in ${r.path}\n`);
    else if (r.action === 'unchanged') process.stdout.write(`${label} ${r.agent} permissions already present at ${r.path} (nothing to add)\n`);
    else if (r.error) process.stderr.write(`${label} skipped ${r.agent} permissions at ${r.path || '(unknown)'}: ${r.error}\n`);
  }
  return results;
}

// Project-level: mirror the Claude auto-agent template into each installed
// agent's project config, so whichever agent the user drives from this
// directory can run the server, edit the spec, and POST edits without
// stalling on prompts.
function ensureOtherAgentsProjectPermissions(root, { homeDir, logPrefix } = {}) {
  const label = logPrefix || '[spec-tacle]';
  const home = homeDir || os.homedir();
  const results = runEach(installedAgents(home), a => a.project(root), label);
  for (const r of results) {
    if (r.action === 'wrote') process.stdout.write(`${label} wrote ${r.agent} permissions to ${r.path}\n`);
    else if (r.action === 'kept') process.stdout.write(`${label} ${r.agent} permissions already at ${r.path} (kept as-is)\n`);
  }
  return results;
}

module.exports = {
  skillInstallTargets, legacySkillFiles,
  ensureOtherAgentsUserPermissions, ensureOtherAgentsProjectPermissions,
  AGENTS,
  CODEX_USER_RULES, CODEX_PROJECT_RULES,
  GEMINI_PROJECT_SETTINGS, CURSOR_PROJECT_SETTINGS, OPENCODE_PROJECT_SETTINGS,
};
