#!/usr/bin/env node
/**
 * Agent Evals runner — Phase 1 core (zero external dependencies).
 *
 * Usage:
 *   node run.mjs --case <id> [--model <provider/model>] [--agent <id>]
 *                [--report <path>] [--keep] [--judge|--no-judge]
 *   node run.mjs --all [--model ...] [--agent ...] [--report <dir>] [--keep]
 *                [--judge|--no-judge]
 *   node run.mjs --dry-run [--report <path>] [--keep]
 *   node run.mjs --self-test
 *   node run.mjs --self-test-fail [--report <path>]
 *
 * Judges: a case opts in with `"judges": {"<scorer>": {"threshold": 0.6}}`.
 * `--all` judges by default; `--case` does not, unless `--judge` is passed.
 * `--no-judge` always disables them. `--dry-run`, `--self-test`, and
 * `--self-test-fail` never call a judge. Hard checks remain authoritative:
 * judges are recorded under `judges` and never change `passed`, `failed_checks`,
 * or the exit code. Missing judge configuration is reported as `skipped`.
 *
 * Database: OPENCODE_DB, else ~/.local/share/opencode/opencode.db. It is opened
 * read-only. The run itself is `opencode run --agent <agent> --model <model>
 * --format json --archived --title <unique-title> <prompt>` with cwd set to a
 * throwaway copy of the fixture. The parent session is resolved from
 * `session_v2` by that unique title (directory fallback), never from stdout.
 *
 * ---------------------------------------------------------------------------
 * Case schema: cases/<id>.json
 * ---------------------------------------------------------------------------
 * {
 *   "id": "e1-delegation",              // required; must match the file stem
 *   "agent": "plan-orchestrator",       // required unless --agent is passed
 *   "model": "opencode-go/...",         // optional; --model overrides it
 *   "timeout_ms": 600000,               // optional hard wall-clock limit (default 10 min)
 *   "fixture": "two-phase-plan",        // required; directory under fixtures/
 *   "prompt": "…",                      // required; user message sent verbatim
 *   "expect": {                         // every present key becomes a required check
 *     "parent_code_edits_max": 0,       // edit tool calls made by the parent
 *     "parent_shell_max": 0,            // shell tool calls made by the parent
 *     "subagents_min": 2,               // direct child sessions under the parent
 *     "files_changed": ["src/**", "test/**"],   // allowlist globs; anything else fails
 *     "tests": [                        // shell commands run in the workspace
 *       {"command": "pnpm test", "timeout_ms": 120000}
 *     ],
 *     "max_lookups_before_first_edit": 4,
 *     "wall_time_max_s": 300
 *   }
 * }
 *
 * Check semantics:
 *   parent_code_edits_max         write/edit/apply-patch tools plus shell writes.
 *   parent_shell_max              shell/bash/terminal tools.
 *   subagents_min                 child sessions where parent_id = parent session.
 *   files_changed                 changed paths vs the baseline git commit.
 *   tests                         each command must exit 0 inside the workspace.
 *   max_lookups_before_first_edit read/grep/glob/ls/web and read-only shell calls
 *                                 before the parent's first edit; a run with no
 *                                 edit counts its lookups against the limit.
 *   wall_time_max_s               process wall clock for the parent run.
 *
 * Report: JSON at --report, else $AGENT_EVALS_STATE/reports/<case>-<timestamp>.json.
 * Exit codes: 0 all required checks passed, 1 a check failed, 2 usage/config error.
 *
 * --dry-run copies self-test/fixture, applies a synthetic child edit, builds a
 * synthetic parent/child message trace through the same extractor used for the
 * database, scores it, writes a report, and never invokes a model.
 *
 * --self-test runs --dry-run and --self-test-fail as child processes and asserts
 * that the pass case exits 0 and the failing case exits 1 with the failed check
 * named in its report. --self-test-fail is an intentional red run.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createWorkspace,
  changedFiles,
  workspaceStatus,
  workspaceDiffStat,
  workspaceDiff,
  destroyWorkspace,
} from './lib/workspace.mjs';
import {
  runAgent,
  makeTitle,
  resolveParentSession,
} from './lib/run-agent.mjs';
import {
  openDatabase,
  traceSession,
  assembleTrace,
} from './lib/trace.mjs';
import { scoreRun, buildJudgeSource, composeCaseOutcome } from './lib/score.mjs';
import {
  runJudges,
  resolveJudgeConfig,
  publicJudgeConfig,
} from './lib/judge.mjs';
import { getScorer, listScorers } from './lib/scorers/index.mjs';
import { REPORTS_DIR } from './lib/state.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = path.dirname(SCRIPT_PATH);
const CASES_DIR = path.join(ROOT, 'cases');
const FIXTURES_DIR = path.join(ROOT, 'fixtures');
const SELF_TEST_FIXTURE = path.join(ROOT, 'self-test', 'fixture');
const DB_PATH =
  process.env.OPENCODE_DB ??
  path.join(os.homedir(), '.local/share/opencode/opencode.db');

const FIXED_SUM = `export function sum(a, b) {\n  return a + b;\n}\n`;

function usage() {
  return `Agent Evals runner

Usage:
  node run.mjs --case <id> [--model <provider/model>] [--agent <id>]
               [--report <path>] [--keep] [--judge|--no-judge]
  node run.mjs --all [--model <provider/model>] [--agent <id>]
               [--report <dir>] [--keep] [--judge|--no-judge]
  node run.mjs --dry-run [--report <path>] [--keep]
  node run.mjs --self-test
  node run.mjs --self-test-fail [--report <path>]

Judges:
  --all enables judges; --case disables them unless --judge is passed.
  --no-judge always disables them. Dry-run and self-test never call a judge.
  Available scorers: ${listScorers()
    .map((scorer) => scorer.name)
    .join(', ')}

Cases live in ${CASES_DIR}
Fixtures live in ${FIXTURES_DIR}
Reports default to ${REPORTS_DIR}
Database: OPENCODE_DB or ${DB_PATH}
`;
}

function parseArgs(argv) {
  const options = {
    caseId: null,
    all: false,
    model: null,
    agent: null,
    report: null,
    keep: false,
    dryRun: false,
    selfTest: false,
    selfTestFail: false,
    judge: null,
    help: false,
  };

  const valueFor = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case '--case':
        options.caseId = valueFor(index, argument);
        index += 1;
        break;
      case '--all':
        options.all = true;
        break;
      case '--model':
        options.model = valueFor(index, argument);
        index += 1;
        break;
      case '--agent':
        options.agent = valueFor(index, argument);
        index += 1;
        break;
      case '--report':
        options.report = valueFor(index, argument);
        index += 1;
        break;
      case '--keep':
        options.keep = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--self-test':
        options.selfTest = true;
        break;
      case '--self-test-fail':
        options.selfTestFail = true;
        break;
      case '--judge':
        if (options.judge === false) {
          throw new Error('--judge and --no-judge are mutually exclusive');
        }
        options.judge = true;
        break;
      case '--no-judge':
        if (options.judge === true) {
          throw new Error('--judge and --no-judge are mutually exclusive');
        }
        options.judge = false;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }

  return options;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function ensureDirectory(directory) {
  await fs.mkdir(directory, { recursive: true });
  return directory;
}

async function resolveReportTarget(options, defaultName) {
  if (options.report) {
    const target = path.resolve(process.cwd(), options.report);
    await ensureDirectory(path.dirname(target));
    return target;
  }
  await ensureDirectory(REPORTS_DIR);
  return path.join(REPORTS_DIR, `${defaultName}.json`);
}

async function writeReport(target, report) {
  await fs.writeFile(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

async function listCaseIds() {
  try {
    const entries = await fs.readdir(CASES_DIR, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.slice(0, -'.json'.length))
      .sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function loadCase(id, options) {
  const file = path.join(CASES_DIR, `${id}.json`);
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    throw new Error(`case not found: ${id} (${file})`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`case ${id} is not valid JSON: ${error.message}`);
  }

  if (parsed.id !== undefined && parsed.id !== id) {
    throw new Error(`case ${id} declares id "${parsed.id}"`);
  }
  if (!parsed.fixture) throw new Error(`case ${id} has no fixture`);
  if (!parsed.prompt) throw new Error(`case ${id} has no prompt`);
  if (!parsed.expect || typeof parsed.expect !== 'object') {
    throw new Error(`case ${id} has no expect object`);
  }

  const agent = options.agent ?? parsed.agent;
  if (!agent) {
    throw new Error(`case ${id} has no agent and --agent was not provided`);
  }

  const expect = { ...parsed.expect };
  if (typeof expect.files_changed === 'string') {
    expect.files_changed = [expect.files_changed];
  }
  if (expect.files_changed !== undefined && !Array.isArray(expect.files_changed)) {
    throw new Error(`case ${id} expect.files_changed must be an array of globs`);
  }
  if (expect.tests !== undefined && !Array.isArray(expect.tests)) {
    expect.tests = [expect.tests];
  }
  for (const key of [
    'parent_code_edits_max',
    'parent_shell_max',
    'subagents_min',
    'max_lookups_before_first_edit',
    'wall_time_max_s',
  ]) {
    if (expect[key] !== undefined && !Number.isFinite(Number(expect[key]))) {
      throw new Error(`case ${id} expect.${key} must be a number`);
    }
  }
  for (const test of expect.tests ?? []) {
    if (typeof test === 'string') continue;
    if (!test || typeof test.command !== 'string') {
      throw new Error(`case ${id} expect.tests entries need a command string`);
    }
  }

  const judges = {};
  if (parsed.judges !== undefined) {
    if (!parsed.judges || typeof parsed.judges !== 'object' || Array.isArray(parsed.judges)) {
      throw new Error(`case ${id} judges must be an object of scorer names`);
    }
    for (const [scorerName, spec] of Object.entries(parsed.judges)) {
      getScorer(scorerName); // throws for an unknown scorer name
      if (spec !== null && typeof spec !== 'object') {
        throw new Error(`case ${id} judges.${scorerName} must be an object`);
      }
      const threshold = Number(spec?.threshold ?? 0.6);
      if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
        throw new Error(
          `case ${id} judges.${scorerName}.threshold must be a number in 0..1`,
        );
      }
      judges[scorerName] = { threshold };
    }
  }

  const timeoutMs = Number(parsed.timeout_ms ?? 600000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`case ${id} timeout_ms must be a positive number`);
  }

  return {
    ...parsed,
    id,
    agent,
    model: options.model ?? parsed.model ?? null,
    timeout_ms: timeoutMs,
    expect,
    judges,
  };
}

function publicRun(run) {
  const { started_at_ms: _startedAtMs, stdout, stderr, ...rest } = run;
  const keepTail = (text, maxChars) => {
    const value = String(text ?? '');
    return value.length <= maxChars ? value : value.slice(-maxChars);
  };
  return {
    ...rest,
    stdout_tail: keepTail(stdout, 8000),
    stderr_tail: keepTail(stderr, 8000),
  };
}

function checkLine(check) {
  const expected = JSON.stringify(check.expected);
  const actual = JSON.stringify(check.actual);
  return `${check.pass ? 'PASS' : 'FAIL'} ${check.name} expected=${expected} actual=${actual}`;
}

function printCaseSummary(report) {
  const parent = report.session?.parent;
  const children = report.session?.children ?? [];
  const parentEdits = parent
    ? parent.tool_calls.filter((call) =>
        ['write', 'edit', 'apply_patch', 'patch'].includes(String(call.name).toLowerCase()),
      ).length
    : 0;
  const parentShell = parent
    ? parent.tool_calls.filter((call) =>
        ['shell', 'bash', 'terminal'].includes(String(call.name).toLowerCase()),
      ).length
    : 0;

  console.log('');
  console.log(`case ${report.case.id}: ${report.passed ? 'PASS' : 'FAIL'}`);
  console.log(`  report: ${report.report_path}`);
  console.log(
    `  parent: ${parent?.tool_count ?? 0} tool calls (${parentEdits} edits, ${parentShell} shell)`,
  );
  console.log(
    `  children: ${children.length} sessions, ${children.reduce((sum, child) => sum + child.tool_count, 0)} tool calls`,
  );
  console.log(`  files changed: ${report.workspace.files_changed.join(', ') || '(none)'}`);
  console.log(
    `  wall: ${(Number(report.run?.duration_ms ?? 0) / 1000).toFixed(2)}s, tokens: ${
      report.session?.totals?.tokens?.total ?? 0
    }`,
  );
  for (const check of report.score.checks) {
    console.log(`  ${checkLine(check)}`);
  }
  const judgeEntries = Object.values(report.judges ?? {});
  for (const judge of judgeEntries) {
    if (judge.status === 'ok') {
      console.log(
        `  judge ${judge.name}: ${Number(judge.score).toFixed(2)} (${
          judge.advisory_pass ? 'advisory pass' : 'advisory fail'
        }, threshold ${Number(judge.threshold).toFixed(2)}, model ${judge.model})`,
      );
      console.log(`    rationale: ${judge.rationale}`);
    } else {
      console.log(
        `  judge ${judge.name}: ${judge.status}${
          judge.error ? ` (${judge.error})` : ''
        }`,
      );
    }
  }
  if (!report.passed) {
    console.log(`  FAILED CHECKS: ${report.failed_checks.join(', ')}`);
  }
}

async function executeCase(caseDefinition, options) {
  const fixtureDir = path.join(FIXTURES_DIR, caseDefinition.fixture);
  const workspace = await createWorkspace({
    fixtureDir,
    label: caseDefinition.id,
  });

  try {
    const title = makeTitle(caseDefinition.id);
    const run = await runAgent({
      agent: caseDefinition.agent,
      model: caseDefinition.model,
      prompt: caseDefinition.prompt,
      cwd: workspace.path,
      timeoutMs: caseDefinition.timeout_ms,
      title,
      caseId: caseDefinition.id,
    });

    const lookup = await resolveParentSession({
      dbPath: DB_PATH,
      title,
      cwd: workspace.path,
      startedAtMs: run.started_at_ms,
    });

    let trace = null;
    let traceError = lookup.error ?? null;
    if (lookup.session) {
      const db = await openDatabase(DB_PATH);
      try {
        trace = traceSession(db, lookup.session.id);
      } finally {
        db.close();
      }
      if (!trace) {
        traceError = `session ${lookup.session.id} was found but produced no trace`;
      }
    }

    const files = await changedFiles(workspace);
    const status = await workspaceStatus(workspace);
    const diffStat = await workspaceDiffStat(workspace);
    const diff = await workspaceDiff(workspace);

    const scoringTrace = trace ?? {
      parent: { tool_calls: [], duration_ms: run.duration_ms },
      children: [],
    };
    const score = await scoreRun({
      expect: caseDefinition.expect,
      trace: scoringTrace,
      workspace: { path: workspace.path, files_changed: files },
      wallTimeMs: run.duration_ms,
    });

    const infrastructureChecks = [
      {
        name: 'agent_exit',
        pass:
          run.exit_code === 0 && !run.timed_out && !run.spawn_error,
        expected: 'exit 0 before the hard timeout',
        actual: {
          exit_code: run.exit_code,
          timed_out: run.timed_out,
          spawn_error: run.spawn_error,
        },
      },
      {
        name: 'session_found',
        pass: Boolean(trace),
        expected: `session_v2 row for title ${title}`,
        actual: {
          session_id: lookup.session?.id ?? null,
          matched_by: lookup.matched_by ?? null,
          error: lookup.session ? traceError : lookup.error,
        },
      },
    ];

    const checks = [...infrastructureChecks, ...score.checks];

    const judgeEnabled = Boolean(options.judgeEnabled);
    let judgeConfig = null;
    let judges = {};
    if (judgeEnabled) {
      judgeConfig = resolveJudgeConfig(options.judgeOverrides ?? {});
      if (Object.keys(caseDefinition.judges ?? {}).length > 0) {
        const judgeSource = await buildJudgeSource({
          caseDefinition,
          trace,
          workspace: { path: workspace.path, files_changed: files },
          score,
        });
        judges = await runJudges({
          judges: caseDefinition.judges,
          source: judgeSource,
          config: judgeConfig,
        });
      }
    }

    const outcome = composeCaseOutcome({ checks, judges });

    return {
      schema_version: 1,
      mode: 'case',
      generated_at: new Date().toISOString(),
      case: caseDefinition,
      run: {
        ...publicRun(run),
        session_lookup: {
          session_id: lookup.session?.id ?? null,
          matched_by: lookup.matched_by ?? null,
          error: lookup.session ? null : lookup.error,
        },
      },
      session: trace,
      workspace: {
        path: workspace.path,
        baseline: workspace.baseline,
        kept: options.keep,
        files_changed: files,
        status,
        diff_stat: diffStat,
        diff,
      },
      score: {
        ...score,
        checks,
        passed: outcome.passed,
        failed_checks: outcome.failed_checks,
      },
      passed: outcome.passed,
      failed_checks: outcome.failed_checks,
      judges: outcome.judges,
      judge_config: publicJudgeConfig(judgeConfig),
    };
  } finally {
    if (!options.keep) await destroyWorkspace(workspace);
  }
}

/* ------------------------------------------------------------------------- */
/* Synthetic dry-run                                                          */
/* ------------------------------------------------------------------------- */

