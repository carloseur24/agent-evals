#!/usr/bin/env node
/**
 * Scaffold an eval case, and optionally a fixture, from a known template.
 *
 * A template is a starting point, not a guess: the preset checks describe the
 * shape of the change (fast edit, isolated subagent, delegated plan), not the
 * exact invariant of a real case. Replace them before promotion.
 *
 * Usage:
 *   node scripts/new-case.mjs --id <slug> --prompt <text> [--prompt-file <path>]
 *     [--fixture <name>] [--new-fixture] [--template fast|subagent|delegation]
 *     [--agent <id>] [--model <provider/model>] [--timeout <ms>]
 *     [--expect '<json>'] [--out <path>] [--draft] [--force] [--dry-run]
 *   node scripts/new-case.mjs --from-draft <path> --fixture <name> [--new-fixture]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DRAFTS_DIR } from '../runner/lib/state.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = path.join(ROOT, 'runner');
const CASES_DIR = path.join(RUNNER, 'cases');
const FIXTURES_DIR = path.join(RUNNER, 'fixtures');
const TEMPLATES_DIR = path.join(ROOT, 'templates');
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const TEMPLATES = {
  fast: {
    label: 'fast',
    agent: 'build',
    timeout_ms: 120000,
    fixture_template: 'fixture',
    expect: {
      files_changed: ['src/**', 'styles/**', 'app/**'],
      tests: [{ command: 'node --test', timeout_ms: 60000 }],
      max_lookups_before_first_edit: 4,
      wall_time_max_s: 60,
    },
  },
  subagent: {
    label: 'subagent',
    agent: 'general',
    timeout_ms: 120000,
    fixture_template: 'fixture',
    expect: {
      files_changed: ['src/**'],
      tests: [{ command: 'node --test', timeout_ms: 60000 }],
      wall_time_max_s: 120,
    },
  },
  delegation: {
    label: 'delegation',
    agent: 'plan-orchestrator',
    timeout_ms: 240000,
    fixture_template: 'fixture-delegation',
    expect: {
      parent_code_edits_max: 0,
      parent_plan_globs: ['plans/**'],
      parent_shell_max: 0,
      subagents_min: 2,
      files_changed: ['src/**', 'app/**', 'plans/**'],
      tests: [{ command: 'node test.mjs', timeout_ms: 60000 }],
      final_gate_ran: { command_contains: 'node test.mjs', exit_code: 0 },
      wall_time_max_s: 240,
    },
  },
};

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function usage() {
  return `Scaffold an eval case, and optionally a fixture.

Usage:
  node scripts/new-case.mjs --id <slug> --prompt <text> [--prompt-file <path>]
      [--fixture <name>] [--new-fixture] [--template fast|subagent|delegation]
      [--agent <id>] [--model <provider/model>] [--timeout <ms>]
      [--expect '<json>'] [--out <path>] [--draft] [--force] [--dry-run]
  node scripts/new-case.mjs --from-draft <path> --fixture <name> [--new-fixture]

Options:
  --id <slug>          Required unless --from-draft supplies one. Must match
                       ^[a-z0-9][a-z0-9-]*$.
  --from-draft <path>  Read id, prompt, agent, model, and source_session from a
                       draft captured by from-session.
  --prompt <text>      Case prompt. Use --prompt-file for a long prompt.
  --prompt-file <path> Read the case prompt from a UTF-8 file.
  --fixture <name>     Existing fixture, or the name to create with
                       --new-fixture. Default: the case id.
  --new-fixture        Copy templates/<fixture template>/ to
                       runner/fixtures/<name>/. Never overwrites a fixture.
  --template <name>    fast (default), subagent, or delegation. Inferred from
                       the draft agent with --from-draft.
  --agent <id>         Override the draft or template agent.
  --model <model>      Set model, for example provider/model.
  --source-session <ses_...>  Optional draft-only provenance.
  --notes <text>       Optional case note.
  --timeout <ms>       Override timeout_ms. Must be positive.
  --expect '<json>'    Deep-merge a JSON object over the template expect block.
  --out <path>         Case path. Default: runner/cases/<id>.json.
  --draft              Write to $AGENT_EVALS_STATE/drafts/<id>.json instead
                       (~/.local/state/agent-evals/drafts by default).
  --force              Overwrite the case file only; never a fixture.
  --dry-run            Print the plan and write nothing.
  --help, -h           Show this help.

A template is a starting point. Replace its preset checks with the exact
invariant the case must enforce.
`;
}

function parseArgs(argv) {
  const options = {
    id: null,
    fromDraft: null,
    prompt: null,
    promptFile: null,
    fixture: null,
    newFixture: false,
    template: null,
    agent: null,
    model: null,
    sourceSession: null,
    notes: null,
    timeout: null,
    expect: null,
    out: null,
    draft: false,
    force: false,
    dryRun: false,
    help: false,
  };

  const valueFor = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new CliError(`${flag} requires a value`, 2);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case '--id':
        options.id = valueFor(index, argument);
        index += 1;
        break;
      case '--from-draft':
        options.fromDraft = valueFor(index, argument);
        index += 1;
        break;
      case '--prompt':
        options.prompt = valueFor(index, argument);
        index += 1;
        break;
      case '--prompt-file':
        options.promptFile = valueFor(index, argument);
        index += 1;
        break;
      case '--fixture':
        options.fixture = valueFor(index, argument);
        index += 1;
        break;
      case '--new-fixture':
        options.newFixture = true;
        break;
      case '--template':
        options.template = valueFor(index, argument);
        index += 1;
        break;
      case '--agent':
        options.agent = valueFor(index, argument);
        index += 1;
        break;
      case '--model':
        options.model = valueFor(index, argument);
        index += 1;
        break;
      case '--source-session':
        options.sourceSession = valueFor(index, argument);
        index += 1;
        break;
      case '--notes':
        options.notes = valueFor(index, argument);
        index += 1;
        break;
      case '--timeout':
        options.timeout = valueFor(index, argument);
        index += 1;
        break;
      case '--expect':
        options.expect = valueFor(index, argument);
        index += 1;
        break;
      case '--out':
        options.out = valueFor(index, argument);
        index += 1;
        break;
      case '--draft':
        options.draft = true;
        break;
      case '--force':
        options.force = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new CliError(`unknown argument: ${argument}`, 2);
    }
  }

  return options;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, overlay) {
  if (!isPlainObject(base) || !isPlainObject(overlay)) return structuredClone(overlay);
  const result = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    result[key] =
      isPlainObject(value) && isPlainObject(result[key])
        ? deepMerge(result[key], value)
        : structuredClone(value);
  }
  return result;
}

function readDraft(rawPath) {
  const file = path.resolve(process.cwd(), rawPath);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new CliError(`cannot read draft ${file}: ${error.message}`);
  }
  if (!isPlainObject(data)) {
    throw new CliError('draft must be a JSON object', 2);
  }
  if (typeof data.id !== 'string' || data.id.trim() === '') {
    throw new CliError('draft must contain a non-empty "id"', 2);
  }
  if (typeof data.prompt !== 'string' || data.prompt.trim() === '') {
    throw new CliError('draft must contain a non-empty "prompt"', 2);
  }
  return data;
}

function inferTemplate(agent) {
  if (agent === 'plan-orchestrator') return 'delegation';
  if (agent === 'general') return 'subagent';
  return 'fast';
}

function validateFixtureName(fixture) {
  if (
    fixture.trim() === '' ||
    fixture === '.' ||
    fixture === '..' ||
    path.isAbsolute(fixture) ||
    fixture.includes('/') ||
    fixture.includes('\\')
  ) {
    throw new CliError('--fixture must be a single directory name', 2);
  }
  return fixture;
}

function readPrompt(options, draftPrompt) {
  if (options.prompt !== null && options.promptFile !== null) {
    throw new CliError('use --prompt or --prompt-file, not both', 2);
  }
  if (options.prompt !== null) {
    if (options.prompt.trim() === '') throw new CliError('--prompt must not be empty', 2);
    return options.prompt.trim();
  }
  if (options.promptFile !== null) {
    const file = path.resolve(process.cwd(), options.promptFile);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      throw new CliError(`cannot read prompt file ${file}: ${error.message}`);
    }
    if (text.trim() === '') throw new CliError(`prompt file is empty: ${file}`, 2);
    return text.trim();
  }
  if (typeof draftPrompt === 'string' && draftPrompt.trim() !== '') {
    return draftPrompt.trim();
  }
  throw new CliError('--prompt, --prompt-file, or --from-draft with a prompt is required', 2);
}

function parseExpect(raw) {
  if (raw === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CliError(`--expect is not valid JSON: ${error.message}`, 2);
  }
  if (!isPlainObject(parsed)) {
    throw new CliError('--expect must be a JSON object', 2);
  }
  return parsed;
}

function parseTimeout(raw) {
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new CliError('--timeout must be a positive number of milliseconds', 2);
  }
  return value;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const draft = options.fromDraft ? readDraft(options.fromDraft) : null;
  const id = options.id ?? draft?.id ?? null;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new CliError('--id must match ^[a-z0-9][a-z0-9-]*$', 2);
  }

  const templateName = options.template ?? (draft ? inferTemplate(draft.agent) : 'fast');
  if (!(templateName in TEMPLATES)) {
    throw new CliError(
      `unknown template "${templateName}" (expected ${Object.keys(TEMPLATES).join(', ')})`,
      2,
    );
  }

  const preset = TEMPLATES[templateName];
  const agent =
    options.agent ??
    (typeof draft?.agent === 'string' && draft.agent.trim() !== '' ? draft.agent : preset.agent);
  const model =
    options.model ??
    (typeof draft?.model === 'string' && draft.model.trim() !== '' ? draft.model : null);
  const prompt = readPrompt(options, draft?.prompt ?? null);
  const timeout = parseTimeout(options.timeout) ?? preset.timeout_ms;
  const fixture = validateFixtureName(options.fixture ?? id);

  const extraExpect = parseExpect(options.expect);
  const expect = extraExpect ? deepMerge(preset.expect, extraExpect) : structuredClone(preset.expect);

  const casePath = options.out
    ? path.resolve(process.cwd(), options.out)
    : path.join(options.draft ? DRAFTS_DIR : CASES_DIR, `${id}.json`);
  const underCases = casePath.startsWith(`${CASES_DIR}${path.sep}`);
  const underDrafts =
    casePath.startsWith(`${DRAFTS_DIR}${path.sep}`) ||
    casePath.startsWith(`${path.join(CASES_DIR, 'drafts')}${path.sep}`);
  const notRunnable = options.draft || underDrafts || !underCases;

  const sourceSession = options.sourceSession ?? draft?.source_session ?? null;
  if (sourceSession !== null) {
    if (
      typeof sourceSession !== 'string' ||
      !sourceSession.startsWith('ses_') ||
      sourceSession.length <= 'ses_'.length
    ) {
      throw new CliError('source_session must start with "ses_"', 2);
    }
  }
  if (options.sourceSession !== null && !notRunnable) {
    throw new CliError(
      '--source-session is draft-only; use --draft or an --out path outside runner/cases/',
      2,
    );
  }

  const notes =
    options.notes ??
    (notRunnable && typeof draft?.notes === 'string' && draft.notes.trim() !== ''
      ? draft.notes.trim()
      : null);

  const caseDefinition = {
    id,
    ...(notRunnable && sourceSession ? { source_session: sourceSession } : {}),
    agent,
    ...(model ? { model } : {}),
    timeout_ms: timeout,
    fixture,
    prompt,
    expect,
    ...(notes ? { notes } : {}),
  };

  const fixturePath = path.join(FIXTURES_DIR, fixture);
  const templatePath = path.join(TEMPLATES_DIR, preset.fixture_template);
  const fixtureExists = fs.existsSync(fixturePath);

  if (options.newFixture) {
    if (!fs.existsSync(templatePath) || !fs.statSync(templatePath).isDirectory()) {
      throw new CliError(`fixture template missing: ${templatePath}`);
    }
    if (fixtureExists) {
      throw new CliError(`fixture already exists: ${fixturePath}`);
    }
  } else if (!fixtureExists) {
    throw new CliError(
      `fixture not found: ${fixturePath} (use --new-fixture to copy a template)`,
    );
  } else if (!fs.statSync(fixturePath).isDirectory()) {
    throw new CliError(`fixture is not a directory: ${fixturePath}`);
  }

  const caseExists = fs.existsSync(casePath);
  if (caseExists && !options.force && !options.dryRun) {
    throw new CliError(`case already exists: ${casePath} (use --force)`);
  }

  console.log(
    `case:     ${casePath}${caseExists ? (options.dryRun ? ' (exists)' : ' (overwrite)') : ''}`,
  );
  if (options.newFixture) {
    console.log(`fixture:  ${fixturePath} (copy of ${templatePath})`);
  } else {
    console.log(`fixture:  ${fixturePath} (existing)`);
  }
  console.log(`agent:    ${caseDefinition.agent}`);
  console.log(`timeout:  ${caseDefinition.timeout_ms} ms`);

  if (options.dryRun) {
    console.log('');
    console.log(JSON.stringify(caseDefinition, null, 2));
    if (notRunnable) {
      console.log('');
      console.log(
        'This file is not a runnable case yet; promote it to runner/cases/<id>.json first.',
      );
    }
    console.log('');
    console.log('dry-run: no files written');
    return 0;
  }

  if (options.newFixture) {
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
    fs.cpSync(templatePath, fixturePath, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }

  fs.mkdirSync(path.dirname(casePath), { recursive: true });
  fs.writeFileSync(casePath, `${JSON.stringify(caseDefinition, null, 2)}\n`, 'utf8');

  console.log('');
  console.log('Next:');
  console.log('  node scripts/validate.mjs');
  console.log(`  bash scripts/run.sh --case ${id}`);
  if (notRunnable) {
    console.log('');
    console.log('This file is not a runnable case yet; promote it to runner/cases/<id>.json first.');
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  if (error instanceof CliError) {
    console.error(`new-case: ${error.message}`);
    process.exitCode = error.exitCode;
  } else {
    console.error(`new-case: ${error.message}`);
    process.exitCode = 1;
  }
}
