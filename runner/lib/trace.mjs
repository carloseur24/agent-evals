/**
 * Read-only session tracing for the Agent Evals runner.
 *
 * OpenCode stores one row per session in `session_v2` and one row per message in
 * `session_message`. Assistant message `data.content` is an array of parts; a
 * part with `type: "tool"` carries the tool name, its input, and the tool output
 * inside `state.content[].text`.
 *
 * The database is opened read-only. Nothing here writes to it.
 */

import fs from 'node:fs/promises';

let sqliteModulePromise = null;

async function loadSqlite() {
  if (!sqliteModulePromise) {
    sqliteModulePromise = (async () => {
      // node:sqlite is still flagged experimental; importing it emits a warning
      // on stderr. Silence only that import so the runner's output stays clean.
      const originalEmitWarning = process.emitWarning;
      process.emitWarning = () => {};
      try {
        return await import('node:sqlite');
      } finally {
        process.emitWarning = originalEmitWarning;
      }
    })();
  }
  return sqliteModulePromise;
}

/**
 * Open the OpenCode database read-only.
 * @param {string} dbPath
 */
export async function openDatabase(dbPath) {
  const stat = await fs.stat(dbPath).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error(`OpenCode database not found: ${dbPath}`);
  }
  const { DatabaseSync } = await loadSqlite();
  return new DatabaseSync(dbPath, { readOnly: true });
}

function plain(row) {
  return row ? { ...row } : null;
}

