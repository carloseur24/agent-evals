import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin, {
  extractPlanPath,
  isFastPrompt,
  isPlanPrompt,
  isDirectMutation,
  isPlanFile,
  parsePlan,
  shouldBlock,
} from "../plugins/harness-guard.js";

// Enforcement is what these tests assert; pin it regardless of the caller.
const originalMode = process.env.HARNESS_GUARD;
process.env.HARNESS_GUARD = "enforce";

const hooks = {};
const parentIDs = new Map();
const ctx = {
  location: { directory: process.cwd() },
  session: {
    hook: async (name, callback) => {
      hooks[name] = callback;
    },
    get: async ({ sessionID }) => ({ parentID: parentIDs.get(sessionID) }),
  },
  tool: {
    hook: async (name, callback) => {
      hooks[name] = callback;
    },
  },
};

await plugin.setup(ctx);
assert.equal(typeof hooks.prompt, "function");
assert.equal(typeof hooks["execute.before"], "function");

const prompt = (sessionID, text) =>
  hooks.prompt({ sessionID, prompt: { text } });
const before = (sessionID, tool, input = {}) =>
  hooks["execute.before"]({ sessionID, tool, input });

const root = mkdtempSync(join(tmpdir(), "harness-guard-"));
const plans = join(root, "plans");
mkdirSync(plans);
const planPath = join(plans, "refactor.md");
const phaseOneOpen = `# Refactor

## Phase 1: Schema
- [ ] add migration

## Phase 2: API
- [ ] add endpoint
`;
writeFileSync(planPath, phaseOneOpen);

assert.equal(isFastPrompt("in assets/css/widgets.style.css change padding to 1rem"), true);
assert.equal(isFastPrompt("in assets/css/widgets.style.css rewrite the whole module layout"), false);
assert.equal(isFastPrompt("open docs/plans/refactor.md and execute the plan"), false);
assert.equal(isPlanPrompt(`execute ${planPath} now`), true);
assert.equal(isPlanPrompt("implement this plan now"), true);
assert.equal(isPlanPrompt("implement a plan for the new settings page"), false);
assert.equal(extractPlanPath(`execute ${planPath} now`), planPath);
assert.equal(isPlanFile({ filePath: planPath }), true);
assert.equal(isPlanFile({ filePath: "app/Foo.php" }), false);

const parsed = parsePlan(phaseOneOpen);
assert.equal(parsed.length, 2);
assert.equal(parsed[0].id, "1");
assert.equal(parsed[0].tasks.length, 1);
assert.equal(parsed[0].complete, false);

assert.equal(isDirectMutation("edit", {}), true);
assert.equal(isDirectMutation("shell", { command: "git status --short" }), false);
assert.equal(isDirectMutation("shell", { command: "sed -i 's/a/b/' foo.css" }), true);
assert.equal(isDirectMutation("shell", { command: "cat foo.css > bar.css" }), true);

// Fast budget: four lookups, then edit or ask.
await prompt("fast", "in assets/css/widgets.style.css change padding to 1rem");
for (let i = 0; i < 4; i += 1) {
  await before("fast", "read", { filePath: "assets/css/widgets.style.css" });
}
await assert.rejects(
  async () => {
    await before("fast", "read", { filePath: "assets/css/widgets.style.css" });
  },
  /fast-change budget exhausted/,
);
await before("fast", "edit", { filePath: "assets/css/widgets.style.css" });
await before("fast", "read", { filePath: "assets/css/widgets.style.css" });

// Per-phase plan gate.
await prompt("plan", `execute ${planPath} now`);
await assert.rejects(
  async () => {
    await before("plan", "edit", { filePath: "app/Foo.php" });
  },
  /phase 1 is not delegated/,
);
await before("plan", "edit", { filePath: planPath });
await before("plan", "subagent", { agent: "general", description: "Phase 1" });
await before("plan", "edit", { filePath: "app/Foo.php" });

// A delegation that does not name the current phase unlocks nothing.
await prompt("plan2", `execute ${planPath} now`);
await before("plan2", "subagent", { agent: "general", description: "general cleanup" });
await assert.rejects(
  async () => {
    await before("plan2", "edit", { filePath: "app/Unrelated.php" });
  },
  /phase 1 is not delegated/,
);
await before("plan2", "subagent", { agent: "general", description: "Phase 1 work" });
await before("plan2", "edit", { filePath: "app/Unrelated.php" });

writeFileSync(planPath, phaseOneOpen.replace("- [ ] add migration", "- [x] add migration"));
await assert.rejects(
  async () => {
    await before("plan", "edit", { filePath: "app/Bar.php" });
  },
  /phase 2 is not delegated/,
);
await before("plan", "subagent", { agent: "general", description: "Phase 2" });
await before("plan", "edit", { filePath: "app/Bar.php" });

// A child session is delegated work, not a second plan gate.
parentIDs.set("child", "plan");
await prompt("child", `implement ${planPath} now`);
await before("child", "edit", { filePath: "app/Child.php" });

// An unstructured plan keeps the old one-delegation gate.
const flatPath = join(plans, "flat.md");
writeFileSync(flatPath, "# Flat\n\n- [ ] one task\n");
await prompt("flat", `execute ${flatPath} now`);
await assert.rejects(
  async () => {
    await before("flat", "edit", { filePath: "app/Flat.php" });
  },
  /phase 1 is not delegated/,
);
await before("flat", "subagent", { agent: "general" });
await before("flat", "edit", { filePath: "app/Flat.php" });

await prompt("normal", "fix the typo in README.md");
await before("normal", "edit", { filePath: "README.md" });
assert.equal(shouldBlock("unknown", "read", {}), false);

