/**
 * LLM-as-judge transports for Agent Evals.
 *
 * A judge never touches the hard checks. It receives a compact, already-bounded
 * JSON summary built by a scorer, applies that scorer's rubric, and returns:
 *
 *   { status: 'ok'|'skipped'|'error', score, rationale, model, raw, error? }
 *
 * Two transports, no dependencies:
 *
 *   opencode (default)
 *     Writes { rubric, input } to a temp JSON file and runs the global read-only
 *     `eval-judge` agent in a temp working directory:
 *       opencode run --agent eval-judge --model <model> --archived \
 *         --title <unique> "Read <file> and judge it."
 *     Model: EVAL_JUDGE_MODEL, else opencode-go/deepseek-v4.1-flash.
 *
 *   http
 *     OpenAI-compatible POST <base>/chat/completions with temperature 0.
 *     Env: EVAL_JUDGE_BASE_URL, EVAL_JUDGE_API_KEY, EVAL_JUDGE_MODEL.
 *
 * Missing configuration is `skipped`, not failed. A judge error is recorded in
 * the report and never changes `passed`, `failed_checks`, or the exit code.
 *
 * Reply parsing is strict: extract the first `{` through the last `}`, then
 * require a finite `score` in 0..1 and a non-empty `rationale` string. Markdown
 * fences are tolerated because the JSON slice ignores them.
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getScorer } from './scorers/index.mjs';

export const DEFAULT_JUDGE_MODEL = 'opencode-go/deepseek-v4.1-flash';
export const JUDGE_TIMEOUT_MS = 120000;
const MAX_CAPTURE = 1024 * 1024;
const MAX_RAW = 20000;

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

/**
 * Resolve judge configuration without exposing secrets.
 *
 * @param {{transport?: string, model?: string, baseUrl?: string, apiKey?: string, timeoutMs?: number}} overrides
 * @returns {{enabled: boolean, transport: string, model: string|null, baseUrl?: string, apiKey?: string, timeoutMs: number, reason: string|null}}
 */
export function resolveJudgeConfig(overrides = {}) {
  const transport = String(
    overrides.transport ?? process.env.EVAL_JUDGE_TRANSPORT ?? 'opencode',
  )
    .trim()
    .toLowerCase();
  const timeoutMs = Number(overrides.timeoutMs ?? JUDGE_TIMEOUT_MS);

  if (transport === 'opencode') {
    const model =
      overrides.model || process.env.EVAL_JUDGE_MODEL || DEFAULT_JUDGE_MODEL;
    return {
      enabled: true,
      transport,
      model,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : JUDGE_TIMEOUT_MS,
      reason: null,
    };
  }

  if (transport === 'http') {
    const baseUrl = String(
      overrides.baseUrl ?? process.env.EVAL_JUDGE_BASE_URL ?? '',
    )
      .trim()
      .replace(/\/+$/, '');
    const apiKey = String(
      overrides.apiKey ?? process.env.EVAL_JUDGE_API_KEY ?? '',
    ).trim();
    const model = String(
      overrides.model ?? process.env.EVAL_JUDGE_MODEL ?? '',
    ).trim();

    const missing = [];
    if (!baseUrl) missing.push('EVAL_JUDGE_BASE_URL');
    if (!apiKey) missing.push('EVAL_JUDGE_API_KEY');
    if (!model) missing.push('EVAL_JUDGE_MODEL');

    if (missing.length > 0) {
      return {
        enabled: false,
        transport,
        model: model || null,
        timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : JUDGE_TIMEOUT_MS,
        reason: `missing judge configuration: ${missing.join(', ')}`,
      };
    }

    return {
      enabled: true,
      transport,
      baseUrl,
      apiKey,
      model,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : JUDGE_TIMEOUT_MS,
      reason: null,
    };
  }

  return {
    enabled: false,
    transport,
    model: null,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : JUDGE_TIMEOUT_MS,
    reason: `unknown judge transport: ${transport}`,
  };
}