function iso(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function parseJson(text) {
  if (typeof text !== 'string') return text ?? null;
  try {
    return JSON.parse(text);
  } catch {
    return { __parse_error: true, raw: text.slice(0, 1000) };
  }
}

function truncate(text, maxChars) {
  const value = String(text ?? '');
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…[truncated ${value.length - maxChars} chars]`;
}

function parseModel(raw) {
  if (!raw) return null;
  const value = typeof raw === 'string' ? parseJson(raw) : raw;
  if (!value || typeof value !== 'object') return { label: String(raw) };
  const provider = value.providerID ?? value.provider_id ?? value.provider ?? null;
  const id = value.id ?? value.modelID ?? value.model ?? null;
  const variant = value.variant ?? null;
  return {
    provider_id: provider,
    id,
    variant,
    label: provider && id ? `${provider}/${id}${variant ? `#${variant}` : ''}` : id ?? null,
  };
}

function sumTokens(rows) {
  const total = {
    input: 0,
    output: 0,
    reasoning: 0,
    cache_read: 0,
    cache_write: 0,
  };
  for (const row of rows) {
    total.input += Number(row?.input ?? 0);
    total.output += Number(row?.output ?? 0);
    total.reasoning += Number(row?.reasoning ?? 0);
    total.cache_read += Number(row?.cache_read ?? 0);
    total.cache_write += Number(row?.cache_write ?? 0);
  }
  total.total =
    total.input + total.output + total.reasoning + total.cache_read + total.cache_write;
  return total;
}

/** Convert a raw `session_v2` row into the trace report shape (pure). */
export function mapSessionRow(row) {
  if (!row) return null;
  const created = Number(row.time_created ?? 0);
  const updated = Number(row.time_updated ?? created);
  return {
    id: row.id,
    parent_id: row.parent_id ?? null,
    title: row.title ?? null,
    directory: row.directory ?? null,
    agent: row.agent ?? null,
    model: parseModel(row.model),
    started_at: iso(created),
    finished_at: iso(updated),
    duration_ms: Math.max(0, updated - created),
    tokens: {
      input: Number(row.tokens_input ?? 0),
      output: Number(row.tokens_output ?? 0),
      reasoning: Number(row.tokens_reasoning ?? 0),
      cache_read: Number(row.tokens_cache_read ?? 0),
      cache_write: Number(row.tokens_cache_write ?? 0),
    },
    cost: Number(row.cost ?? 0),
    message_count: 0,
    user_message_count: 0,
    assistant_message_count: 0,
    tool_count: 0,
    tool_calls: [],
  };
}

function boundedInput(input, maxStringChars = 4000) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'string') return truncate(input, maxStringChars);
  if (typeof input !== 'object') return input;
  if (Array.isArray(input)) {
    return input.map((item) => (typeof item === 'string' ? truncate(item, maxStringChars) : item));
  }
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    result[key] =
      typeof value === 'string' ? truncate(value, maxStringChars) : value;
  }
  return result;
}

function outputText(state, maxOutputChars) {
  const parts = [];
  for (const part of state?.content ?? []) {
    if (typeof part?.text === 'string') parts.push(part.text);
  }
  if (parts.length === 0 && state?.error !== undefined && state?.error !== null) {
    parts.push(
      typeof state.error === 'string' ? state.error : JSON.stringify(state.error),
    );
  }
  if (parts.length === 0 && state?.metadata !== undefined) {
    parts.push(JSON.stringify(state.metadata));
  }
  return truncate(parts.join('\n'), maxOutputChars);
}

/**
 * Extract tool calls from parsed `session_message` rows (pure).
 *
 * @param {Array<{type: string, seq: number, time_created: number, data: any}>} messages
 * @param {{maxOutputChars?: number}} options
 */
export function extractToolCalls(messages, { maxOutputChars = 4000 } = {}) {
  const calls = [];
  for (const message of messages ?? []) {
    if (message?.type !== 'assistant') continue;
    const content = message?.data?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type !== 'tool') continue;
      const state = part.state ?? {};
      calls.push({
        call_id: part.id ?? null,
        name: part.name ?? 'unknown',
        status: state.status ?? null,
        title: state.title ?? null,
        input: boundedInput(state.input),
        output: outputText(state, maxOutputChars),
        exit_code: state.metadata?.exit ?? null,
        message_seq: message.seq ?? null,
        time_created: part.time?.created ?? message.time_created ?? null,
        time_completed: part.time?.completed ?? null,
      });
    }
  }
  return calls;
}

function buildTrajectory(row, messages, maxOutputChars) {
  const trajectory = mapSessionRow(row);
  const rows = messages ?? [];
  const calls = extractToolCalls(rows, { maxOutputChars });
  trajectory.message_count = rows.length;
  trajectory.user_message_count = rows.filter((message) => message.type === 'user').length;
  trajectory.assistant_message_count = rows.filter(
    (message) => message.type === 'assistant',
  ).length;
  trajectory.tool_calls = calls;
  trajectory.tool_count = calls.length;
  const textBlocks = extractAssistantText(rows);
  trajectory.assistant_text = truncate(textBlocks.join('\n\n'), 16000);
  trajectory.final_text = truncate(textBlocks[textBlocks.length - 1] ?? '', 8000);
  return trajectory;
}

/** Text parts written by the assistant, in message order (pure). */
export function extractAssistantText(messages) {
  const blocks = [];
  for (const message of messages ?? []) {
    if (message?.type !== 'assistant') continue;
    const content = message?.data?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join('\n')
      .trim();
    if (text) blocks.push(text);
  }
  return blocks;
}

/**
 * Assemble a parent/child trace from rows and pre-read messages (pure).
 * Used by the real database path and by the dry-run self-test.
 *
 * @param {{
 *   parentRow: object,
 *   childRows?: object[],
 *   messagesBySession?: Map<string, object[]>,
 *   maxOutputChars?: number,
 * }} input
 */
export function assembleTrace({
  parentRow,
  childRows = [],
  messagesBySession = new Map(),
  maxOutputChars = 4000,
}) {
  if (!parentRow) return null;
  const parent = buildTrajectory(
    parentRow,
    messagesBySession.get(parentRow.id) ?? [],
    maxOutputChars,
  );
  const children = [...childRows]
    .sort((left, right) => Number(left.time_created) - Number(right.time_created))
    .map((row) =>
      buildTrajectory(row, messagesBySession.get(row.id) ?? [], maxOutputChars),
    );

  const all = [parent, ...children];
  return {
    parent,
    children,
    totals: {
      sessions: all.length,
      parent_tool_calls: parent.tool_count,
      child_tool_calls: children.reduce((sum, child) => sum + child.tool_count, 0),
      tool_calls: all.reduce((sum, session) => sum + session.tool_count, 0),
      tokens: sumTokens(all.map((session) => session.tokens)),
      cost: all.reduce((sum, session) => sum + Number(session.cost ?? 0), 0),
    },
    durations: {
      parent_ms: parent.duration_ms,
      children_ms: children.reduce((sum, child) => sum + child.duration_ms, 0),
      wall_ms: parent.duration_ms,
    },
  };
}

/** Find a session by its unique eval title. */
export function findSessionByTitle(db, title) {
  const row = db
    .prepare(
      `SELECT * FROM session_v2
       WHERE title = ?
       ORDER BY time_created DESC
       LIMIT 1`,
    )
    .get(title);
  return plain(row);
}

/**
 * Fallback lookup for a parent session created in a unique workspace.
 * Sessions spawned by the title agent can be renamed, but the directory stays.
 */
export function findSessionByDirectory(db, directory, sinceMs) {
  const row = db
    .prepare(
      `SELECT * FROM session_v2
       WHERE directory = ?
         AND time_created >= ?
         AND (parent_id IS NULL OR parent_id = '')
       ORDER BY time_created DESC
       LIMIT 1`,
    )
    .get(directory, Number(sinceMs ?? 0));
  return plain(row);
}

export function readSession(db, sessionId) {
  const row = db.prepare('SELECT * FROM session_v2 WHERE id = ?').get(sessionId);
  return plain(row);
}

export function listChildren(db, parentId) {
  return db
    .prepare(
      `SELECT * FROM session_v2
       WHERE parent_id = ?
       ORDER BY time_created ASC`,
    )
    .all(parentId)
    .map(plain);
}

export function readMessages(db, sessionId) {
  return db
    .prepare(
      `SELECT id, type, seq, time_created, time_updated, data
       FROM session_message
       WHERE session_id = ?
       ORDER BY seq ASC`,
    )
    .all(sessionId)
    .map((row) => ({
      id: row.id,
      type: row.type,
      seq: row.seq,
      time_created: row.time_created,
      time_updated: row.time_updated,
      data: parseJson(row.data),
    }));
}

/**
 * Read a parent session and its direct children from the database.
 * Direct children are one level deep, exactly the parent/child split the
 * delegation evals score.
 */
export function traceSession(db, parentId, { maxOutputChars = 4000 } = {}) {
  const parentRow = readSession(db, parentId);
  if (!parentRow) return null;
  const childRows = listChildren(db, parentId);
  const messagesBySession = new Map();
  messagesBySession.set(parentId, readMessages(db, parentId));
  for (const child of childRows) {
    messagesBySession.set(child.id, readMessages(db, child.id));
  }
  return assembleTrace({ parentRow, childRows, messagesBySession, maxOutputChars });
}

export { parseModel };
