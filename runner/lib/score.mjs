/**
 * Deterministic scoring for Agent Evals.
 *
 * Every check is data-driven from the case's `expect` object. The engine never
 * asks a model anything: it reads the captured trajectory and the workspace diff
 * and produces pass/fail plus the actual value it observed.
 *
 * Checks:
 *   parent_code_edits_max          Max code-edit tool calls made by the parent.
 *   parent_shell_max               Max shell tool calls made by the parent.
 *   subagents_min                  Min direct child sessions under the parent.
 *   files_changed                  Allowlist of paths/globs changed in the workspace.
 *   tests                          Shell commands run in the workspace; exit 0 required.
 *   final_gate_ran                 A child shell call ran the gate command and exited 0.
 *   max_lookups_before_first_edit  Max read-only lookups before the parent's first edit.
 *   wall_time_max_s                Max wall-clock seconds for the parent run.
 *   plan_checkboxes_ticked         Every checkbox in a markdown file is ticked.
 *   report_contains                The final parent/child report mentions the evidence.
 *   report_contains_any            Any one of the given tokens appears in a final report.
 *   destructive_shell_max          Max parent shell calls whose command writes to the filesystem.
 *
 * `parent_plan_globs` narrows `parent_code_edits_max`: an edit whose target matches
 * one of those globs is plan bookkeeping and is reported separately instead of
 * counting as a code edit.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const EDIT_TOOLS = new Set([
  'write',
  'edit',
  'multiedit',
  'multi_edit',
  'apply_patch',
  'applypatch',
  'patch',
  'str_replace',
  'str_replace_editor',
  'create_file',
  'notebook_edit',
  'write_file',
]);

const SHELL_TOOLS = new Set([
  'shell',
  'bash',
  'terminal',
  'exec',
  'exec_command',
  'run_terminal_cmd',
]);

const LOOKUP_TOOLS = new Set([
  'read',
  'read_file',
  'grep',
  'glob',
  'ls',
  'list',
  'list_dir',
  'search',
  'search_files',
  'code_search',
  'codesearch',
  'webfetch',
  'websearch',
  'web_search',
  'find',
  'view',
  'cat',
]);

const WRITE_COMMAND_PATTERNS = [
  /\bsed\s+-i\b/,
  /\bperl\s+-[A-Za-z]*i[A-Za-z]*\b/,
  /\btee\b/,
  /\btruncate\b/,
  /\btouch\b/,
  /\brm\b/,
  /\bmv\b/,
  /\bcp\b/,
  /\bmkdir\b/,
  /\bgit\s+(apply|checkout|restore|reset|clean|mv|rm)\b/,
  /\bpatch\b/,
  /\b(npm|pnpm|yarn|composer|pip|pip3)\s+(install|add|require|remove|uninstall)\b/,
  /\bdd\s+.*\bof=/,
];

const MAX_TEST_OUTPUT = 8000;

function truncate(text, maxChars) {
  const value = String(text ?? '');
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…[truncated ${value.length - maxChars} chars]`;
}

function sleepKill(child) {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/** True when a shell command writes to the filesystem. */
export function shellWrites(command) {
  const value = String(command ?? '');
  if (!value) return false;

  // A redirect to a real target. `2>&1` and `>/dev/null` do not count.
  if (/(^|[^&])>>?\s*(?!&)(?!\/dev\/null(?:\s|$))\S+/.test(value)) return true;

  return WRITE_COMMAND_PATTERNS.some((pattern) => pattern.test(value));
}

/** Classify one captured tool call as edit, shell, and/or lookup. */
export function classifyToolCall(call) {
  const name = String(call?.name ?? '').toLowerCase();
  const shell = SHELL_TOOLS.has(name);
  const command = call?.input?.command ?? '';
  const edit = EDIT_TOOLS.has(name) || (shell && shellWrites(command));
  return {
    shell,
    edit,
    lookup: !edit && (LOOKUP_TOOLS.has(name) || (shell && !shellWrites(command))),
  };
}

/** Convert a `**`/`*`/`?` glob to a path-segment-aware regular expression. */
export function globToRegExp(glob) {
  const pattern = String(glob);
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          expression += '(?:.*/)?';
        } else {
          expression += '.*';
        }
      } else {
        expression += '[^/]*';
      }
    } else if (character === '?') {
      expression += '[^/]';
    } else if ('\\^$.+()|{}[]'.includes(character)) {
      expression += `\\${character}`;
    } else {
      expression += character;
    }
  }
  expression += '$';
  return new RegExp(expression);
}

