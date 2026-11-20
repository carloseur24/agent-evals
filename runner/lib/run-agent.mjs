/**
 * Spawn an OpenCode agent run and locate the session it created.
 *
 * The CLI is invoked as:
 *   opencode run --agent <agent> --model <model> --format json \
 *     --archived --title <unique-title> <prompt>
 *
 * `--format json` is not assumed to contain the session ID; the parent session
 * is resolved from `session_v2` by the unique title, with the unique workspace
 * directory as a fallback because OpenCode may rename a session after creation.
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  openDatabase,
  findSessionByTitle,
  findSessionByDirectory,
} from './trace.mjs';

const MAX_CAPTURE = 4 * 1024 * 1024;
const SESSION_POLL_INTERVAL_MS = 250;
const SESSION_WAIT_MS = 15000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Unique title that also survives session-list truncation. */
export function makeTitle(caseId) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const random = crypto.randomBytes(4).toString('hex');
  return `eval-${caseId}-${stamp}-${random}`;
}

function killTree(child) {
  try {
    // The child is spawned detached, so its pid is the process-group id.
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/**
 * Run the agent once, with a hard wall-clock timeout.
 *
 * @param {{
 *   agent: string,
 *   model?: string|null,
 *   prompt: string,
 *   cwd: string,
 *   timeoutMs?: number,
 *   title?: string,
 *   caseId?: string,
 * }} options
 */
export function runAgent({
  agent,
  model = null,
  prompt,
  cwd,
  timeoutMs = 600000,
  title,
  caseId = 'eval',
}) {
  return new Promise((resolve) => {
    const sessionTitle = title ?? makeTitle(caseId);
    const args = ['run'];
    if (agent) args.push('--agent', agent);
    if (model) args.push('--model', model);
    args.push('--format', 'json', '--archived', '--title', sessionTitle, prompt);

    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let spawnError = null;
    let settled = false;

    const child = spawn('opencode', args, {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', CI: '1', PWD: cwd },
    });

    const append = (current, chunk, limit) => {
      if (current.length >= limit) return { text: current, truncated: true };
      const next = chunk.toString();
      if (current.length + next.length <= limit) {
        return { text: current + next, truncated: false };
      }
      return { text: current + next.slice(0, limit - current.length), truncated: true };
    };

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      const appended = append(stdout, chunk, MAX_CAPTURE);
      stdout = appended.text;
      stdoutTruncated ||= appended.truncated;
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      const appended = append(stderr, chunk, MAX_CAPTURE);
      stderr = appended.text;
      stderrTruncated ||= appended.truncated;
    });

    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        title: sessionTitle,
        command: 'opencode',
        args,
        cwd,
        started_at: startedAt,
        started_at_ms: startedAtMs,
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAtMs,
        exit_code: exitCode,
        signal: signal ?? null,
        timed_out: timedOut,
        spawn_error: spawnError,
        stdout,
        stderr,
        stdout_bytes: stdoutBytes,
        stderr_bytes: stderrBytes,
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    child.on('error', (error) => {
      spawnError = error.message;
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code ?? null, signal));
  });
}

/**
 * Find the session created by the run.
 *
 * Title is the primary key. The unique workspace directory is the fallback,
 * because a session-title agent can rewrite the title after creation.
 */
export async function resolveParentSession({
  dbPath,
  title,
  cwd,
  startedAtMs,
  waitMs = SESSION_WAIT_MS,
}) {
  const deadline = Date.now() + waitMs;
  let lastError = null;

  const directories = new Set([path.resolve(cwd)]);
  try {
    directories.add(await fs.realpath(cwd));
  } catch {
    // The workspace may already be gone; the raw path still works.
  }

  while (Date.now() < deadline) {
    let db = null;
    try {
      db = await openDatabase(dbPath);

      const byTitle = findSessionByTitle(db, title);
      if (byTitle) {
        return { session: byTitle, matched_by: 'title', error: null };
      }

      for (const directory of directories) {
        const byDirectory = findSessionByDirectory(
          db,
          directory,
          Number(startedAtMs) - 60000,
        );
        if (byDirectory) {
          return { session: byDirectory, matched_by: 'directory', error: null };
        }
      }
    } catch (error) {
      lastError = error;
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore close errors.
      }
    }
    await sleep(SESSION_POLL_INTERVAL_MS);
  }

  return {
    session: null,
    matched_by: null,
    error: lastError?.message ?? `no session found for title ${title}`,
  };
}