function toolPart({ id, name, input, output = '', exitCode = null }) {
  return {
    type: 'tool',
    id,
    name,
    state: {
      status: 'completed',
      input,
      content: [{ type: 'text', text: output }],
      metadata: exitCode === null ? {} : { exit: exitCode },
    },
    time: { created: 1, completed: 2 },
  };
}

function assistantMessage({ id, seq, time, content }) {
  return {
    id,
    type: 'assistant',
    seq,
    time_created: time,
    time_updated: time + 10,
    data: { content },
  };
}

/**
 * Build a synthetic trace through the same `extractToolCalls` / `assembleTrace`
 * path used for database rows. The fixture edit is applied by the caller, so the
 * artifact and the trajectory describe the same child work.
 */
function buildSyntheticTrace({ workspacePath, failing }) {
  const started = Date.now() - 12000;
  const parentId = 'eval_synthetic_parent';
  const model = JSON.stringify({
    providerID: 'synthetic',
    id: 'synthetic-runner',
    variant: 'dry-run',
  });

  const parentRow = {
    id: parentId,
    parent_id: null,
    title: 'eval dry-run parent',
    directory: workspacePath,
    agent: 'plan-orchestrator',
    model,
    time_created: started,
    time_updated: started + 12000,
    tokens_input: 1200,
    tokens_output: 80,
    tokens_reasoning: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    cost: 0,
  };

  const childOneRow = {
    id: 'eval_synthetic_child1',
    parent_id: parentId,
    title: 'eval dry-run child one',
    directory: workspacePath,
    agent: 'general',
    model,
    time_created: started + 1000,
    time_updated: started + 7000,
    tokens_input: 900,
    tokens_output: 120,
    tokens_reasoning: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    cost: 0,
  };

  const childTwoRow = {
    id: 'eval_synthetic_child2',
    parent_id: parentId,
    title: 'eval dry-run child two',
    directory: workspacePath,
    agent: 'general',
    model,
    time_created: started + 7000,
    time_updated: started + 11000,
    tokens_input: 800,
    tokens_output: 90,
    tokens_reasoning: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    cost: 0,
  };

  const parentSecondParts = [
    toolPart({
      id: 'call_parent_read_source',
      name: 'read',
      input: { filePath: 'src/sum.mjs' },
      output: 'export function sum(a, b) { return a - b; }',
    }),
  ];
  if (failing) {
    parentSecondParts.push(
      toolPart({
        id: 'call_parent_shell',
        name: 'shell',
        input: { command: 'git status --short' },
        output: '',
        exitCode: 0,
      }),
    );
  }

  const messagesBySession = new Map([
    [
      parentId,
      [
        assistantMessage({
          id: 'msg_parent_1',
          seq: 1,
          time: started,
          content: [
            { type: 'reasoning', text: 'Synthetic reasoning is not a tool call.' },
            { type: 'text', text: 'Delegating one session per phase.' },
            toolPart({
              id: 'call_parent_read_readme',
              name: 'read',
              input: { filePath: 'README.md' },
              output: 'Self-test fixture for the Agent Evals runner.',
            }),
          ],
        }),
        assistantMessage({
          id: 'msg_parent_2',
          seq: 2,
          time: started + 500,
          content: parentSecondParts,
        }),
      ],
    ],
    [
      childOneRow.id,
      [
        assistantMessage({
          id: 'msg_child1_1',
          seq: 1,
          time: started + 1000,
          content: [
            toolPart({
              id: 'call_child1_read',
              name: 'read',
              input: { filePath: 'src/sum.mjs' },
              output: 'export function sum(a, b) { return a - b; }',
            }),
          ],
        }),
        assistantMessage({
          id: 'msg_child1_2',
          seq: 2,
          time: started + 2000,
          content: [
            toolPart({
              id: 'call_child1_edit',
              name: 'edit',
              input: {
                filePath: 'src/sum.mjs',
                oldString: 'return a - b;',
                newString: 'return a + b;',
              },
              output: 'Edit applied successfully.',
            }),
          ],
        }),
        assistantMessage({
          id: 'msg_child1_3',
          seq: 3,
          time: started + 3000,
          content: [
            toolPart({
              id: 'call_child1_test',
              name: 'shell',
              input: { command: 'node --test' },
              output: '# tests 1\n# pass 1\n# fail 0',
              exitCode: 0,
            }),
          ],
        }),
      ],
    ],
    [
      childTwoRow.id,
      [
        assistantMessage({
          id: 'msg_child2_1',
          seq: 1,
          time: started + 7000,
          content: [
            toolPart({
              id: 'call_child2_read',
              name: 'read',
              input: { filePath: 'test/sum.test.mjs' },
              output: "import test from 'node:test';",
            }),
          ],
        }),
        assistantMessage({
          id: 'msg_child2_2',
          seq: 2,
          time: started + 8000,
          content: [
            toolPart({
              id: 'call_child2_test',
              name: 'shell',
              input: { command: 'node --test' },
              output: '# tests 1\n# pass 1\n# fail 0',
              exitCode: 0,
            }),
          ],
        }),
      ],
    ],
  ]);

  return assembleTrace({
    parentRow,
    childRows: [childOneRow, childTwoRow],
    messagesBySession,
  });
}

