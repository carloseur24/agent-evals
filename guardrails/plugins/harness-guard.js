import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

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
 * Protected branches: a git write (commit, push, merge) is refused while the
 * current branch is main or master, in every session including child sessions.
 * A push that names main or master as its refspec is refused from any branch.
 * A write also requires a conforming branch name:
 *   <repo-folder>/<type>-<short-description>
 * where <type> is feat, fix, chore, docs, test, refactor, perf, ci, build, or
 * style. The prefix is the repository folder name (resolved from the common git
 * dir), so renaming the checkout changes it automatically. Creating a branch
 * with git switch -c or git checkout -b is allowed only when the new name
 * matches. Read-only git commands are unaffected.
 *
 * Shell wrappers are unwrapped before the git check: `bash -c "git commit"`,
 * `sh -c`, `env git commit`, `sudo git ...`, and `... | xargs git commit` are
 * judged as the git command they run. The repository is resolved from an
 * explicit workdir, `git -C <dir>`, or a leading `cd <dir>`, then the session
 * directory, so a command is judged against the repo it actually touches.
 *
 * This is a constraint, not advice. Prose cannot enforce any invariant.
 *
 * Modes: HARNESS_GUARD=enforce (default), log, off.
 * Fast budget: HARNESS_GUARD_FAST_MAX (default 4).
 */

