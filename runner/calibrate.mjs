#!/usr/bin/env node
/**
 * Judge calibration.
 *
 * Runs every scorer named by a calibration example and checks the label:
 *   good → score >= threshold
 *   bad  → score <  threshold
 *
 * Examples live in `calibration/*.json`:
 *   {
 *     "id": "delegation-01-good-two-phases",
 *     "scorer": "delegation_quality",
 *     "label": "good" | "bad",
 *     "threshold": 0.6,
 *     "notes": "why this label is correct",
 *     "input": { ...compact judge payload... }
 *   }
 *
 * Exits non-zero when a known-good scores below threshold, a known-bad scores
 * at/above threshold, or a judge is skipped/errors. Agreement is stored next to
 * every score, rationale, model, and raw reply so a calibration claim is
 * auditable later.
 *
 * Usage:
 *   node calibrate.mjs --report "$AGENT_EVALS_STATE/reports/judge-calibration.json"
 *   node calibrate.mjs --transport http --report ...   # env-configured HTTP judge
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  JUDGE_TIMEOUT_MS,
  publicJudgeConfig,
  resolveJudgeConfig,
  runJudge,
} from './lib/judge.mjs';
import { getScorer } from './lib/scorers/index.mjs';
import { REPORTS_DIR } from './lib/state.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = path.dirname(SCRIPT_PATH);
const CALIBRATION_DIR = path.join(ROOT, 'calibration');

function usage() {
  return `Usage:
  node calibrate.mjs [--report <path>] [--calibration <dir>]
                     [--transport opencode|http] [--model <provider/model>]
                     [--timeout <ms>]

Judges read only compact calibration examples. Missing configuration is
reported as skipped and exits non-zero because no calibration evidence exists.

Environment:
  EVAL_JUDGE_TRANSPORT   opencode (default) or http
  EVAL_JUDGE_MODEL       model for either transport
  EVAL_JUDGE_BASE_URL    HTTP transport base URL
  EVAL_JUDGE_API_KEY     HTTP transport API key

Calibration examples: ${CALIBRATION_DIR}
Default report:       ${path.join(REPORTS_DIR, 'judge-calibration.json')}
`;
}

function parseArgs(argv) {
  const options = {
    report: path.join(REPORTS_DIR, 'judge-calibration.json'),
    calibration: CALIBRATION_DIR,
    transport: null,
    model: null,
    timeoutMs: null,
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
      case '--report':
        options.report = path.resolve(process.cwd(), valueFor(index, argument));
        index += 1;
        break;
      case '--calibration':
        options.calibration = path.resolve(process.cwd(), valueFor(index, argument));
        index += 1;
        break;
      case '--transport':
        options.transport = valueFor(index, argument);
        index += 1;
        break;
      case '--model':
        options.model = valueFor(index, argument);
        index += 1;
        break;
      case '--timeout':
        options.timeoutMs = Number(valueFor(index, argument));
        if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
          throw new Error('--timeout must be a positive number of milliseconds');
        }
        index += 1;
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

async function loadExamples(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();

  if (files.length === 0) {
    throw new Error(`no calibration examples found in ${directory}`);
  }

  const examples = [];
  for (const file of files) {
    const fullPath = path.join(directory, file);
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(fullPath, 'utf8'));
    } catch (error) {
      throw new Error(`calibration ${file} is not valid JSON: ${error.message}`);
    }

    if (!parsed.id || typeof parsed.id !== 'string') {
      throw new Error(`calibration ${file} has no id`);
    }
    if (parsed.label !== 'good' && parsed.label !== 'bad') {
      throw new Error(`calibration ${file} label must be "good" or "bad"`);
    }
    if (!parsed.input || typeof parsed.input !== 'object') {
      throw new Error(`calibration ${file} has no input object`);
    }

    const definition = getScorer(parsed.scorer);

    const threshold = Number(parsed.threshold ?? 0.6);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new Error(`calibration ${file} threshold must be in 0..1`);
    }

    examples.push({
      ...parsed,
      file,
      threshold,
      definition,
    });
  }

  return examples;
}

function formatScore(value) {
  return Number.isFinite(value) ? value.toFixed(2) : '-';
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`agent-evals calibrate: ${error.message}`);
    console.error(usage());
    return 2;
  }

  if (options.help) {
    console.log(usage());
    return 0;
  }

  const config = resolveJudgeConfig({
    transport: options.transport ?? undefined,
    model: options.model ?? undefined,
    timeoutMs: options.timeoutMs ?? JUDGE_TIMEOUT_MS,
  });
  const configView = publicJudgeConfig(config);

  let examples;
  try {
    examples = await loadExamples(options.calibration);
  } catch (error) {
    console.error(`agent-evals calibrate: ${error.message}`);
    return 2;
  }

  const good = examples.filter((example) => example.label === 'good').length;
  const bad = examples.length - good;

  console.log(
    `calibration: ${examples.length} examples (${good} good, ${bad} bad) transport=${configView.transport} model=${configView.model ?? '-'}`,
  );
  if (!config.enabled) {
    console.log(`  judge disabled: ${config.reason}`);
  }

  const results = [];
  let agreed = 0;
  let failures = 0;

  for (const example of examples) {
    const result = await runJudge({
      config,
      rubric: example.definition.rubric,
      input: example.input,
    });

    const actualPass =
      result.status === 'ok' ? result.score >= example.threshold : null;
    const expectedPass = example.label === 'good';
    const agreement = actualPass === expectedPass;

    if (agreement) agreed += 1;
    else failures += 1;

    results.push({
      id: example.id,
      file: example.file,
      scorer: example.scorer,
      label: example.label,
      threshold: example.threshold,
      status: result.status,
      score: result.score,
      rationale: result.rationale,
      model: result.model,
      raw: result.raw,
      error: result.error ?? null,
      expected_pass: expectedPass,
      actual_pass: actualPass,
      agreement,
    });

    const verdict = agreement ? 'PASS' : 'FAIL';
    const scoreText = formatScore(result.score);
    console.log(
      `${verdict} ${example.label.padEnd(4)} ${example.scorer} ${example.id} score=${scoreText} threshold=${formatScore(example.threshold)}`,
    );
    if (result.status !== 'ok') {
      console.log(`     status=${result.status}${result.error ? ` error=${result.error}` : ''}`);
    }
    if (result.rationale) {
      console.log(`     rationale: ${result.rationale.replace(/\s+/g, ' ').trim()}`);
    }
  }

  const agreementRate = results.length === 0 ? 0 : agreed / results.length;
  console.log('');
  console.log(
    `agreement: ${agreed}/${results.length} (${(agreementRate * 100).toFixed(1)}%)`,
  );

  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    command: `node ${SCRIPT_PATH} ${argv.join(' ')}`.trim(),
    judge: configView,
    total: results.length,
    good,
    bad,
    agreed,
    agreement: agreementRate,
    results,
  };

  await fs.mkdir(path.dirname(options.report), { recursive: true });
  await fs.writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`report: ${options.report}`);

  const skippedOrErrored = results.filter((result) => result.status !== 'ok').length;
  if (skippedOrErrored > 0) {
    console.log(
      `calibration incomplete: ${skippedOrErrored} example(s) were skipped or errored`,
    );
  }

  return failures === 0 && skippedOrErrored === 0 ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