async function runSynthetic({ failing, options }) {
  const mode = failing ? 'self-test-fail' : 'dry-run';
  const workspace = await createWorkspace({
    fixtureDir: SELF_TEST_FIXTURE,
    label: mode,
  });

  let report;
  try {
    // The synthetic child's edit: make the fixture test pass.
    await fs.writeFile(path.join(workspace.path, 'src', 'sum.mjs'), FIXED_SUM, 'utf8');

    const files = await changedFiles(workspace);
    const status = await workspaceStatus(workspace);
    const diffStat = await workspaceDiffStat(workspace);
    const diff = await workspaceDiff(workspace);

    const trace = buildSyntheticTrace({
      workspacePath: workspace.path,
      failing,
    });

    const expect = {
      parent_code_edits_max: 0,
      parent_shell_max: 0,
      subagents_min: 2,
      files_changed: ['src/sum.mjs'],
      tests: [{ command: 'node --test', timeout_ms: 60000 }],
      max_lookups_before_first_edit: 4,
      wall_time_max_s: 60,
    };

    const score = await scoreRun({
      expect,
      trace,
      workspace: { path: workspace.path, files_changed: files },
      wallTimeMs: 12000,
    });

    report = {
      schema_version: 1,
      mode,
      synthetic: true,
      generated_at: new Date().toISOString(),
      case: {
        id: failing ? 'self-test-fail' : 'self-test',
        agent: 'plan-orchestrator',
        model: 'synthetic/synthetic-runner#dry-run',
        timeout_ms: 120000,
        fixture: 'self-test/fixture',
        prompt: 'synthetic trace; no model is invoked',
        expect,
      },
      run: {
        synthetic: true,
        agent: 'plan-orchestrator',
        model: 'synthetic/synthetic-runner#dry-run',
        started_at: new Date(Date.now() - 12000).toISOString(),
        finished_at: new Date().toISOString(),
        duration_ms: 12000,
        exit_code: 0,
        timed_out: false,
        spawn_error: null,
        model_invoked: false,
      },
      session: trace,
      workspace: {
        path: workspace.path,
        baseline: workspace.baseline,
        kept: options.keep,
        files_changed: files,
        status,
        diff_stat: diffStat,
        diff,
      },
      score: {
        ...score,
        checks: score.checks,
        passed: score.passed,
        failed_checks: score.failed_checks,
      },
      passed: score.passed,
      failed_checks: score.failed_checks,
    };
  } finally {
    if (!options.keep) await destroyWorkspace(workspace);
  }

  const target = await resolveReportTarget(options, `${mode}-${timestamp()}`);
  report.report_path = target;
  await writeReport(target, report);

  console.log('');
  console.log(`${mode}: ${report.passed ? 'PASS' : 'FAIL'}`);
  console.log(`  report: ${target}`);
  console.log(
    `  parent: tool_calls=${report.session.parent.tool_count}, edits=${
      report.score.checks.find((check) => check.name === 'parent_code_edits_max')
        ?.actual ?? 0
    }, shell=${
      report.score.checks.find((check) => check.name === 'parent_shell_max')?.actual ?? 0
    }`,
  );
  console.log(
    `  children: ${report.session.children.length} (tool_calls=${report.session.children.reduce(
      (sum, child) => sum + child.tool_count,
      0,
    )})`,
  );
  console.log(`  files changed: ${report.workspace.files_changed.join(', ') || '(none)'}`);
  for (const check of report.score.checks) {
    console.log(`  ${checkLine(check)}`);
  }
  if (!report.passed) {
    console.log(`  FAILED CHECKS: ${report.failed_checks.join(', ')}`);
  }
  if (options.keep) console.log(`  kept workspace: ${report.workspace.path}`);

  return report.passed ? 0 : 1;
}