/** Public, secret-free view of a judge configuration for the report. */
export function publicJudgeConfig(config) {
  if (!config) return null;
  return {
    transport: config.transport,
    model: config.model,
    enabled: Boolean(config.enabled),
    timeout_ms: config.timeoutMs,
    reason: config.reason ?? null,
  };
}

/**
 * Parse the judge reply. Throws on anything that is not the strict contract.
 * @param {string} raw
 * @returns {{score: number, rationale: string}}
 */
export function parseJudgeReply(raw) {
  const text = String(raw ?? '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('judge reply did not contain a JSON object');
  }

  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    throw new Error(`judge reply was not valid JSON: ${error.message}`);
  }

  const score = Number(parsed?.score);
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    throw new Error(`judge score must be a finite number in 0..1, got ${JSON.stringify(parsed?.score)}`);
  }
  if (typeof parsed?.rationale !== 'string' || !parsed.rationale.trim()) {
    throw new Error('judge rationale must be a non-empty string');
  }

  return { score, rationale: parsed.rationale.trim() };
}

/** Run one child with a hard timeout and bounded stdout/stderr capture. */
function runProcess(command, args, { cwd, timeoutMs, env }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError = null;
    let settled = false;

    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    const collect = (current, chunk) => {
      if (current.length >= MAX_CAPTURE) return current;
      return current + chunk.toString().slice(0, MAX_CAPTURE - current.length);
    };

    child.stdout.on('data', (chunk) => {
      stdout = collect(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = collect(stderr, chunk);
    });

    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exit_code: exitCode,
        timed_out: timedOut,
        spawn_error: spawnError,
        stdout,
        stderr,
        duration_ms: Date.now() - startedAt,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      sleepKill(child);
    }, timeoutMs);

    child.on('error', (error) => {
      spawnError = error.message;
      finish(null);
    });
    child.on('close', (code) => finish(code ?? null));
  });
}