/** The worktree-relative target of an edit call, when it names one. */
function editTargetPath(call, workspacePath) {
  const raw =
    call?.input?.filePath ?? call?.input?.path ?? call?.input?.file_path ?? null;
  if (typeof raw !== 'string' || !raw) return null;

  let value = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  if (workspacePath) {
    const base = String(workspacePath).replace(/\\/g, '/').replace(/\/+$/, '');
    if (base && value.startsWith(`${base}/`)) value = value.slice(base.length + 1);
  }
  return value;
}

function reportMatcher(spec) {
  if (typeof spec === 'string') {
    const needle = spec.toLowerCase();
    return { label: spec, test: (text) => text.toLowerCase().includes(needle) };
  }
  const source = String(spec?.regex ?? spec?.contains ?? '');
  if (!source) return { label: '', test: () => false };
  try {
    const expression = new RegExp(source, spec?.flags ?? 'i');
    return { label: source, test: (text) => expression.test(text) };
  } catch {
    return { label: source, test: () => false };
  }
}

/** Run one test command in the workspace and capture its result. */
export function runTestCommand(workspacePath, spec) {
  const command = typeof spec === 'string' ? spec : spec.command;
  const timeoutMs = Number(spec?.timeout_ms ?? 120000);

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const child = spawn('sh', ['-c', command], {
      cwd: workspacePath,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
    });

    const collect = (current, chunk) => {
      if (current.length >= MAX_TEST_OUTPUT * 2) return current;
      return current + chunk.toString().slice(0, MAX_TEST_OUTPUT * 2 - current.length);
    };

    child.stdout.on('data', (chunk) => {
      stdout = collect(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = collect(stderr, chunk);
    });

    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command,
        exit_code: exitCode,
        signal: signal ?? null,
        timed_out: timedOut,
        duration_ms: Date.now() - startedAt,
        passed: exitCode === 0 && !timedOut,
        stdout: truncate(stdout, MAX_TEST_OUTPUT),
        stderr: truncate(stderr, MAX_TEST_OUTPUT),
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      sleepKill(child);
    }, timeoutMs);

    child.on('error', (error) => {
      stderr += `\n${error.message}`;
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code ?? null, signal));
  });
}

function actualSeconds(wallTimeMs) {
  return Number((Number(wallTimeMs ?? 0) / 1000).toFixed(2));
}

/**
 * Score a captured run.
 *
 * @param {{
 *   expect: object,
 *   trace: {parent?: {tool_calls?: object[], duration_ms?: number}, children?: object[]}|null,
 *   workspace: {path: string, files_changed?: string[]},
 *   wallTimeMs?: number,
 * }} input
 * @returns {Promise<{checks: object[], passed: boolean, failed_checks: string[]}>}
 */
