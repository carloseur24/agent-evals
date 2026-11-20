import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Global harness guard.
 *
 * Fast changes: a short prompt naming one file plus a UI value gets a fixed
 * number of lookups. The next lookup is rejected; edit or ask instead.
 *
 * Plan execution: code edits require one subagent call per plan phase. Phases
 * are read from markdown checkboxes (## Phase 1 ... - [ ] task). Plan files may
 * be ticked directly. Child sessions are never gated, so a delegated executor
 * can edit normally.
 *
 * This is a constraint, not advice. Prose cannot enforce either invariant.
 *
 * Modes: HARNESS_GUARD=enforce (default), log, off.
 * Fast budget: HARNESS_GUARD_FAST_MAX (default 4).
 */

const STATE_ROOT = resolve(
  process.env.AGENT_EVALS_STATE || join(homedir(), ".local", "state", "agent-evals"),
);
const LOG_PATH = join(STATE_ROOT, "harness-guard.log");
const MODE = (process.env.HARNESS_GUARD || "enforce").toLowerCase();
const FAST_MAX = Number.parseInt(process.env.HARNESS_GUARD_FAST_MAX || "4", 10);

const FILE_RE =
  /(?:^|[\s`"'(])((?:[\w.-]+\/)*[\w.-]+\.(?:php|css|scss|js|mjs|cjs|ts|tsx|jsx|md|json|html|vue|svelte))(?=$|[\s`"'),:])/i;
const UI_RE =
  /\b(?:px|rem|em|vh|vw|color|background|padding|margin|gap|border|font|width|height|display|opacity|selector|class|copy|label|text)\b/i;
const PLAN_PATH_RE =
  /(?:^|[\s`"'(])((?:[^\s`"')]*\/)?plans\/[^\s`"')]+\.md)\b/i;
const PLAN_FILE_RE = /(?:^|\/)(?:plans|\.omo\/plans|\.sisyphus\/plans)\//i;
const PHASE_RE =
  /^#{1,4}\s+(?:phase|fase|etapa|stage|paso)\s+([\w.-]+)\s*[:.\-]?\s*(.*)$/i;
const TASK_RE = /^\s*[-*]\s+\[([ xX])\]\s+/;
const EXECUTION_RE = /\b(?:execute|implement|work through|continue|resume|run)\b/i;
const THIS_PLAN_RE = /\b(?:this|the)\s+(?:plan|roadmap)\b/i;
const PLAN_WORD_RE = /\b(?:plan|roadmap)\b/i;
const PLAN_EXECUTOR_RE = /plan-executor/i;
const LOOKUP_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "shell",
  "bash",
  "execute",
  "webfetch",
  "search",
  "skill",
]);
const DELEGATION_TOOLS = new Set(["subagent", "task"]);
const DIRECT_MUTATION_TOOLS = new Set(["edit", "write", "apply_patch", "patch"]);
const MUTATING_SHELL_RE =
  /\b(?:sed\s+-i|perl\s+-[a-z]*i|tee\b|truncate\b|rm\b|mv\b|cp\b|touch\b|mkdir\b|chmod\b|chown\b|git\s+apply|git\s+checkout\s+--|git\s+reset\b|git\s+clean\b)\b|\s>{1,2}\s*\S/;

let baseDir = process.cwd();
const sessions = new Map();

function log(line) {
  try {
    mkdirSync(STATE_ROOT, { recursive: true });
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Logging must never break a tool call.
  }
}

function normalizePath(path) {
  if (!path) return "";
  const value = String(path).replace(/\\/g, "/");
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return value;
}

function absolutePath(path) {
  const value = normalizePath(path);
  return isAbsolute(value) ? value : resolve(baseDir, value);
}

export function extractPlanPath(text) {
  const match = String(text || "").match(PLAN_PATH_RE);
  return match ? match[1] : null;
}

export function isPlanFile(args = {}) {
  const path = normalizePath(args.filePath || args.path || "");
  return path.endsWith(".md") && PLAN_FILE_RE.test(path);
}

/**
 * Parse a markdown plan into phases and checkbox tasks.
 * A plan with no phase headings, or no checkboxes at all, becomes one
 * unstructured phase that requires one delegation for the whole plan.
 */
export function parsePlan(text) {
  const lines = String(text || "").split(/\r?\n/);
  const phases = [];
  let current = null;
  let hasTasks = false;

  for (const line of lines) {
    const heading = line.match(PHASE_RE);
    if (heading) {
      current = {
        id: heading[1],
        title: (heading[2] || "").trim(),
        tasks: [],
        complete: false,
      };
      phases.push(current);
      continue;
    }

    const task = line.match(TASK_RE);
    if (!task) continue;

    if (!current) {
      current = { id: "plan", title: "", tasks: [], complete: false };
      phases.push(current);
    }

    current.tasks.push({ checked: task[1].toLowerCase() === "x" });
    hasTasks = true;
  }

  if (phases.length === 0) {
    phases.push({ id: "plan", title: "", tasks: [], complete: false });
  }

  if (!hasTasks) {
    return [{ id: "plan", title: "", tasks: [], complete: false, unstructured: true }];
  }

  for (const phase of phases) {
    phase.complete =
      phase.tasks.length === 0 ||
      phase.tasks.every((task) => task.checked);
  }

  return phases;
}

function firstIncomplete(phases) {
  return phases.findIndex((phase) => !phase.complete);
}

function loadPlan(planPath) {
  if (!planPath) {
    return [{ id: "plan", title: "", tasks: [], complete: false, unstructured: true }];
  }
  try {
    return parsePlan(readFileSync(absolutePath(planPath), "utf8"));
  } catch (error) {
    log(`plan-read-failed path=${planPath} error=${error?.message || error}`);
    return [{ id: "plan", title: "", tasks: [], complete: false, unstructured: true }];
  }
}

function refreshPlan(state) {
  if (!state.plan) return;
  state.phases = loadPlan(state.planPath);
  state.currentPhase = firstIncomplete(state.phases);
}

function sessionFor(sessionID) {
  let state = sessions.get(sessionID);
  if (!state) {
    state = {
      fast: false,
      plan: false,
      fastLookups: 0,
      fastDone: false,
      delegated: false,
      planPath: null,
      phases: [],
      currentPhase: -1,
      delegatedPhases: new Set(),
    };
    sessions.set(sessionID, state);
  }
  return state;
}

function resetSession(sessionID, text, isChild = false) {
  const fast = !isChild && isFastPrompt(text);
  const plan = !isChild && isPlanPrompt(text);
  const planPath = plan ? extractPlanPath(text) : null;
  const phases = plan ? loadPlan(planPath) : [];

  sessions.set(sessionID, {
    fast,
    plan,
    fastLookups: 0,
    fastDone: false,
    delegated: false,
    planPath,
    phases,
    currentPhase: plan ? firstIncomplete(phases) : -1,
    delegatedPhases: new Set(),
  });
  log(
    `start session=${sessionID} fast=${fast} plan=${plan} child=${isChild} phase=${plan ? firstIncomplete(phases) + 1 : 0} mode=${MODE} chars=${String(text || "").length}`,
  );
}

export function isFastPrompt(text) {
  const value = String(text || "").trim();
  if (!value || value.length > 700) return false;
  if (PLAN_EXECUTOR_RE.test(value)) return false;
  if (PLAN_WORD_RE.test(value) || /\b(?:delegate|subagent|architecture|refactor|migration|schema)\b/i.test(value)) {
    return false;
  }
  return FILE_RE.test(value) && UI_RE.test(value);
}

export function isPlanPrompt(text) {
  const value = String(text || "");
  if (PLAN_EXECUTOR_RE.test(value)) return true;
  if (extractPlanPath(value) && EXECUTION_RE.test(value)) return true;
  return EXECUTION_RE.test(value) && THIS_PLAN_RE.test(value);
}

export function isDirectMutation(tool, args = {}) {
  if (DIRECT_MUTATION_TOOLS.has(tool)) return true;
  if (tool === "shell" || tool === "bash") {
    const command = String(args.command || args.cmd || "");
    return MUTATING_SHELL_RE.test(command);
  }
  return false;
}

function deny(sessionID, reason) {
  const message = `HarnessGuard: ${reason}`;
  if (MODE === "log") {
    log(`would_block session=${sessionID} ${reason}`);
    return;
  }
  log(`block session=${sessionID} ${reason}`);
  throw new Error(message);
}

function explicitPhase(args = {}) {
  const raw = args.phase ?? args.phaseNumber ?? args.phase_number;
  if (raw === undefined || raw === null || raw === "") return null;
  const match = String(raw).match(/(\d+)/);
  if (!match) return null;
  return Number.parseInt(match[1], 10) - 1;
}

/**
 * Pure policy decision point. Returns true when the call must be blocked.
 * Kept separate from the hook so it is testable without OpenCode.
 */
export function shouldBlock(sessionID, tool, args = {}) {
  if (MODE === "off") return false;
  const state = sessionFor(sessionID);

  if (DELEGATION_TOOLS.has(tool)) {
    state.delegated = true;
    state.fastDone = true;
    if (state.plan) {
      refreshPlan(state);
      const phase = explicitPhase(args);
      const target = phase === null ? state.currentPhase : phase;
      if (target >= 0 && target < state.phases.length) {
        state.delegatedPhases.add(target);
        log(`delegated session=${sessionID} tool=${tool} phase=${target + 1}`);
      } else {
        log(`delegated session=${sessionID} tool=${tool} phase=none`);
      }
    } else {
      log(`delegated session=${sessionID} tool=${tool}`);
    }
    return false;
  }

  if (state.plan) {
    refreshPlan(state);
    if (isDirectMutation(tool, args) && !isPlanFile(args)) {
      const phase = state.currentPhase;
      if (phase >= 0 && !state.delegatedPhases.has(phase)) {
        deny(
          sessionID,
          `plan phase ${phase + 1} is not delegated. Call the subagent tool for this phase before editing files.`,
        );
        return MODE !== "log";
      }
    }
  }

  if (state.fast && !state.fastDone) {
    if (tool === "edit" || tool === "write") {
      state.fastDone = true;
      return false;
    }
    if (tool === "question") {
      state.fastDone = true;
      return false;
    }
    if (LOOKUP_TOOLS.has(tool)) {
      state.fastLookups += 1;
      if (state.fastLookups > FAST_MAX) {
        deny(
          sessionID,
          `fast-change budget exhausted after ${FAST_MAX} lookups. Make the edit now or ask one concrete question.`,
        );
        return MODE !== "log";
      }
    }
  }

  return false;
}

function partsText(parts = []) {
  return parts
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/**
 * V2 plugin entry point. OpenCode calls setup once and the hooks stay registered.
 */
export async function setup(ctx) {
  baseDir = ctx.location?.directory || process.cwd();
  log(`loaded mode=${MODE} fastMax=${FAST_MAX} dir=${baseDir}`);

  await ctx.session.hook("prompt", async (event) => {
    const text = event?.prompt?.text;
    if (typeof text !== "string" || !text.trim()) return;
    const sessionID = event.sessionID || "default";

    let isChild = false;
    try {
      const session = await ctx.session.get({ sessionID });
      isChild = Boolean(session?.parentID);
    } catch (error) {
      log(`session-get-failed session=${sessionID} error=${error?.message || error}`);
    }

    resetSession(sessionID, text, isChild);
  });

  await ctx.tool.hook("execute.before", (event) => {
    shouldBlock(event.sessionID || "default", event.tool, event.input || {});
  });
}

/**
 * V1 compatibility entry point. V1 loads the named export and calls it.
 */
export async function HarnessGuard() {
  log(`loaded-v1 mode=${MODE} fastMax=${FAST_MAX}`);
  return {
    "chat.message": async (input, output) => {
      const text = partsText(output?.parts || []);
      const role = output?.message?.role;
      if ((!role || role === "user") && text.trim()) {
        resetSession(input.sessionID, text);
      }
    },
    "tool.execute.before": async (input, output) => {
      shouldBlock(input.sessionID, input.tool, output?.args || {});
    },
  };
}

export default {
  id: "harness-guard",
  setup,
};
