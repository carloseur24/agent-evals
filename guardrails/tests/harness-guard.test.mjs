import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

rmSync(root, { recursive: true, force: true });
console.log("harness-guard: PASS");