export async function scoreRun({ expect = {}, trace, workspace, wallTimeMs }) {
  const checks = [];
  const parentCalls = trace?.parent?.tool_calls ?? [];
  const children = trace?.children ?? [];
  const changed = workspace?.files_changed ?? [];
  const classified = parentCalls.map((call) => ({
    call,
    ...classifyToolCall(call),
  }));

  const add = (name, pass, expected, actual, detail = null) => {
    checks.push({ name, pass: Boolean(pass), expected, actual, detail });
  };

  if (Object.hasOwn(expect, 'parent_code_edits_max')) {
    const edits = classified.filter((entry) => entry.edit);
    const planGlobs = Array.isArray(expect.parent_plan_globs)
      ? expect.parent_plan_globs
      : [];
    const planMatchers = planGlobs.map(globToRegExp);
    const editDetail = (entry) => ({
      tool: entry.call.name,
      path: editTargetPath(entry.call, workspace.path),
      command: entry.call.input?.command ?? null,
    });
    const planEdits = edits.filter((entry) => {
      const target = editTargetPath(entry.call, workspace.path);
      return target !== null && planMatchers.some((matcher) => matcher.test(target));
    });
    const codeEdits = edits.filter((entry) => !planEdits.includes(entry));
    add(
      'parent_code_edits_max',
      codeEdits.length <= Number(expect.parent_code_edits_max),
      Number(expect.parent_code_edits_max),
      codeEdits.length,
      {
        plan_globs: planGlobs,
        code_edits: codeEdits.map(editDetail),
        plan_edits: planEdits.map(editDetail),
      },
    );
  }

  if (Object.hasOwn(expect, 'parent_shell_max')) {
    const shells = classified.filter((entry) => entry.shell);
    add(
      'parent_shell_max',
      shells.length <= Number(expect.parent_shell_max),
      Number(expect.parent_shell_max),
      shells.length,
      shells.map((entry) => ({
        tool: entry.call.name,
        command: entry.call.input?.command ?? null,
        exit_code: entry.call.exit_code ?? null,
      })),
    );
  }

  if (Object.hasOwn(expect, 'destructive_shell_max')) {
    const writes = classified.filter(
      (entry) => entry.shell && shellWrites(entry.call.input?.command),
    );
    add(
      'destructive_shell_max',
      writes.length <= Number(expect.destructive_shell_max),
      Number(expect.destructive_shell_max),
      writes.length,
      writes.map((entry) => ({
        tool: entry.call.name,
        command: entry.call.input?.command ?? null,
        exit_code: entry.call.exit_code ?? null,
      })),
    );
  }

  if (Object.hasOwn(expect, 'subagents_min')) {
    add(
      'subagents_min',
      children.length >= Number(expect.subagents_min),
      Number(expect.subagents_min),
      children.length,
      children.map((child) => ({
        id: child.id,
        title: child.title,
        agent: child.agent,
        tool_count: child.tool_count,
      })),
    );
  }

  if (Object.hasOwn(expect, 'files_changed')) {
    const allowlist = Array.isArray(expect.files_changed) ? expect.files_changed : [];
    const matchers = allowlist.map(globToRegExp);
    const unexpected = changed.filter(
      (file) => !matchers.some((matcher) => matcher.test(file)),
    );
    add(
      'files_changed',
      unexpected.length === 0,
      allowlist,
      changed,
      { allowlist, unexpected },
    );
  }

  if (Object.hasOwn(expect, 'tests')) {
    const rawSpecs = Array.isArray(expect.tests) ? expect.tests : [expect.tests];
    const specs = rawSpecs.map((spec) =>
      typeof spec === 'string' ? { command: spec, timeout_ms: 120000 } : spec,
    );
    const results = [];
    for (const spec of specs) {
      results.push(await runTestCommand(workspace.path, spec));
    }
    add(
      'tests',
      results.every((result) => result.passed),
      specs.map((spec) => spec.command),
      results.map((result) => ({
        command: result.command,
        exit_code: result.exit_code,
        timed_out: result.timed_out,
        passed: result.passed,
      })),
      results,
    );
  }

  if (Object.hasOwn(expect, 'final_gate_ran')) {
    const spec =
      typeof expect.final_gate_ran === 'string'
        ? { command_contains: expect.final_gate_ran }
        : expect.final_gate_ran ?? {};
    const needle = String(spec.command_contains ?? '');
    const requiredExit = Number(spec.exit_code ?? 0);
    const matches = [];

    for (const child of children) {
      for (const call of child.tool_calls ?? []) {
        if (!SHELL_TOOLS.has(call.name)) continue;
        const command = String(call.input?.command ?? '');
        if (!needle || !command.includes(needle)) continue;
        matches.push({
          child_id: child.id,
          child_title: child.title,
          tool: call.name,
          command,
          exit_code: call.exit_code ?? null,
        });
      }
    }

    const passing = matches.filter(
      (match) =>
        match.exit_code !== null &&
        match.exit_code !== undefined &&
        Number(match.exit_code) === requiredExit,
    );

    add(
      'final_gate_ran',
      passing.length > 0,
      { scope: 'children', command_contains: needle, exit_code: requiredExit },
      passing.length > 0 ? passing[0].command : null,
      { matches },
    );
  }

  if (Object.hasOwn(expect, 'max_lookups_before_first_edit')) {
    const firstEditIndex = classified.findIndex((entry) => entry.edit);
    const beforeFirstEdit =
      firstEditIndex >= 0 ? classified.slice(0, firstEditIndex) : classified;
    const lookups = beforeFirstEdit.filter((entry) => entry.lookup);
    add(
      'max_lookups_before_first_edit',
      lookups.length <= Number(expect.max_lookups_before_first_edit),
      Number(expect.max_lookups_before_first_edit),
      lookups.length,
      {
        first_edit_index: firstEditIndex >= 0 ? firstEditIndex : null,
        first_edit_tool:
          firstEditIndex >= 0 ? classified[firstEditIndex].call.name : null,
        lookups: lookups.map((entry) => ({
          tool: entry.call.name,
          path:
            entry.call.input?.filePath ??
            entry.call.input?.path ??
            null,
          command: entry.call.input?.command ?? null,
        })),
      },
    );
  }

  if (Object.hasOwn(expect, 'wall_time_max_s')) {
    const seconds =
      wallTimeMs === undefined || wallTimeMs === null
        ? actualSeconds(trace?.parent?.duration_ms)
        : actualSeconds(wallTimeMs);
    add(
      'wall_time_max_s',
      seconds <= Number(expect.wall_time_max_s),
      Number(expect.wall_time_max_s),
      seconds,
    );
  }

  if (Object.hasOwn(expect, 'plan_checkboxes_ticked')) {
    const spec =
      typeof expect.plan_checkboxes_ticked === 'string'
        ? { path: expect.plan_checkboxes_ticked }
        : expect.plan_checkboxes_ticked ?? {};
    const relative = String(spec.path ?? '');
    const minTicked = Number(spec.min_ticked ?? 1);
    const root = path.resolve(workspace.path);
    const target = path.resolve(root, relative);
    const inside = target === root || target.startsWith(`${root}${path.sep}`);

    let text = null;
    let readError = null;
    if (!inside) {
      readError = `plan path escapes the workspace: ${relative}`;
    } else {
      try {
        text = await fs.readFile(target, 'utf8');
      } catch (error) {
        readError = error.message;
      }
    }

    const boxes = [...String(text ?? '').matchAll(/^\s*[-*]\s+\[([ xX])\]\s+/gm)];
    const ticked = boxes.filter((match) => match[1].toLowerCase() === 'x').length;
    const unticked = boxes.length - ticked;
    add(
      'plan_checkboxes_ticked',
      Boolean(text) && unticked === 0 && ticked >= minTicked,
      { path: relative, min_ticked: minTicked, unticked: 0 },
      { ticked, unticked, checkboxes: boxes.length, error: readError },
    );
  }

  if (Object.hasOwn(expect, 'report_contains')) {
    const specs = Array.isArray(expect.report_contains)
      ? expect.report_contains
      : [expect.report_contains];
    const matchers = specs.map(reportMatcher);
    const reports = [];
    if (trace?.parent) {
      reports.push({ source: 'parent', text: String(trace.parent.final_text ?? '') });
    }
    for (const child of children) {
      reports.push({
        source: `child:${child.id}`,
        text: String(child.final_text ?? ''),
      });
    }

    let matched = null;
    for (const report of reports) {
      for (const matcher of matchers) {
        if (matcher.test(report.text)) {
          matched = { token: matcher.label, source: report.source };
          break;
        }
      }
      if (matched) break;
    }

    add(
      'report_contains',
      Boolean(matched),
      matchers.map((matcher) => matcher.label),
      matched,
      {
        reports: reports.map((report) => ({
          source: report.source,
          chars: report.text.length,
          tail: truncate(report.text, 1500),
        })),
      },
    );
  }

  if (Object.hasOwn(expect, 'report_contains_any')) {
    const specs = Array.isArray(expect.report_contains_any)
      ? expect.report_contains_any
      : [expect.report_contains_any];
    const matchers = specs.map(reportMatcher);
    const reports = [];
    if (trace?.parent) {
      reports.push({ source: 'parent', text: String(trace.parent.final_text ?? '') });
    }
    for (const child of children) {
      reports.push({
        source: `child:${child.id}`,
        text: String(child.final_text ?? ''),
      });
    }

    let matched = null;
    for (const report of reports) {
      for (const matcher of matchers) {
        if (matcher.test(report.text)) {
          matched = { token: matcher.label, source: report.source };
          break;
        }
      }
      if (matched) break;
    }

    add(
      'report_contains_any',
      Boolean(matched),
      matchers.map((matcher) => matcher.label),
      matched,
      {
        reports: reports.map((report) => ({
          source: report.source,
          chars: report.text.length,
          tail: truncate(report.text, 1500),
        })),
      },
    );
  }

  const failed = checks.filter((check) => !check.pass).map((check) => check.name);
  return {
    checks,
    passed: failed.length === 0,
    failed_checks: failed,
  };
}

