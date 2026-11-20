#!/usr/bin/env node
/**
 * Sync the harness-invariants block in the global OpenCode AGENTS.md.
 *
 * The repository instruction file is the only source of the block. An existing
 * marked block is replaced in place, a missing block is inserted before the
 * execution-harness block, and every other block is preserved. The script never
 * duplicates the block and never rewrites AGENTS.md when it is already current.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const GUARDRAILS = path.resolve(SCRIPT_DIR, '..');
const INSTRUCTION = path.join(GUARDRAILS, 'instructions', 'harness-invariants.md');
const CONFIG_HOME = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'opencode',
);
const AGENTS = path.join(CONFIG_HOME, 'AGENTS.md');
const STATE_ROOT = path.resolve(
  process.env.AGENT_EVALS_STATE ||
    path.join(os.homedir(), '.local', 'state', 'agent-evals'),
);
const BACKUP = path.join(STATE_ROOT, 'backups', 'AGENTS.md.bak');
const START = '<!-- harness-invariants:start -->';
const END = '<!-- harness-invariants:end -->';
const EXECUTION_START = '<!-- execution-harness:start -->';

function fail(message) {
  console.error(`install-block: ${message}`);
  process.exit(1);
}

function count(text, marker) {
  return text.split(marker).length - 1;
}

function locate(text) {
  const starts = count(text, START);
  const ends = count(text, END);
  if (starts === 0 && ends === 0) return null;
  if (starts !== 1 || ends !== 1) {
    fail(
      `${AGENTS}: expected one ${START} and one ${END}, ` +
        `found ${starts} start and ${ends} end marker(s)`,
    );
  }
  const start = text.indexOf(START);
  const end = text.indexOf(END, start);
  if (end < start) fail(`${AGENTS}: ${END} appears before ${START}`);
  return { start, end: end + END.length };
}

function readInstruction() {
  let block;
  try {
    block = fs.readFileSync(INSTRUCTION, 'utf8').trim();
  } catch (error) {
    fail(`cannot read ${INSTRUCTION}: ${error.message}`);
  }
  if (!block.startsWith(START) || !block.endsWith(END)) {
    fail(`${INSTRUCTION} must contain one marked block (${START} ... ${END})`);
  }
  if (count(block, START) !== 1 || count(block, END) !== 1) {
    fail(`${INSTRUCTION} must contain exactly one marked block`);
  }
  return block;
}

const block = readInstruction();
const exists = fs.existsSync(AGENTS);
const original = exists ? fs.readFileSync(AGENTS, 'utf8') : '';
const range = locate(original);

let updated;
if (range) {
  updated = original.slice(0, range.start) + block + original.slice(range.end);
} else if (exists) {
  const anchor = original.indexOf(EXECUTION_START);
  if (anchor >= 0) {
    updated = `${original.slice(0, anchor)}${block}\n\n${original.slice(anchor)}`;
  } else {
    updated = `${original.replace(/\s*$/, '')}\n\n${block}\n`;
  }
} else {
  updated = `${block}\n`;
}

if (exists && !fs.existsSync(BACKUP)) {
  fs.mkdirSync(path.dirname(BACKUP), { recursive: true });
  fs.copyFileSync(AGENTS, BACKUP);
  console.log(`backup    ${BACKUP}`);
}

if (exists && updated === original) {
  console.log(`unchanged ${AGENTS}`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(AGENTS), { recursive: true });
fs.writeFileSync(AGENTS, updated.endsWith('\n') ? updated : `${updated}\n`, 'utf8');
console.log(`${exists ? 'updated' : 'created'}   ${AGENTS}`);
