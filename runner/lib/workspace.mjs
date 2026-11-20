/**
 * Workspace sandboxing for the Agent Evals runner.
 *
 * A workspace is a throwaway copy of a fixture plus a git baseline commit. The
 * runner diffs the workspace against that baseline after the agent finishes, so
 * every artifact check is relative to exactly what the fixture shipped with.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
};

const GIT_IDENTITY = [
  '-c', 'user.name=Eval',
  '-c', 'user.email=eval@example.invalid',
  '-c', 'commit.gpgsign=false',
  '-c', 'tag.gpgsign=false',
];

const MAX_GIT_BUFFER = 64 * 1024 * 1024;

async function runGit(cwd, args, { allowFailure = false } = {}) {
  try {
    return await execFileAsync('git', args, {
      cwd,
      env: GIT_ENV,
      encoding: 'utf8',
      maxBuffer: MAX_GIT_BUFFER,
    });
  } catch (error) {
    if (allowFailure) {
      return {
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? '',
        code: typeof error.code === 'number' ? error.code : 1,
      };
    }
    const detail = (error.stderr || error.message || '').trim();
    const failure = new Error(`git ${args.join(' ')} failed in ${cwd}: ${detail}`);
    failure.cause = error;
    throw failure;
  }
}

function lines(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function truncate(text, maxChars) {
  const value = String(text ?? '');
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n…[truncated ${value.length - maxChars} chars]`;
}

async function copyFixtureEntries(source, destination) {
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    // A fixture must never ship its own .git; the baseline must be ours.
    if (entry.name === '.git') continue;
    await fs.cp(
      path.join(source, entry.name),
      path.join(destination, entry.name),
      { recursive: true, force: true },
    );
  }
}

/**
 * Copy a fixture into a unique temp directory and commit the baseline.
 *
 * @param {{fixtureDir: string, label?: string}} options
 * @returns {Promise<{path: string, baseline: string, fixture: string, created_at: string}>}
 */
export async function createWorkspace({ fixtureDir, label = 'eval' }) {
  const stat = await fs.stat(fixtureDir).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`fixture directory not found: ${fixtureDir}`);
  }

  const safeLabel = String(label).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 48) || 'eval';
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), `agent-evals-${safeLabel}-`));

  try {
    await copyFixtureEntries(fixtureDir, workspacePath);
    await runGit(workspacePath, ['init', '-q']);
    await runGit(workspacePath, ['add', '-A']);
    await runGit(workspacePath, [
      ...GIT_IDENTITY,
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'eval baseline',
    ]);
    const revision = await runGit(workspacePath, ['rev-parse', 'HEAD']);
    return {
      path: workspacePath,
      baseline: revision.stdout.trim(),
      fixture: fixtureDir,
      created_at: new Date().toISOString(),
    };
  } catch (error) {
    await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/** Paths changed relative to the baseline, including untracked files. */
export async function changedFiles(workspace) {
  const outputs = await Promise.all([
    runGit(workspace.path, ['diff', '--name-only', '--no-renames', workspace.baseline]),
    runGit(workspace.path, ['ls-files', '--others', '--exclude-standard']),
  ]);
  return [...new Set(outputs.flatMap((output) => lines(output.stdout)))].sort();
}

/** `git status --porcelain` for the workspace, bounded for report size. */
export async function workspaceStatus(workspace, { maxChars = 4000 } = {}) {
  const result = await runGit(workspace.path, ['status', '--porcelain', '-uall']);
  return truncate(result.stdout, maxChars);
}

/** Human-readable diff stat relative to the baseline. */
export async function workspaceDiffStat(workspace) {
  const [tracked, untracked] = await Promise.all([
    runGit(workspace.path, ['diff', '--stat', '--no-renames', workspace.baseline]),
    runGit(workspace.path, ['ls-files', '--others', '--exclude-standard']),
  ]);
  const added = lines(untracked.stdout);
  const parts = [];
  if (tracked.stdout.trim()) parts.push(tracked.stdout.trimEnd());
  if (added.length > 0) parts.push(`${added.length} untracked file(s): ${added.join(', ')}`);
  return parts.join('\n');
}

/**
 * Unified diff relative to the baseline, including untracked files as new files.
 * The diff is truncated so a runaway agent cannot blow up the report.
 */
export async function workspaceDiff(workspace, { maxChars = 20000 } = {}) {
  const tracked = await runGit(workspace.path, [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--no-renames',
    workspace.baseline,
  ]);
  let diff = tracked.stdout;

  const untracked = lines(
    (await runGit(workspace.path, ['ls-files', '--others', '--exclude-standard'])).stdout,
  );
  for (const file of untracked) {
    const result = await runGit(
      workspace.path,
      ['diff', '--no-color', '--no-index', '--', '/dev/null', file],
      { allowFailure: true },
    );
    diff += result.stdout ?? '';
  }

  return truncate(diff, maxChars);
}

/** Remove the workspace unless `--keep` asked for it. */
export async function destroyWorkspace(workspace) {
  await fs.rm(workspace.path, { recursive: true, force: true });
}

export { runGit, truncate };