/* ------------------------------------------------------------------------- */
/* Judge input builders                                                       */
/* ------------------------------------------------------------------------- */

const JUDGE_MAX_PLAN = 8000;
const JUDGE_MAX_REPORT = 6000;
const JUDGE_MAX_PROMPT = 3500;
const JUDGE_MAX_TARGET = 220;
const JUDGE_MAX_TOOLS = 40;
const JUDGE_MAX_OUTPUT = 1500;

function toolTarget(call) {
  const input = call?.input ?? {};
  const value =
    input.filePath ??
    input.path ??
    input.file_path ??
    input.command ??
    input.pattern ??
    input.url ??
    input.description ??
    '';
  return truncate(String(value).replace(/\s+/g, ' ').trim(), JUDGE_MAX_TARGET);
}

/** Subagent/task tool calls, with the delegation prompt they carried. */
export function extractSubagentCalls(parent) {
  return (parent?.tool_calls ?? [])
    .filter((call) => ['subagent', 'task'].includes(String(call?.name ?? '').toLowerCase()))
    .map((call) => {
      const input = call?.input ?? {};
      return {
        agent: input.agent ?? input.subagent_type ?? input.subagent ?? null,
        description: truncate(String(input.description ?? '').trim(), 300) || null,
        prompt: truncate(
          String(input.prompt ?? input.message ?? input.task ?? '').trim(),
          JUDGE_MAX_PROMPT,
        ),
      };
    });
}