async function opencodeTransport({ rubric, input, config }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-evals-judge-'));
  const file = path.join(directory, 'judge-input.json');
  const title = `eval-judge-${new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;

  try {
    await fs.writeFile(file, `${JSON.stringify({ rubric, input }, null, 2)}\n`, 'utf8');
    const prompt = `Read ${file} and judge it.`;
    const result = await runProcess(
      'opencode',
      [
        'run',
        '--agent',
        'eval-judge',
        '--model',
        config.model,
        '--archived',
        '--title',
        title,
        prompt,
      ],
      {
        cwd: directory,
        timeoutMs: config.timeoutMs,
        env: {
          ...process.env,
          PWD: directory,
          NO_COLOR: '1',
          CI: '1',
        },
      },
    );

    if (result.spawn_error) {
      const error = new Error(`could not start opencode: ${result.spawn_error}`);
      error.raw = null;
      throw error;
    }
    if (result.timed_out) {
      const error = new Error(`judge timed out after ${config.timeoutMs} ms`);
      error.raw = truncate(result.stdout, MAX_RAW);
      throw error;
    }
    if (result.exit_code !== 0) {
      const error = new Error(
        `judge exited ${result.exit_code}: ${truncate(result.stderr || result.stdout, 1200).trim()}`,
      );
      error.raw = truncate(result.stdout || result.stderr, MAX_RAW);
      throw error;
    }

    return {
      raw: truncate(result.stdout, MAX_RAW),
      text: result.stdout,
      duration_ms: result.duration_ms,
    };
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

async function httpTransport({ rubric, input, config }) {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: `${rubric}\n\nReturn only strict JSON of the form {"score": <number 0..1>, "rationale": "<one or two sentences>"}. Do not add markdown fences, preamble, or trailing text.`,
        },
        { role: 'user', content: JSON.stringify(input) },
      ],
    }),
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    const error = new Error(
      `judge HTTP ${response.status}: ${truncate(bodyText, 800).trim()}`,
    );
    error.raw = truncate(bodyText, MAX_RAW);
    throw error;
  }

  let body;
  try {
    body = JSON.parse(bodyText);
  } catch (error) {
    const wrapped = new Error(`judge HTTP response was not JSON: ${error.message}`);
    wrapped.raw = truncate(bodyText, MAX_RAW);
    throw wrapped;
  }

  const text = body?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    const error = new Error('judge HTTP response had no choices[0].message.content');
    error.raw = truncate(bodyText, MAX_RAW);
    throw error;
  }

  return { raw: truncate(text, MAX_RAW), text };
}

/**
 * Run one judge request and normalize the outcome.
 *
 * @param {{
 *   config: ReturnType<typeof resolveJudgeConfig>,
 *   rubric: string,
 *   input: object,
 * }} request
 * @returns {Promise<{status: string, score: number|null, rationale: string|null, model: string|null, raw: string|null, error?: string}>}
 */
export async function runJudge({ config, rubric, input }) {
  if (!config?.enabled) {
    return {
      status: 'skipped',
      score: null,
      rationale: null,
      model: config?.model ?? null,
      raw: null,
      error: config?.reason ?? 'judge configuration is missing',
    };
  }

  const transport =
    config.transport === 'http' ? httpTransport : opencodeTransport;

  try {
    const result = await transport({ rubric, input, config });
    const parsed = parseJudgeReply(result.text);
    return {
      status: 'ok',
      score: parsed.score,
      rationale: parsed.rationale,
      model: config.model,
      raw: result.raw,
    };
  } catch (error) {
    return {
      status: 'error',
      score: null,
      rationale: null,
      model: config.model,
      raw: error.raw ?? null,
      error: error.message,
    };
  }
}

/**
 * Run every judge declared by a case.
 *
 * Cases reference scorers by name:
 *   "judges": { "delegation_quality": { "threshold": 0.6 } }
 *
 * Hard checks are not consulted here and cannot be changed by the result.
 *
 * @param {{
 *   judges?: Record<string, {threshold?: number}>,
 *   source: object,
 *   config: ReturnType<typeof resolveJudgeConfig>,
 * }} input
 * @returns {Promise<Record<string, object>>}
 */
export async function runJudges({ judges = {}, source, config }) {
  const results = {};

  for (const [name, spec] of Object.entries(judges ?? {})) {
    const threshold = Number(spec?.threshold ?? 0.6);
    const base = {
      name,
      threshold,
      status: 'error',
      score: null,
      rationale: null,
      model: config?.model ?? null,
      raw: null,
      error: null,
      advisory_pass: null,
    };

    let definition;
    try {
      definition = getScorer(name);
    } catch (error) {
      results[name] = { ...base, error: error.message };
      continue;
    }

    let payload;
    try {
      payload = definition.buildInput({ source });
    } catch (error) {
      results[name] = {
        ...base,
        error: `could not build judge input: ${error.message}`,
      };
      continue;
    }

    let outcome;
    try {
      outcome = await definition.scorer({
        input: payload,
        output: source?.final_report ?? '',
        expected: { threshold },
        metadata: {
          judge: (request) => runJudge({ config, ...request }),
          case: source?.case ?? null,
        },
      });
    } catch (error) {
      results[name] = {
        ...base,
        error: `scorer failed: ${error.message}`,
      };
      continue;
    }

    const meta = outcome?.metadata ?? {};
    const rawScore = outcome?.score;
    const score =
      typeof rawScore === 'number' && Number.isFinite(rawScore) ? rawScore : null;
    results[name] = {
      ...base,
      status: meta.status ?? (score === null ? 'error' : 'ok'),
      score,
      rationale: meta.rationale ?? null,
      model: meta.model ?? base.model,
      raw: meta.raw ?? null,
      error: meta.error ?? null,
      advisory_pass: score === null ? null : score >= threshold,
    };
  }

  return results;
}