// Protected branches and the <repo>/<type>-<short-description> convention.
// The temporary repo is named after the real one so the convention is the
// same string a developer sees here.
const branchRoot = mkdtempSync(join(tmpdir(), "harness-guard-branches-"));
const branchRepo = join(branchRoot, "agent-evals");
mkdirSync(branchRepo);
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: branchRepo, stdio: "ignore" });
await plugin.setup({ ...ctx, location: { directory: branchRepo } });
const git = (...args) =>
  execFileSync("git", ["-C", branchRepo, ...args], { stdio: "ignore" });

try {
  await assert.rejects(
    async () => before("branch", "shell", { command: "git commit -m test" }),
    /protected branch "main"/,
  );
  await assert.rejects(
    async () =>
      before("branch", "shell", { command: "git push origin agent-evals/feat-x" }),
    /protected branch "main"/,
  );
  await assert.rejects(
    async () => before("branch", "shell", { command: "git merge other" }),
    /protected branch "main"/,
  );

  // Shell wrappers must not hide the git write.
  for (const command of [
    'bash -c "git commit -m test"',
    "sh -c 'git merge other'",
    "env git commit -m test",
    "echo hi | xargs git commit -m test",
    "command git commit -m test",
  ]) {
    await assert.rejects(
      async () => before("branch", "shell", { command }),
      /protected branch "main"/,
      `wrapper was not unwrapped: ${command}`,
    );
  }

  // Read-only git commands are allowed on a protected branch.
  await before("branch", "shell", { command: "git status --short" });

  // Log mode records the decision but does not block.
  process.env.HARNESS_GUARD = "log";
  await before("branch", "shell", { command: "git commit -m test" });
  process.env.HARNESS_GUARD = "enforce";

  // Branch creation must follow the convention.
  await assert.rejects(
    async () => before("branch", "shell", { command: "git switch -c feature/invalid-name" }),
    /does not match agent-evals\/<type>-<short-description>/,
  );
  await before("branch", "shell", {
    command: "git switch -c agent-evals/feat-valid-branch",
  });
  git("checkout", "-q", "-b", "agent-evals/feat-valid-branch");

  // A conforming feature branch may commit and push its own branch.
  await before("branch", "shell", { command: "git commit -m test" });
  await before("branch", "shell", {
    command: "git push origin agent-evals/feat-valid-branch",
  });

  // A push that names a protected branch is blocked from a feature branch.
  await assert.rejects(
    async () => before("branch", "shell", { command: "git push origin main" }),
    /targets protected branch "main"/,
  );

  // A branch that exists but breaks the convention cannot commit.
  git("checkout", "-q", "-b", "feature/invalid-name");
  await assert.rejects(
    async () => before("branch", "shell", { command: "git commit -m test" }),
    /does not match agent-evals\/<type>-<short-description>/,
  );

  // A command is judged against the repo it names, not the session directory.
  await plugin.setup({ ...ctx, location: { directory: branchRoot } });
  await assert.rejects(
    async () => before("git-c", "shell", { command: `git -C ${branchRepo} commit -m test` }),
    /does not match agent-evals\/<type>-<short-description>/,
  );
  await assert.rejects(
    async () =>
      before("cd", "shell", { command: `cd ${branchRepo} && git commit -m test` }),
    /does not match agent-evals\/<type>-<short-description>/,
  );

  // Regression: a `cd` in the command must win over a different shell workdir.
  // The old resolver used the workdir first and derived "carlos" from the
  // session home, rejecting the correct agent-evals/ prefix.
  const foreignCwd = join(branchRoot, "carlos");
  mkdirSync(foreignCwd);
  await plugin.setup({ ...ctx, location: { directory: foreignCwd } });
  await assert.rejects(
    async () =>
      before("cd-prefix", "shell", {
        command: `cd ${branchRepo} && git switch -c carlos/feat-wrong-prefix`,
        workdir: foreignCwd,
      }),
    /does not match agent-evals\/<type>-<short-description>/,
  );
  await before("cd-prefix", "shell", {
    command: `cd ${branchRepo} && git switch -c agent-evals/feat-from-cd`,
    workdir: foreignCwd,
  });

  // A project directory may serve as the prefix, so work scoped to one app
  // does not have to borrow the repository name. The repository name stays
  // valid for repository-wide changes, and unknown prefixes stay refused.
  mkdirSync(join(branchRepo, "apps", "api.example.com"), { recursive: true });
  await before("project-prefix", "shell", {
    command: `cd ${branchRepo} && git switch -c api.example.com/feat-project-branch`,
  });
  git("checkout", "-q", "-b", "api.example.com/feat-project-branch");
  await before("project-prefix", "shell", {
    command: `cd ${branchRepo} && git commit -m test`,
  });
  await assert.rejects(
    async () =>
      before("project-prefix", "shell", {
        command: `cd ${branchRepo} && git switch -c unknown-project/feat-x`,
      }),
    /does not match agent-evals\/<type>-<short-description>/,
  );
} finally {
  rmSync(branchRoot, { recursive: true, force: true });
}

// Explanation mode is part of the harness contract, not optional prose.
const instructions = readFileSync(
  new URL("../instructions/harness-invariants.md", import.meta.url),
  "utf8",
);
assert.match(instructions, /Feynman technique/);
assert.match(instructions, /ADHD\/dyslexic readability/);

if (originalMode === undefined) delete process.env.HARNESS_GUARD;
else process.env.HARNESS_GUARD = originalMode;

rmSync(root, { recursive: true, force: true });
console.log("harness-guard: PASS");
