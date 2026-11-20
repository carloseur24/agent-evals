#!/usr/bin/env node
/**
 * Static validation for the Agent Evals repository.
 *
 * Checks metadata, case schema, fixture references, calibration examples,
 * the eval-judge contract, required docs, and portability. Never invokes a
 * model and never writes files. Exits 1 on any failed check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scorerNames } from '../runner/lib/scorers/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = path.join(ROOT, 'runner');
const errors = [];
const ABSOLUTE_HOME_RE =
  /(?:[/]home[/][A-Za-z0-9._-]+|[/]Users[/][A-Za-z0-9._-]+|[/]root(?:[/]|\b)|[A-Za-z]:\\Users\\[^\\\s]+)/;
const SESSION_ID_RE = /\bses_[A-Za-z0-9]{6,}\b/;

function error(message) {
  errors.push(message);
}
function ok(name, detail = '') {
  console.log(`ok    ${name}${detail ? `  ${detail}` : ''}`);
}
function fail(name, count) {
  console.log(`FAIL  ${name}  ${count} issue(s)`);
}
function group(name, fn, detail = '') {
  const before = errors.length;
  try {
    const summary = fn();
    if (errors.length === before) ok(name, typeof summary === 'string' ? summary : detail);
    else fail(name, errors.length - before);
  } catch (caught) {
    error(`${name}: ${caught.message}`);
    fail(name, 1);
  }
}
function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function rel(file) {
  return path.relative(ROOT, file);
}
function walk(dir, visit, skip = new Set()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, visit, skip);
    else if (entry.isFile()) visit(full);
  }
}
function requireFile(file, label) {
  if (!fs.existsSync(file)) error(`${label} missing at ${rel(file)}`);
}
function findGit(current) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (entry.name === '.git') return path.join(current, entry.name);
    if (entry.isDirectory()) {
      const found = findGit(path.join(current, entry.name));
      if (found) return found;
    }
  }
  return null;
}

// package.json and script targets
group('package.json', () => {
  const file = path.join(ROOT, 'package.json');
  requireFile(file, 'package.json');
  if (!fs.existsSync(file)) return;
  const pkg = readJSON(file);
  if (pkg.private !== true) error('package.json: "private" must be true');
  if (pkg.type !== 'module') error('package.json: "type" must be "module"');
  const scripts = pkg.scripts ?? {};
  for (const name of ['test', 'dry', 'all', 'doctor', 'validate', 'new', 'from-session']) {
    if (typeof scripts[name] !== 'string') {
      error(`package.json: missing script "${name}"`);
      continue;
    }
    const match = scripts[name].match(/^(?:node|bash)\s+(\S+)/);
    if (!match) {
      error(`package.json: script "${name}" does not start with node/bash: ${scripts[name]}`);
    } else if (!fs.existsSync(path.join(ROOT, match[1]))) {
      error(`package.json: script "${name}" references missing ${match[1]}`);
    }
  }
});

// executable scripts
group('scripts', () => {
  for (const name of ['run.sh', 'install.sh']) {
    const file = path.join(ROOT, 'scripts', name);
    requireFile(file, `scripts/${name}`);
    if (!fs.existsSync(file)) continue;
    if ((fs.statSync(file).mode & 0o111) === 0) error(`scripts/${name} is not executable`);
  }
  for (const name of ['doctor.mjs', 'validate.mjs', 'from-session.mjs', 'new-case.mjs']) {
    requireFile(path.join(ROOT, 'scripts', name), `scripts/${name}`);
  }
});

// cases
group('cases', () => {
  const dir = path.join(RUNNER, 'cases');
  requireFile(dir, 'runner/cases');
  if (!fs.existsSync(dir)) return;
  // Top-level files only. runner/cases/drafts/ holds intentionally incomplete
  // captures and is never validated as a runnable case.
  const files = fs.readdirSync(dir).filter((file) => file.endsWith('.json')).sort();
  if (files.length === 0) error('runner/cases: no case files');
  const ids = new Set();
  for (const file of files) {
    const full = path.join(dir, file);
    const label = rel(full);
    let data;
    try {
      data = readJSON(full);
    } catch (caught) {
      error(`${label}: invalid JSON: ${caught.message}`);
      continue;
    }
    for (const key of ['id', 'agent', 'prompt', 'fixture']) {
      if (typeof data[key] !== 'string' || data[key].trim() === '') {
        error(`${label}: "${key}" must be a non-empty string`);
      }
    }
    if (!data.expect || typeof data.expect !== 'object' || Array.isArray(data.expect)) {
      error(`${label}: "expect" must be an object`);
    }
    if (typeof data.id === 'string') {
      if (data.id !== file.slice(0, -'.json'.length)) {
        error(`${label}: id "${data.id}" must equal the file stem`);
      }
      if (ids.has(data.id)) error(`${label}: duplicate id "${data.id}"`);
      ids.add(data.id);
    }
    if ('source_session' in data) {
      error(`${label}: "source_session" is draft-only; remove it from a runnable case`);
    }
    if ('observed' in data) {
      error(`${label}: "observed" is draft-only; remove it from a runnable case`);
    }
    if (typeof data.timeout_ms === 'number' && data.timeout_ms <= 0) {
      error(`${label}: "timeout_ms" must be positive`);
    }
    if (typeof data.fixture === 'string') {
      if (data.fixture === 'TODO') {
        error(`${label}: fixture is still "TODO"`);
      } else if (path.isAbsolute(data.fixture)) {
        error(`${label}: fixture must be a relative name`);
      } else if (data.fixture.includes('..')) {
        error(`${label}: fixture must not contain ".."`);
      } else {
        const fixture = path.join(RUNNER, 'fixtures', data.fixture);
        if (!fs.existsSync(fixture) || !fs.statSync(fixture).isDirectory()) {
          error(`${label}: fixture "${data.fixture}" not found`);
        }
      }
    }
    if (data.expect && typeof data.expect === 'object' && !Array.isArray(data.expect)) {
      const changed = data.expect.files_changed;
      const globs = typeof changed === 'string' ? [changed] : changed;
      if (globs !== undefined) {
        if (!Array.isArray(globs)) {
          error(`${label}: expect.files_changed must be an array of globs`);
        } else {
          for (const [index, glob] of globs.entries()) {
            if (typeof glob !== 'string' || glob.trim() === '') {
              error(`${label}: expect.files_changed[${index}] must be a non-empty glob`);
            } else if (path.isAbsolute(glob)) {
              error(`${label}: expect.files_changed[${index}] must be relative`);
            } else if (glob.includes('..')) {
              error(`${label}: expect.files_changed[${index}] must not contain ".."`);
            }
          }
        }
      }
    }
    for (const [index, test] of (data.expect?.tests ?? []).entries()) {
      if (typeof test?.command !== 'string' || test.command.trim() === '') {
        error(`${label}: expect.tests[${index}].command must be a non-empty string`);
      }
    }
    for (const scorer of Object.keys(data.judges ?? {})) {
      if (!scorerNames.includes(scorer)) error(`${label}: unknown judge scorer "${scorer}"`);
      const threshold = data.judges[scorer]?.threshold;
      if (typeof threshold !== 'number' || threshold < 0 || threshold > 1) {
        error(`${label}: judge "${scorer}" needs a threshold in 0..1`);
      }
    }
  }
  return `${files.length} cases`;
});

// fixtures
group('fixtures', () => {
  const dir = path.join(RUNNER, 'fixtures');
  requireFile(dir, 'runner/fixtures');
  if (!fs.existsSync(dir)) return;
  const fixtures = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name));
  for (const fixture of fixtures) {
    const git = findGit(fixture);
    if (git) error(`${rel(git)}: fixture must not ship .git`);
  }
  return `${fixtures.length} fixtures`;
});

// templates
group('templates', () => {
  for (const name of ['fixture', 'fixture-delegation']) {
    const dir = path.join(ROOT, 'templates', name);
    requireFile(dir, `templates/${name}`);
    if (!fs.existsSync(dir)) continue;
    if (!fs.statSync(dir).isDirectory()) {
      error(`templates/${name} is not a directory`);
      continue;
    }
    const git = findGit(dir);
    if (git) error(`${rel(git)}: template must not ship .git`);
  }
  return '2 templates';
});

// calibration
group('calibration', () => {
  const dir = path.join(RUNNER, 'calibration');
  requireFile(dir, 'runner/calibration');
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((file) => file.endsWith('.json')).sort();
  const labelsByScorer = new Map();
  for (const file of files) {
    const full = path.join(dir, file);
    const label = rel(full);
    let data;
    try {
      data = readJSON(full);
    } catch (caught) {
      error(`${label}: invalid JSON: ${caught.message}`);
      continue;
    }
    if (!scorerNames.includes(data.scorer)) {
      error(`${label}: unknown scorer "${data.scorer}"`);
      continue;
    }
    if (!['good', 'bad'].includes(data.label)) {
      error(`${label}: label must be "good" or "bad"`);
    }
    if (typeof data.threshold !== 'number' || data.threshold < 0 || data.threshold > 1) {
      error(`${label}: threshold must be in 0..1`);
    }
    if (!data.input || typeof data.input !== 'object') {
      error(`${label}: "input" must be an object`);
    }
    if (!labelsByScorer.has(data.scorer)) labelsByScorer.set(data.scorer, new Set());
    labelsByScorer.get(data.scorer).add(data.label);
  }
  for (const scorer of scorerNames) {
    const labels = labelsByScorer.get(scorer);
    if (!labels) error(`calibration: no examples for scorer "${scorer}"`);
    else {
      if (!labels.has('good')) error(`calibration: scorer "${scorer}" has no good example`);
      if (!labels.has('bad')) error(`calibration: scorer "${scorer}" has no bad example`);
    }
  }
  return `${files.length} examples`;
});

// eval-judge agent
group('agents', () => {
  const file = path.join(ROOT, 'agents', 'eval-judge.md');
  requireFile(file, 'agents/eval-judge.md');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const action of ['edit', 'shell', 'subagent']) {
    const pattern = new RegExp(`action:\\s*${action}\\s*[\\s\\S]{0,80}?effect:\\s*deny`);
    if (!pattern.test(text)) {
      error(`agents/eval-judge.md: missing wildcard deny for "${action}"`);
    }
  }
  return 'read-only contract';
});

// required docs
group('docs', () => {
  for (const name of ['README.md', 'docs/baseline.md', 'docs/plan.md', 'docs/factory.md']) {
    requireFile(path.join(ROOT, name), name);
  }
});

// portability
group('portability', () => {
  // Split the tokens so this file does not match its own portability scan.
  const forbidden = new RegExp(
    ['z' + 'ur', 'data' + 'emergencia', 'f' + 'md', 'q' + 'r/', 'sc' + 'aem'].join('|'),
  );
  const skip = new Set(['reports', 'node_modules', '.git', 'work', 'drafts', 'harness-guard.log']);
  const files = [];
  for (const name of ['.gitignore', 'README.md', 'package.json']) {
    const file = path.join(ROOT, name);
    if (fs.existsSync(file)) files.push(file);
  }
  for (const dirName of ['runner', 'agents', 'scripts', 'docs', 'templates', 'guardrails']) {
    const dir = path.join(ROOT, dirName);
    if (!fs.existsSync(dir)) continue;
    try {
      walk(dir, (file) => files.push(file), skip);
    } catch (caught) {
      error(`${dirName}: ${caught.message}`);
    }
  }
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    text.split('\n').forEach((content, index) => {
      const match = content.match(forbidden);
      if (match) error(`${rel(file)}:${index + 1}: contains "${match[0]}"`);
    });
  }
  return `${files.length} files`;
});

// local state and provenance
group('local state', () => {
  for (const dir of [path.join(RUNNER, 'reports'), path.join(RUNNER, 'cases', 'drafts')]) {
    if (!fs.existsSync(dir)) continue;
    const artifacts = [];
    walk(dir, (file) => artifacts.push(file));
    for (const file of artifacts) {
      error(`${rel(file)}: generated artifact must live under $AGENT_EVALS_STATE`);
    }
  }
  for (const file of [
    path.join(ROOT, 'guardrails', 'harness-guard.log'),
    path.join(ROOT, 'AGENTS.md.bak'),
  ]) {
    if (fs.existsSync(file)) {
      error(`${rel(file)}: local artifact must live under $AGENT_EVALS_STATE`);
    }
  }

  const skip = new Set(['reports', 'node_modules', '.git', 'work', 'drafts', 'harness-guard.log']);
  const files = [];
  for (const name of ['.gitignore', 'README.md', 'package.json']) {
    const file = path.join(ROOT, name);
    if (fs.existsSync(file)) files.push(file);
  }
  for (const dirName of ['runner', 'agents', 'scripts', 'docs', 'templates', 'guardrails']) {
    const dir = path.join(ROOT, dirName);
    if (!fs.existsSync(dir)) continue;
    walk(dir, (file) => files.push(file), skip);
  }
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    text.split('\n').forEach((content, index) => {
      const home = content.match(ABSOLUTE_HOME_RE);
      if (home) {
        error(`${rel(file)}:${index + 1}: absolute home path "${home[0]}"`);
      }
      const session = content.match(SESSION_ID_RE);
      if (session) {
        error(`${rel(file)}:${index + 1}: session id "${session[0]}" is local provenance`);
      }
    });
  }
  return `${files.length} files, no repo-local state`;
});

if (errors.length > 0) {
  console.error('');
  for (const message of errors) console.error(`  - ${message}`);
  console.error(`\nvalidate: FAILED (${errors.length} issue(s))`);
  process.exit(1);
}
console.log('\nvalidate: ok');