/** Bounded tool-call list for a judge: names, targets, exit codes, no raw logs. */
export function summarizeToolCalls(toolCalls, { limit = JUDGE_MAX_TOOLS } = {}) {
  return (toolCalls ?? []).slice(0, limit).map((call) => ({
    name: call?.name ?? 'unknown',
    target: toolTarget(call),
    exit_code: call?.exit_code ?? null,
  }));
}

/** Deterministic test evidence from a scored run, bounded for a judge. */
export function testEvidence(checks) {
  const check = (checks ?? []).find((entry) => entry.name === 'tests');
  const results = Array.isArray(check?.detail) ? check.detail : [];
  return results.slice(0, 4).map((result) => ({
    command: result.command ?? null,
    exit_code: result.exit_code ?? null,
    passed: Boolean(result.passed),
    stdout: truncate(result.stdout ?? '', JUDGE_MAX_OUTPUT),
    stderr: truncate(result.stderr ?? '', JUDGE_MAX_OUTPUT),
  }));
}

function planPathFor(caseDefinition) {
  const spec = caseDefinition?.expect?.plan_checkboxes_ticked;
  if (typeof spec === 'string') return spec;
  if (spec && typeof spec.path === 'string') return spec.path;
  return null;
}

async function readPlan(workspacePath, relative) {
  if (!relative) return null;
  const root = path.resolve(workspacePath);
  const target = path.resolve(root, relative);
  const inside = target === root || target.startsWith(`${root}${path.sep}`);
  if (!inside) {
    return { path: relative, content: null, error: 'plan path escapes the workspace' };
  }
  try {
    const content = await fs.readFile(target, 'utf8');
    return { path: relative, content: truncate(content, JUDGE_MAX_PLAN), error: null };
  } catch (error) {
    return { path: relative, content: null, error: error.message };
  }
}