async function readReport(file) {
  const raw = await fs.readFile(file, 'utf8');
  return JSON.parse(raw);
}

async function runSelfTest() {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-evals-selftest-'));
  const positiveReport = path.join(scratch, 'positive.json');
  const negativeReport = path.join(scratch, 'negative.json');

  const runChild = (args) =>
    spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
      encoding: 'utf8',
      timeout: 180000,
      maxBuffer: 20 * 1024 * 1024,
    });

  const positive = runChild([
    '--dry-run',
    '--report',
    positiveReport,
  ]);
  const negative = runChild([
    '--self-test-fail',
    '--report',
    negativeReport,
  ]);

  let positiveJson = null;
  let negativeJson = null;
  let readError = null;
  try {
    positiveJson = await readReport(positiveReport);
    negativeJson = await readReport(negativeReport);
  } catch (error) {
    readError = error.message;
  }

  const childOne = positiveJson?.session?.children?.find(
    (child) => child.id === 'eval_synthetic_child1',
  );
  const positiveOk =
    positive.status === 0 &&
    positiveJson?.passed === true &&
    (positiveJson?.failed_checks?.length ?? -1) === 0 &&
    positiveJson?.session?.parent?.tool_count === 2 &&
    (positiveJson?.session?.children?.length ?? -1) === 2 &&
    Boolean(childOne?.tool_calls?.some((call) => call.name === 'edit')) &&
    (positiveJson?.workspace?.files_changed ?? []).includes('src/sum.mjs');

  const negativeFailed = negativeJson?.failed_checks ?? [];
  const namedCheck = negativeJson?.score?.checks?.find(
    (check) => check.name === 'parent_shell_max',
  );
  const negativeOk =
    negative.status === 1 &&
    negativeFailed.includes('parent_shell_max') &&
    namedCheck?.pass === false &&
    namedCheck?.actual === 1;

  console.log('');
  console.log(
    `self-test positive: exit=${positive.status} passed=${positiveJson?.passed} parent_tool_calls=${positiveJson?.session?.parent?.tool_count} child_sessions=${positiveJson?.session?.children?.length}`,
  );
  console.log(
    `self-test negative: exit=${negative.status} failed_checks=${JSON.stringify(negativeFailed)}`,
  );

  if (!positiveOk) {
    console.error('self-test: positive dry-run did not behave as specified');
    if (positive.stderr) console.error(positive.stderr.trim());
    if (positive.stdout) console.error(positive.stdout.trim());
  }
  if (!negativeOk) {
    console.error('self-test: negative run did not fail on parent_shell_max');
    if (negative.stderr) console.error(negative.stderr.trim());
    if (negative.stdout) console.error(negative.stdout.trim());
  }
  if (readError) {
    console.error(`self-test: could not read reports: ${readError}`);
  }

  const passed = positiveOk && negativeOk;
  console.log(`self-test: ${passed ? 'PASS' : 'FAIL'}`);
  if (passed) {
    console.log(`  positive report: ${positiveReport}`);
    console.log(`  negative report: ${negativeReport}`);
  }
  return passed ? 0 : 1;
}