const STATE_ROOT = resolve(
  process.env.AGENT_EVALS_STATE || join(homedir(), ".local", "state", "agent-evals"),
);
const LOG_PATH = join(STATE_ROOT, "harness-guard.log");
const FAST_MAX = Number.parseInt(process.env.HARNESS_GUARD_FAST_MAX || "4", 10);
const PROTECTED_BRANCHES = new Set(["main", "master"]);
const BRANCH_TYPES = [
  "feat",
  "fix",
  "chore",
  "docs",
  "test",
  "refactor",
  "perf",
  "ci",
  "build",
  "style",
];
const GIT_WRITE_RE =
  /^\s*(?:\(\s*)?(?:(?:[A-Za-z_]\w*=\S*)\s+)*(?:command\s+|exec\s+)?git(?:\s+(?:-C\s+(?:\S+|"[^"]*"|'[^']*')|-c\s+(?:\S+|"[^"]*"|'[^']*')|--?[\w-]+(?:=\S+)?))*\s+(commit|push|merge)\b/;
const GIT_CREATE_RE =
  /^\s*(?:\(\s*)?(?:(?:[A-Za-z_]\w*=\S*)\s+)*(?:command\s+|exec\s+)?git(?:\s+(?:-C\s+(?:\S+|"[^"]*"|'[^']*')|-c\s+(?:\S+|"[^"]*"|'[^']*')|--?[\w-]+(?:=\S+)?))*\s+(?:switch|checkout)\s+(?:-[\w-]+\s+)*(?:-c|-C|-b|-B|--create|--force-create|--branch)\s+(\S+)/;
const COMMAND_TOOLS = new Set(["shell", "bash"]);

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
const SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const WRAPPER_COMMANDS = new Set([
  "env",
  "command",
  "exec",
  "nohup",
  "time",
  "sudo",
  "xargs",
  "builtin",
  "stdbuf",
]);

let baseDir = process.cwd();
const sessions = new Map();

function currentMode() {
  return (process.env.HARNESS_GUARD || "enforce").toLowerCase();
}

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

function absolutePath(path, cwd = baseDir) {
  const value = normalizePath(path);
  return isAbsolute(value) ? value : resolve(cwd, value);
}

function commandSegments(command) {
  return String(command || "").split(/\r?\n|;|&&|\|\||\|/);
}

function shellWords(text) {
  const words = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    words.push(match[1] ?? match[2] ?? match[3]);
  }
  return words;
}

/**
 * Expand one command segment into every command it can actually run. Shell
 * interpreters (`bash -c "<script>"`) and pass-through wrappers (`env`,
 * `command`, `exec`, `nohup`, `time`, `sudo`, `xargs`, ...) are unwrapped so a
 * git write cannot hide behind them.
 */
function commandCandidates(segment) {
  const candidates = [];
  const visit = (text, depth) => {
    const value = String(text || "").trim();
    if (!value || depth > 4) return;

    const words = shellWords(value);
    if (words.length === 0) return;

    let index = 0;
    while (index < words.length && /^[A-Za-z_]\w*=/.test(words[index])) index += 1;
    const head = words[index];
    if (!head) return;

    if (SHELL_INTERPRETERS.has(head)) {
      const flagIndex = words.findIndex(
        (word, position) =>
          position > index && /^-[A-Za-z]*c[A-Za-z]*$/.test(word),
      );
      const script = flagIndex === -1 ? "" : words[flagIndex + 1];
      if (script) {
        candidates.push(script);
        visit(script, depth + 1);
      }
      return;
    }

    if (WRAPPER_COMMANDS.has(head)) {
      let position = index + 1;
      while (
        position < words.length &&
        (words[position].startsWith("-") || /^[A-Za-z_]\w*=/.test(words[position]))
      ) {
        position += 1;
      }
      const rest = words.slice(position).join(" ");
      if (rest) {
        candidates.push(rest);
        visit(rest, depth + 1);
      }
      return;
    }

    candidates.push(words.slice(index).join(" "));
  };

  visit(segment, 0);
  return candidates;
}

function stripQuotes(value) {
  return String(value || "").replace(/^["']|["']$/g, "");
}

/** Directory named by `git -C <dir>`, if any. */
function gitDirFromCommand(command) {
  const match = String(command || "").match(/\bgit\s+-C\s+("[^"]+"|'[^']*'|\S+)/);
  return match ? stripQuotes(match[1]) : null;
}

/** Directory named by a leading `cd <dir>` in the command, if any. */
function cdDirFromCommand(command) {
  const match = String(command || "").match(
    /(?:^|\n|;|&&)\s*cd\s+("[^"]+"|'[^']*'|\S+)/,
  );
  return match ? stripQuotes(match[1]) : null;
}

function protectedRefspec(refspec) {
  const value = String(refspec || "").replace(/^\+/, "");
  const destination = value.includes(":") ? value.split(":").pop() : value;
  const name = destination.replace(/^refs\/heads\//, "");
  return PROTECTED_BRANCHES.has(name) ? name : null;
}

function pushTargetsProtected(tail) {
  const words = shellWords(tail);
  if (words.includes("--all") || words.includes("--mirror")) {
    return "all branches, including protected ones";
  }
  const positionals = words.filter((word) => !word.startsWith("-"));
  // The first positional is the remote; every later one is a refspec.
  for (const refspec of positionals.slice(1)) {
    const branch = protectedRefspec(refspec);
    if (branch) return `protected branch "${branch}"`;
  }
  return null;
}

function gitOutput(repoDir, args) {
  try {
    return execFileSync("git", ["-C", repoDir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  } catch {
    return "";
  }
}

function currentBranch(repoDir) {
  for (const args of [
    ["branch", "--show-current"],
    ["rev-parse", "--abbrev-ref", "HEAD"],
  ]) {
    const branch = gitOutput(repoDir, args);
    if (branch && branch !== "HEAD") return branch;
  }
  return null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Repository name used as the branch prefix. The common git dir keeps this
 * correct inside a worktree, where the checkout directory has another name.
 */
function repoName(repoDir) {
  for (const args of [
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    ["rev-parse", "--show-toplevel"],
  ]) {
    const location = gitOutput(repoDir, args);
    if (!location) continue;
    const name = basename(location.replace(/[\\/]\.git$/, "").replace(/\.git$/, ""));
    if (name) return name;
  }
  return basename(resolve(repoDir));
}

function branchConvention(repoDir) {
  const repo = repoName(repoDir);
  return {
    pattern: new RegExp(
      `^${escapeRegExp(repo)}/(?:${BRANCH_TYPES.join("|")})-[a-z0-9][a-z0-9-]*$`,
    ),
    description: `${repo}/<type>-<short-description>`,
    types: BRANCH_TYPES.join(", "),
  };
}

function repoDirFor(args = {}) {
  const workdir = args.cwd || args.workdir;
  const command = shellCommand("shell", args);
  const gitDir = gitDirFromCommand(command);
  if (gitDir) return absolutePath(gitDir, workdir);
  const cdDir = cdDirFromCommand(command);
  if (cdDir) return absolutePath(cdDir, workdir);
  if (workdir) return absolutePath(workdir);
  return baseDir;
}

function shellCommand(tool, args = {}) {
  if (!COMMAND_TOOLS.has(tool)) return "";
  return String(args.command || args.cmd || "");
}

function conventionReason(name, convention) {
  return `branch "${name}" does not match ${convention.description} (allowed types: ${convention.types}). Switch to a conforming branch before writing to git.`;
}

/**
 * Returns a denial reason for a git write on a protected branch or a branch
 * that breaks the naming convention, and for creation of a non-conforming
 * branch. An unknown branch (not a repo, detached HEAD) is not blocked.
 */
function gitBranchViolation(command, repoDir) {
  const convention = branchConvention(repoDir);
  for (const segment of commandSegments(command)) {
    for (const candidate of commandCandidates(segment)) {
      const create = candidate.match(GIT_CREATE_RE);
      if (create) {
        const name = stripQuotes(create[1]);
        if (!convention.pattern.test(name)) return conventionReason(name, convention);
        continue;
      }

      const match = candidate.match(GIT_WRITE_RE);
      if (!match) continue;
      const verb = match[1].toLowerCase();
      if (verb === "push") {
        const target = pushTargetsProtected(
          candidate.slice(match.index + match[0].length),
        );
        if (target) {
          return `git push targets ${target}. Push a feature branch or open a pull request.`;
        }
      }
      const branch = currentBranch(repoDir);
      if (!branch) continue;
      if (PROTECTED_BRANCHES.has(branch)) {
        return `protected branch "${branch}": git ${verb} is blocked. Switch to a feature branch before writing to git.`;
      }
      if (!convention.pattern.test(branch)) return conventionReason(branch, convention);
    }
  }
  return null;
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
    `start session=${sessionID} fast=${fast} plan=${plan} child=${isChild} phase=${plan ? firstIncomplete(phases) + 1 : 0} mode=${currentMode()} chars=${String(text || "").length}`,
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
  if (currentMode() === "log") {
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
 * True when the delegation call itself names the phase it executes. An explicit
 * `phase` argument always counts; otherwise the description/prompt/title must
 * mention `Phase N` (or the Spanish/alternate spellings). This stops an
 * unrelated subagent call from unlocking the current phase.
 */
function delegationTargetsPhase(args = {}, index) {
  if (index < 0) return false;
  if (explicitPhase(args) !== null) return true;

  const number = index + 1;
  const text = ["description", "prompt", "title", "message", "name"]
    .filter((key) => typeof args[key] === "string")
    .map((key) => args[key])
    .join("\n");
  if (!text) return false;

  return new RegExp(
    `\\b(?:phase|fase|etapa|stage|paso)\\s*#?\\s*${number}\\b`,
    "i",
  ).test(text);
}

/**
 * Pure policy decision point. Returns true when the call must be blocked.
 * Kept separate from the hook so it is testable without OpenCode.
 */
export function shouldBlock(sessionID, tool, args = {}) {
  if (currentMode() === "off") return false;
  const state = sessionFor(sessionID);

  if (DELEGATION_TOOLS.has(tool)) {
    state.delegated = true;
    state.fastDone = true;
    if (state.plan) {
      refreshPlan(state);
      const phase = explicitPhase(args);
      const target = phase === null ? state.currentPhase : phase;
      const phaseID = target >= 0 ? String(state.phases[target]?.id ?? "") : "";
      const structured = /^\d+$/.test(phaseID);
      const targetsCurrent = delegationTargetsPhase(args, state.currentPhase);
      if (target >= 0 && target < state.phases.length && (!structured || targetsCurrent)) {
        state.delegatedPhases.add(target);
        log(`delegated session=${sessionID} tool=${tool} phase=${target + 1}`);
      } else if (target >= 0 && target < state.phases.length) {
        log(
          `delegated session=${sessionID} tool=${tool} phase=unmatched current=${state.currentPhase + 1}`,
        );
      } else {
        log(`delegated session=${sessionID} tool=${tool} phase=none`);
      }
    } else {
      log(`delegated session=${sessionID} tool=${tool}`);
    }
    return false;
  }

  const command = shellCommand(tool, args);
  if (command) {
    const violation = gitBranchViolation(command, repoDirFor(args));
    if (violation) {
      deny(sessionID, violation);
      return currentMode() !== "log";
    }
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
        return currentMode() !== "log";
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
        return currentMode() !== "log";
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
  log(`loaded mode=${currentMode()} fastMax=${FAST_MAX} dir=${baseDir}`);

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
  log(`loaded-v1 mode=${currentMode()} fastMax=${FAST_MAX}`);
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