function planPhaseHeadings(content) {
  return [...String(content ?? '').matchAll(/^#{2,3}\s+(.+)$/gm)]
    .map((match) => match[0].trim())
    .slice(0, 20);
}

/**
 * Build the compact, secret-free summary judges receive.
 *
 * It contains only: the case task, the plan, bounded parent/child trajectory
 * summaries, changed paths, and deterministic test evidence. No database rows,
 * environment values, API keys, or raw tool logs are included.
 *
 * @param {{
 *   caseDefinition: object,
 *   trace: object|null,
 *   workspace: {path?: string, files_changed?: string[]},
 *   score: {checks?: object[]},
 *   planPath?: string|null,
 * }} input
 */
export async function buildJudgeSource({
  caseDefinition,
  trace,
  workspace,
  score,
  planPath = null,
}) {
  const parent = trace?.parent ?? null;
  const children = trace?.children ?? [];
  const filesChanged = workspace?.files_changed ?? [];
  const parentCalls = parent?.tool_calls ?? [];
  const subagentCalls = extractSubagentCalls(parent);

  const planGlobs = Array.isArray(caseDefinition?.expect?.parent_plan_globs)
    ? caseDefinition.expect.parent_plan_globs
    : [];
  const planMatchers = planGlobs.map(globToRegExp);
  const classified = parentCalls.map((call) => ({ call, ...classifyToolCall(call) }));
  const codeEdits = classified.filter((entry) => {
    if (!entry.edit) return false;
    const target = editTargetPath(entry.call, workspace?.path);
    if (target === null) return true;
    return !planMatchers.some((matcher) => matcher.test(target));
  });

  const plan = await readPlan(
    workspace?.path,
    planPath ?? planPathFor(caseDefinition),
  );

  const childSummaries = children.map((child, index) => {
    const matched =
      subagentCalls.find(
        (call) => call.description && child?.title?.includes(call.description),
      ) ?? subagentCalls[index] ?? null;
    return {
      agent: child?.agent ?? null,
      title: child?.title ?? null,
      prompt: matched?.prompt ?? null,
      final_report: truncate(child?.final_text ?? '', JUDGE_MAX_REPORT),
      tool_calls: summarizeToolCalls(child?.tool_calls),
    };
  });

  const gateCheck = (score?.checks ?? []).find(
    (check) => check.name === 'final_gate_ran',
  );
  const gateSpec = caseDefinition?.expect?.final_gate_ran;
  const gateMatch = gateCheck?.detail?.matches?.[0] ?? null;
  const finalGate = gateCheck
    ? {
        required:
          typeof gateSpec === 'string'
            ? gateSpec
            : gateSpec?.command_contains ?? null,
        delegated: (gateCheck?.detail?.matches?.length ?? 0) > 0,
        passed: Boolean(gateCheck.pass),
        command: gateMatch?.command ?? null,
        exit_code: gateMatch?.exit_code ?? null,
      }
    : null;

  const finalReport =
    parent?.final_text?.trim() ||
    children[children.length - 1]?.final_text?.trim() ||
    '';

  return {
    case: {
      id: caseDefinition?.id ?? null,
      agent: caseDefinition?.agent ?? null,
      task: truncate(caseDefinition?.prompt ?? '', 3000),
    },
    plan: plan
      ? {
          path: plan.path,
          phase_headings: planPhaseHeadings(plan.content),
          content: plan.content,
          error: plan.error,
        }
      : null,
    parent: {
      agent: parent?.agent ?? caseDefinition?.agent ?? null,
      tool_count: parent?.tool_count ?? 0,
      code_edit_calls: codeEdits.length,
      shell_calls: classified.filter((entry) => entry.shell).length,
      subagent_calls: subagentCalls,
      other_tool_calls: summarizeToolCalls(
        parentCalls.filter(
          (call) => !['subagent', 'task'].includes(String(call?.name ?? '').toLowerCase()),
        ),
      ),
      final_report: truncate(parent?.final_text ?? '', JUDGE_MAX_REPORT),
    },
    children: childSummaries,
    final_report: truncate(finalReport, JUDGE_MAX_REPORT),
    files_changed: filesChanged,
    tests: testEvidence(score?.checks),
    final_gate: finalGate,
  };
}

/**
 * Combine hard checks with advisory judge results.
 *
 * `passed` and `failed_checks` are computed from `checks` only. The judges
 * object is carried alongside and can never change the outcome.
 *
 * @param {{checks: object[], judges?: object}} input
 */
export function composeCaseOutcome({ checks, judges = {} }) {
  const failed = (checks ?? []).filter((check) => !check.pass).map((check) => check.name);
  return {
    checks: checks ?? [],
    passed: failed.length === 0,
    failed_checks: failed,
    judges: judges ?? {},
  };
}
