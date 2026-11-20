#!/usr/bin/env node
/**
 * Capture a real OpenCode session into a draft eval case.
 *
 * The database is opened read-only through runner/lib/trace.mjs. This script
 * never writes to it, never dumps environment values, and bounds tool output to
 * the runner's default. Drafts land in $AGENT_EVALS_STATE/drafts, outside the
 * repository; promotion to a runnable case is a manual step.
 *
 * Usage:
 *   node scripts/from-session.mjs --session <id|title-substring> [--id <slug>]
 *     [--out <path>] [--db <path>] [--prompt <text>] [--trace <path>]
 *     [--force] [--json]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  openDatabase,
  readSession,
  findSessionByTitle,
  readMessages,
  traceSession,
  parseModel,
} from '../runner/lib/trace.mjs';
import { DRAFTS_DIR } from '../runner/lib/state.mjs';

const DEFAULT_DB = path.join(os.homedir(), '.local/share/opencode/opencode.db');
const MAX_OUTPUT_CHARS = 4000;

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function usage() {
  return `Capture a real OpenCode session into a draft eval case.

Usage:
  node scripts/from-session.mjs --session <id|title-substring> [--id <slug>]
      [--out <path>] [--db <path>] [--prompt <text>] [--trace <path>]
      [--force] [--json]

Options:
  --session <value>  Session id (starts with "ses_"), exact title, or unique
                     title substring. Ambiguous matches exit 2 and list them.
  --id <slug>        Draft id. Default: session-<last 8 characters of the id>.
  --out <path>       Draft path. Default: $AGENT_EVALS_STATE/drafts/<id>.json
                     (~/.local/state/agent-evals/drafts by default).
  --db <path>        OpenCode database. Default: OPENCODE_DB or
                     ~/.local/share/opencode/opencode.db.
  --prompt <text>    Override the prompt captured from the first user message.
  --trace <path>     Also write a compact parent/child trace JSON.
  --force            Overwrite an existing draft.
  --json             Print a JSON summary instead of human next steps.
  --help, -h         Show this help.

Drafts live outside the repository, under $AGENT_EVALS_STATE/drafts. Replace the
TODO fixture and add deterministic checks before promoting one to
runner/cases/<id>.json.
`;
}

function parseArgs(argv) {
  const options = {
    session: null,
    id: null,
    out: null,
    db: null,
    prompt: null,
    trace: null,
    force: false,
    json: false,
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
      case '--session':
        options.session = valueFor(index, argument);
        index += 1;
        break;
      case '--id':
        options.id = valueFor(index, argument);
        index += 1;
        break;
      case '--out':
        options.out = valueFor(index, argument);
        index += 1;
        break;
      case '--db':
        options.db = valueFor(index, argument);
        index += 1;
        break;
      case '--prompt':
        options.prompt = valueFor(index, argument);
        index += 1;
        break;
      case '--trace':
        options.trace = valueFor(index, argument);
        index += 1;
        break;
      case '--force':
        options.force = true;
        break;
      case '--json':
        options.json = true;
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

function listMatchingSessions(db, needle) {
  return db
    .prepare(
      `SELECT id, title, agent
       FROM session_v2
       WHERE instr(lower(coalesce(title, '')), lower(?)) > 0
       ORDER BY time_updated DESC`,
    )
    .all(needle)
    .map((row) => ({ ...row }));
}

function resolveSession(db, selection) {
  if (selection.startsWith('ses_')) {
    const row = readSession(db, selection);
    if (!row) throw new CliError(`session not found: ${selection}`);
    return row;
  }

  const exact = findSessionByTitle(db, selection);
  if (exact) return exact;

  const matches = listMatchingSessions(db, selection);
  if (matches.length === 0) {
    throw new CliError(`no session title matches: ${selection}`);
  }
  if (matches.length > 1) {
    const lines = matches.map(
      (row) => `  ${row.id}  ${row.title ?? '(untitled)'}  (agent: ${row.agent ?? 'unknown'})`,
    );
    throw new CliError(
      `session match is ambiguous (${matches.length} sessions):\n${lines.join('\n')}`,
      2,
    );
  }
  const row = readSession(db, matches[0].id);
  if (!row) throw new CliError(`session not found: ${matches[0].id}`);
  return row;
}

function userMessageText(message) {
  const data = message?.data ?? {};
  if (typeof data.text === 'string' && data.text.trim() !== '') return data.text.trim();
  const blocks = [];
  for (const container of [data.content, data.parts]) {
    if (!Array.isArray(container)) continue;
    for (const part of container) {
      if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim() !== '') {
        blocks.push(part.text.trim());
      }
    }
  }
  return blocks.length > 0 ? blocks.join('\n\n') : null;
}

function firstUserPrompt(messages) {
  for (const message of messages ?? []) {
    if (message?.type !== 'user') continue;
    const text = userMessageText(message);
    if (text) return text;
  }
  return null;
}

function roundSeconds(ms) {
  return Math.round((Number(ms ?? 0) / 1000) * 10) / 10;
}

function observedSummary(trace) {
  return {
    title: trace.parent.title ?? '',
    duration_s: roundSeconds(trace.durations?.wall_ms ?? trace.parent.duration_ms),
    tokens: trace.totals?.tokens?.total ?? 0,
    parent_tool_calls: trace.totals?.parent_tool_calls ?? 0,
    child_sessions: trace.children.length,
    child_tool_calls: trace.totals?.child_tool_calls ?? 0,
  };
}

function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function resolveTarget(value) {
  return path.resolve(process.cwd(), value);
}

function humanNextSteps(draft, draftPath, tracePath) {
  console.log(`draft: ${draftPath}`);
  console.log(`source session: ${draft.source_session} (${draft.observed.title || 'untitled'})`);
  console.log(
    `observed: ${draft.observed.parent_tool_calls} parent tool calls, ` +
      `${draft.observed.child_sessions} child sessions, ` +
      `${draft.observed.duration_s}s, ${draft.observed.tokens} tokens`,
  );
  if (tracePath) console.log(`trace: ${tracePath}`);
  console.log('');
  console.log('next:');
  console.log('  1. Reduce the session to the smallest synthetic fixture.');
  console.log('  2. Choose a fixture name and scaffold the case:');
  console.log(
    `     node scripts/new-case.mjs --from-draft ${draftPath} --fixture <fixture> --new-fixture`,
  );
  console.log(
    '     The template is inferred from the draft agent; pass --template to override it.',
  );
  console.log('  3. Replace preset checks with the exact invariant.');
  console.log('  4. node scripts/validate.mjs');
  console.log(`  5. bash scripts/run.sh --case ${draft.id}`);
  console.log('');
  console.log('A draft is ignored by the runner; promotion is manual.');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (!options.session) throw new CliError('--session is required', 2);

  const dbPath = path.resolve(options.db ?? process.env.OPENCODE_DB ?? DEFAULT_DB);
  const db = await openDatabase(dbPath);

  try {
    const row = resolveSession(db, options.session);
    const messages = readMessages(db, row.id);
    const prompt = options.prompt ?? firstUserPrompt(messages);
    if (!prompt || prompt.trim() === '') {
      throw new CliError(`no prompt found in session ${row.id}; pass --prompt`);
    }

    const trace = traceSession(db, row.id, { maxOutputChars: MAX_OUTPUT_CHARS });
    if (!trace) throw new CliError(`could not trace session ${row.id}`);

    const id = options.id ?? `session-${row.id.slice(-8)}`;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      throw new CliError('--id must match ^[a-z0-9][a-z0-9-]*$', 2);
    }

    const model = parseModel(row.model)?.label ?? null;
    const observed = observedSummary(trace);
    const draft = {
      id,
      source_session: row.id,
      agent: row.agent ?? 'build',
      ...(model ? { model } : {}),
      timeout_ms: 600000,
      fixture: 'TODO',
      prompt: prompt.trim(),
      expect: {},
      observed,
      notes:
        `Draft captured from session ${row.id} "${observed.title}". ` +
        'Replace fixture and add deterministic checks.',
    };

    const draftPath = options.out
      ? resolveTarget(options.out)
      : path.join(DRAFTS_DIR, `${id}.json`);
    if (fs.existsSync(draftPath) && !options.force) {
      throw new CliError(`draft already exists: ${draftPath} (use --force)`);
    }
    writeJSON(draftPath, draft);

    let tracePath = null;
    if (options.trace) {
      tracePath = resolveTarget(options.trace);
      writeJSON(tracePath, {
        id,
        source_session: row.id,
        prompt: draft.prompt,
        observed,
        trace,
      });
    }

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            id,
            source_session: row.id,
            agent: draft.agent,
            model,
            fixture: draft.fixture,
            out: draftPath,
            trace: tracePath,
            observed,
          },
          null,
          2,
        ),
      );
    } else {
      humanNextSteps(draft, draftPath, tracePath);
    }
    return 0;
  } finally {
    db.close?.();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    if (error instanceof CliError) {
      console.error(`from-session: ${error.message}`);
      process.exitCode = error.exitCode;
      return;
    }
    console.error(`from-session: ${error.message}`);
    process.exitCode = 1;
  });
