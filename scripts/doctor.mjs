#!/usr/bin/env node
/**
 * Machine readiness check for Agent Evals.
 *
 * Checks node, opencode, the OpenCode database, the runner, the eval-judge
 * agent, and plan-orchestrator. Exits 1 only when the runner cannot start or
 * the eval-judge agent is missing; every other problem is a warning.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BACKUPS_DIR,
  DRAFTS_DIR,
  REPORTS_DIR,
  STATE_ROOT,
} from '../runner/lib/state.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = process.env.AGENT_EVALS_HOME
  ? path.resolve(process.env.AGENT_EVALS_HOME)
  : path.join(ROOT, 'runner');
const RUN_MJS = path.join(RUNNER, 'run.mjs');
const CONFIG_HOME = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'opencode',
);
const EVALS_LINK = path.join(CONFIG_HOME, 'evals');
const ROOT_LINK = path.join(CONFIG_HOME, 'agent-evals');
const DB_PATH =
  process.env.OPENCODE_DB ||
  path.join(os.homedir(), '.local/share/opencode/opencode.db');

let hardFailure = false;

function line(level, name, detail) {
  console.log(`${level.padEnd(4)} ${name.padEnd(17)} ${detail}`);
}
function ok(name, detail) {
  line('ok', name, detail);
}
function warn(name, detail) {
  line('warn', name, detail);
}
function fail(name, detail) {
  line('FAIL', name, detail);
  hardFailure = true;
}
function firstLine(text) {
  return String(text ?? '')
    .trim()
    .split('\n')[0];
}

function listAgents() {
  const result = spawnSync('opencode', ['debug', 'agents'], {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) return { error: result.error.message };
  if (result.status !== 0) {
    return { error: firstLine(result.stderr) || `exit ${result.status}` };
  }
  try {
    const agents = JSON.parse(result.stdout);
    if (!Array.isArray(agents)) return { error: 'agent list is not an array' };
    return { agents };
  } catch (error) {
    return { error: `invalid JSON: ${error.message}` };
  }
}

function findByID(agents, id) {
  return agents.find((agent) => agent.id === id) ?? null;
}

function wildcardDenies(agent) {
  return new Set(
    (agent.permissions ?? [])
      .filter((permission) => permission.effect === 'deny' && permission.resource === '*')
      .map((permission) => permission.action),
  );
}

// node
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor >= 20) {
  ok('node', process.version);
} else {
  warn('node', `${process.version} (expected >= 20)`);
}

// local state
try {
  for (const directory of [REPORTS_DIR, DRAFTS_DIR, BACKUPS_DIR]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  ok('state', STATE_ROOT);
} catch (error) {
  warn('state', `${STATE_ROOT} not writable: ${error.code ?? error.message}`);
}

// opencode
const opencode = spawnSync('opencode', ['--version'], {
  encoding: 'utf8',
  timeout: 15000,
});
if (opencode.error || opencode.status !== 0) {
  warn('opencode', `not usable: ${opencode.error?.message ?? firstLine(opencode.stderr)}`);
} else {
  ok('opencode', opencode.stdout.trim() || `exit ${opencode.status}`);
}

// database
try {
  fs.accessSync(DB_PATH, fs.constants.R_OK);
  const { size } = fs.statSync(DB_PATH);
  ok('database', `${DB_PATH} (${(size / 1024 / 1024).toFixed(1)} MB)`);
} catch (error) {
  warn('database', `${DB_PATH} not readable: ${error.code ?? error.message}`);
}

// runner
let runnerWorks = false;
if (!fs.existsSync(RUN_MJS)) {
  fail('runner', `run.mjs missing at ${RUN_MJS}`);
} else {
  const help = spawnSync(process.execPath, [RUN_MJS, '--help'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  if (help.status === 0) {
    runnerWorks = true;
    ok('runner', `${RUN_MJS} (help exits 0)`);
  } else {
    fail('runner', `${RUN_MJS} failed: ${firstLine(help.stderr) || `exit ${help.status}`}`);
  }
}

// local wiring (reported, never fatal on its own)
if (runnerWorks) {
  try {
    const target = fs.realpathSync(EVALS_LINK);
    if (target === fs.realpathSync(RUNNER)) {
      ok('wiring', `${EVALS_LINK} -> ${target}`);
    } else {
      warn('wiring', `${EVALS_LINK} -> ${target} (expected ${RUNNER})`);
    }
  } catch {
    warn('wiring', `${EVALS_LINK} missing (run scripts/install.sh)`);
  }
}

// root link and factory scripts (reported, never fatal on their own)
try {
  const target = fs.realpathSync(ROOT_LINK);
  if (target === fs.realpathSync(ROOT)) {
    ok('root link', `${ROOT_LINK} -> ${target}`);
  } else {
    warn('root link', `${ROOT_LINK} -> ${target} (expected ${ROOT})`);
  }
} catch {
  warn('root link', `${ROOT_LINK} missing (run scripts/install.sh)`);
}

const factoryFiles = [
  path.join(ROOT, 'scripts', 'from-session.mjs'),
  path.join(ROOT, 'scripts', 'new-case.mjs'),
  path.join(ROOT, 'templates', 'fixture'),
];
const missingFactory = factoryFiles
  .filter((file) => !fs.existsSync(file))
  .map((file) => path.relative(ROOT, file));
if (missingFactory.length > 0) {
  warn('factory', `missing ${missingFactory.join(', ')}`);
} else {
  ok('factory', 'from-session, new-case, and fixture template present');
}

// agents
const agentsResult = listAgents();
const agents = agentsResult.agents ?? null;

if (!agents) {
  warn('eval-judge', `cannot verify: ${agentsResult.error}`);
} else {
  const judge = findByID(agents, 'eval-judge');
  if (!judge) {
    fail('eval-judge', 'not registered by opencode');
  } else {
    const denies = wildcardDenies(judge);
    const missing = ['edit', 'shell', 'subagent'].filter((action) => !denies.has(action));
    if (missing.length === 0) {
      ok('eval-judge', 'registered; edit, shell, subagent denied');
    } else {
      warn('eval-judge', `registered; missing wildcard deny: ${missing.join(', ')}`);
    }
  }
}

if (!agents) {
  warn('plan-orchestrator', `cannot verify: ${agentsResult.error}`);
} else if (findByID(agents, 'plan-orchestrator')) {
  ok('plan-orchestrator', 'registered');
} else {
  warn('plan-orchestrator', 'not registered (E1 delegation case needs it)');
}

if (hardFailure) {
  console.error('\ndoctor: FAILED');
  process.exit(1);
}
console.log('\ndoctor: ok');
