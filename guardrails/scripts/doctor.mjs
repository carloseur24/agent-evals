#!/usr/bin/env node
/**
 * Machine readiness check for the runtime guardrails.
 *
 * Verifies node, opencode, the three installed symlinks, the managed
 * harness-invariants block, the plan-orchestrator deny rules, and the guard
 * self-test. Never rewrites anything. Exits 1 on a hard mismatch.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const GUARDRAILS = path.resolve(SCRIPT_DIR, '..');
const REPO = path.resolve(GUARDRAILS, '..');
const CONFIG_HOME = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'opencode',
);
const AGENTS = path.join(CONFIG_HOME, 'AGENTS.md');
const INSTRUCTION = path.join(GUARDRAILS, 'instructions', 'harness-invariants.md');
const PLUGIN = path.join(GUARDRAILS, 'plugins', 'harness-guard.js');
const AGENT = path.join(GUARDRAILS, 'agents', 'plan-orchestrator.md');
const TEST = path.join(GUARDRAILS, 'tests', 'harness-guard.test.mjs');
const STATE_ROOT = path.resolve(
  process.env.AGENT_EVALS_STATE ||
    path.join(os.homedir(), '.local', 'state', 'agent-evals'),
);
const BACKUP = path.join(STATE_ROOT, 'backups', 'AGENTS.md.bak');
const START = '<!-- harness-invariants:start -->';
const END = '<!-- harness-invariants:end -->';

let hardFailure = false;

function line(level, name, detail) {
  console.log(`${level.padEnd(4)} ${name.padEnd(17)} ${detail}`);
}
function ok(name, detail) {
  line('ok', name, detail);
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
function tail(text, count = 3) {
  const lines = String(text ?? '')
    .trim()
    .split('\n')
    .filter(Boolean);
  return lines.slice(-count).join(' | ');
}
function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { error };
  }
}
function count(text, marker) {
  return text.split(marker).length - 1;
}

// node
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor >= 20) {
  ok('node', process.version);
} else {
  fail('node', `${process.version} (expected >= 20)`);
}

// state root
let stateOk = true;
for (const name of ['reports', 'drafts', 'backups']) {
  try {
    fs.mkdirSync(path.join(STATE_ROOT, name), { recursive: true });
  } catch (error) {
    fail('state', `${STATE_ROOT} not writable: ${error.code ?? error.message}`);
    stateOk = false;
  }
}
if (stateOk) ok('state', STATE_ROOT);

// opencode
const opencode = spawnSync('opencode', ['--version'], {
  encoding: 'utf8',
  timeout: 15000,
});
if (opencode.error || opencode.status !== 0) {
  fail('opencode', `not usable: ${opencode.error?.message ?? firstLine(opencode.stderr)}`);
} else {
  ok('opencode', opencode.stdout.trim() || `exit ${opencode.status}`);
}

// symlinks
function checkLink(name, linkPath, targetPath) {
  let stats;
  try {
    stats = fs.lstatSync(linkPath);
  } catch {
    fail(name, `${linkPath} missing (run guardrails/scripts/install.sh)`);
    return;
  }
  if (!stats.isSymbolicLink()) {
    fail(name, `${linkPath} is not a symlink (run guardrails/scripts/install.sh)`);
    return;
  }
  let resolved;
  try {
    resolved = fs.realpathSync(linkPath);
  } catch {
    fail(name, `${linkPath} does not resolve`);
    return;
  }
  let target;
  try {
    target = fs.realpathSync(targetPath);
  } catch {
    fail(name, `target missing: ${targetPath}`);
    return;
  }
  if (resolved !== target) {
    fail(name, `${linkPath} -> ${resolved} (expected ${target})`);
    return;
  }
  ok(name, `${linkPath} -> ${resolved}`);
}

checkLink('plugin link', path.join(CONFIG_HOME, 'plugins', 'harness-guard.js'), PLUGIN);
checkLink('agent link', path.join(CONFIG_HOME, 'agents', 'plan-orchestrator.md'), AGENT);
checkLink('guardrails link', path.join(CONFIG_HOME, 'agent-guardrails'), GUARDRAILS);

// managed AGENTS.md block
const agentsText = readText(AGENTS);
if (agentsText.error) {
  fail('AGENTS.md', `cannot read ${AGENTS}: ${agentsText.error.code ?? agentsText.error.message}`);
} else {
  const starts = count(agentsText, START);
  const ends = count(agentsText, END);
  if (starts !== 1 || ends !== 1) {
    fail('AGENTS.md', `expected one harness block, found ${starts} start and ${ends} end marker(s)`);
  } else {
    const start = agentsText.indexOf(START);
    const end = agentsText.indexOf(END, start);
    const extracted = end > start ? agentsText.slice(start, end + END.length) : '';
    const instruction = readText(INSTRUCTION);
    if (instruction.error) {
      fail('AGENTS.md', `cannot read ${INSTRUCTION}: ${instruction.error.message}`);
    } else if (extracted !== instruction.trim()) {
      fail('AGENTS.md', 'harness block differs from guardrails/instructions/harness-invariants.md');
    } else {
      ok('AGENTS.md', 'one harness block, matches guardrails/instructions/harness-invariants.md');
    }
  }
}

// backup location
if (fs.existsSync(`${AGENTS}.bak`)) {
  fail('AGENTS backup', `${AGENTS}.bak must live under ${path.join(STATE_ROOT, 'backups')}`);
} else if (fs.existsSync(BACKUP)) {
  ok('AGENTS backup', BACKUP);
} else {
  ok('AGENTS backup', `${BACKUP} (none yet)`);
}

// plan-orchestrator deny rules
const agentsResult = spawnSync('opencode', ['debug', 'agents'], {
  encoding: 'utf8',
  timeout: 60000,
  maxBuffer: 32 * 1024 * 1024,
});
if (agentsResult.error || agentsResult.status !== 0) {
  fail(
    'plan-orchestrator',
    `cannot list agents: ${agentsResult.error?.message ?? firstLine(agentsResult.stderr)}`,
  );
} else {
  let agents;
  try {
    agents = JSON.parse(agentsResult.stdout);
  } catch (error) {
    agents = null;
    fail('plan-orchestrator', `invalid agent list: ${error.message}`);
  }
  if (agents && !Array.isArray(agents)) {
    fail('plan-orchestrator', 'agent list is not an array');
  } else if (agents) {
    const agent = agents.find((entry) => entry.id === 'plan-orchestrator');
    if (!agent) {
      fail('plan-orchestrator', 'not registered by opencode');
    } else {
      const denies = new Set(
        (agent.permissions ?? [])
          .filter(
            (permission) =>
              permission.effect === 'deny' &&
              permission.resource === '*' &&
              (permission.action === 'edit' || permission.action === 'shell'),
          )
          .map((permission) => permission.action),
      );
      const missing = ['edit', 'shell'].filter((action) => !denies.has(action));
      if (missing.length > 0) {
        fail('plan-orchestrator', `registered; missing wildcard deny: ${missing.join(', ')}`);
      } else {
        ok('plan-orchestrator', 'registered; edit and shell denied');
      }
    }
  }
}

// guard self-test
const selfTest = spawnSync(process.execPath, ['--test', TEST], {
  cwd: REPO,
  encoding: 'utf8',
  timeout: 120000,
  maxBuffer: 32 * 1024 * 1024,
});
if (selfTest.error) {
  fail('guard self-test', selfTest.error.message);
} else if (selfTest.status !== 0) {
  fail('guard self-test', tail(selfTest.stderr || selfTest.stdout) || `exit ${selfTest.status}`);
} else {
  ok('guard self-test', 'node --test guardrails/tests/harness-guard.test.mjs');
}

if (hardFailure) {
  console.error('\ndoctor: FAILED');
  process.exit(1);
}
console.log('\ndoctor: ok');