/* ------------------------------------------------------------------------- */
/* Real case execution                                                        */
/* ------------------------------------------------------------------------- */

async function runOne(options) {
  const caseDefinition = await loadCase(options.caseId, options);
  const target = await resolveReportTarget(
    options,
    `${caseDefinition.id}-${timestamp()}`,
  );
  const report = await executeCase(caseDefinition, options);
  report.report_path = target;
  await writeReport(target, report);
  printCaseSummary(report);
  if (options.keep) console.log(`  kept workspace: ${report.workspace.path}`);
  return report.passed ? 0 : 1;
}

async function runAll(options) {
  const ids = await listCaseIds();
  if (ids.length === 0) {
    console.log(`no cases found in ${CASES_DIR}`);
    return 0;
  }

  let reportDirectory = null;
  if (options.report) {
    reportDirectory = await ensureDirectory(path.resolve(process.cwd(), options.report));
  }

  const summaries = [];
  let anyFailed = false;

  for (const id of ids) {
    let report;
    try {
      const caseDefinition = await loadCase(id, options);
      const target = reportDirectory
        ? path.join(reportDirectory, `${id}-${timestamp()}.json`)
        : await resolveReportTarget(options, `${id}-${timestamp()}`);
      report = await executeCase(caseDefinition, options);
      report.report_path = target;
      await writeReport(target, report);

      if (options.keep) console.log(`kept workspace: ${report.workspace.path}`);
    } catch (error) {
      anyFailed = true;
      console.error(`case ${id}: ERROR ${error.message}`);
      summaries.push({
        id,
        passed: false,
        parent: 0,
        children: 0,
        wall: 0,
        failed: ['case_error'],
        judges: {},
      });
      continue;
    }

    anyFailed ||= !report.passed;
    summaries.push({
      id,
      passed: report.passed,
      parent: report.session?.parent?.tool_count ?? 0,
      children: report.session?.children?.length ?? 0,
      wall: (Number(report.run?.duration_ms ?? 0) / 1000).toFixed(2),
      failed: report.failed_checks,
      judges: report.judges ?? {},
    });
  }

  const judgeCell = (judges) => {
    const entries = Object.values(judges ?? {});
    if (entries.length === 0) return '-';
    return entries
      .map((judge) => {
        if (judge.status !== 'ok') return `${judge.name}=${judge.status}`;
        const score = Number(judge.score).toFixed(2);
        return judge.advisory_pass
          ? `${judge.name}=${score}`
          : `${judge.name}=${score} ADVISORY-FAIL`;
      })
      .join(',');
  };

  const header = ['ID', 'RESULT', 'PARENT', 'CHILDREN', 'WALL_S', 'JUDGE', 'FAILED'];
  const rows = summaries.map((summary) => [
    summary.id,
    summary.passed ? 'PASS' : 'FAIL',
    String(summary.parent),
    String(summary.children),
    String(summary.wall),
    judgeCell(summary.judges),
    summary.failed.length > 0 ? summary.failed.join(',') : '-',
  ]);
  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((row) => row[index].length)),
  );
  const render = (row) =>
    row.map((value, index) => value.padEnd(widths[index])).join('  ');

  console.log('');
  console.log(render(header));
  console.log(render(widths.map((width) => '-'.repeat(width))));
  for (const row of rows) console.log(render(row));

  const advisoryFails = summaries
    .flatMap((summary) => Object.values(summary.judges ?? {}))
    .filter((judge) => judge.status === 'ok' && judge.advisory_pass === false);
  if (advisoryFails.length > 0) {
    console.log('');
    console.log(
      `advisory: ${advisoryFails.length} judge score(s) below threshold (recorded only; exit code is unchanged)`,
    );
  }

  return anyFailed ? 1 : 0;
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`agent-evals: ${error.message}`);
    console.error(usage());
    return 2;
  }

  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (argv.length === 0) {
    console.error(usage());
    return 2;
  }

  if (options.selfTest) {
    if (options.dryRun || options.selfTestFail || options.caseId || options.all) {
      console.error('agent-evals: --self-test cannot be combined with run modes');
      return 2;
    }
    return runSelfTest();
  }

  if (options.selfTestFail) {
    if (options.caseId || options.all || options.dryRun) {
      console.error('agent-evals: --self-test-fail cannot be combined with run modes');
      return 2;
    }
    return runSynthetic({ failing: true, options });
  }

  if (options.dryRun) {
    if (options.caseId || options.all) {
      console.error('agent-evals: --dry-run cannot be combined with --case or --all');
      return 2;
    }
    return runSynthetic({ failing: false, options });
  }

  if (options.caseId && options.all) {
    console.error('agent-evals: --case and --all are mutually exclusive');
    return 2;
  }

  if (!options.caseId && !options.all) {
    console.error(usage());
    return 2;
  }

  // Full runs judge by default; a single --case run stays deterministic and
  // only enables judges when explicitly requested. Synthetic modes never reach
  // this point.
  options.judgeEnabled = options.judge ?? Boolean(options.all);

  const dbStat = await fs.stat(DB_PATH).catch(() => null);
  if (!dbStat?.isFile()) {
    console.error(`agent-evals: OpenCode database not found: ${DB_PATH}`);
    return 2;
  }

  try {
    if (options.all) return await runAll(options);
    return await runOne(options);
  } catch (error) {
    console.error(`agent-evals: ${error.message}`);
    return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
