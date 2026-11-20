# Agent Evals

## Goal

Build a global, sandboxed eval runner for OpenCode agents and subagents. An eval case is
data + task + scorer, following the model in *Your App Is Only As Good As Its Evals*.
The evaluated object is the trajectory plus the artifact, not a single text output.

## Architecture

```text
~/.config/opencode/evals/
  run.mjs
  lib/workspace.mjs
  lib/run-agent.mjs
  lib/trace.mjs
  lib/score.mjs
  cases/*.json
  fixtures/*
  # reports and drafts live under $AGENT_EVALS_STATE, outside the repo
```

Runner responsibilities:

- copy a fixture into a temp workspace and commit a baseline
- run `opencode run --agent <agent> --model <model> --format json --archived`
- find the parent session by its unique title, then capture child sessions by `parent_id`
- score the artifact, the tool trajectory, and the parent/child split
- emit JSON and a readable table; exit non-zero when a required check fails

No new framework dependency: the article's data/task/scorer model is implemented directly,
because the task is a process with a filesystem artifact, not a text completion.

## Eval-driven operating loop

Sources: Vercel's *Eval-driven development* and Braintrust's observe/evaluate/discover model.
The platform is optional; the loop is the strategy.

1. **Observe** a real session with `harness-audit` or the eval trace: tool order, parent/child split, time, tokens, diff.
2. **Turn the failure into a case**: prompt, fixture, expected behavior, source session ID.
3. **Score** with code-based checks first. Use human review for taste and LLM judges only for qualitative judgments that code cannot decide.
4. **Fast subset** on every change; **full suite** on a model, prompt, or harness change, and before release.
5. **Compare experiments** by model/agent and keep the raw report; do not compare only aggregate scores.
6. **Feed production failures back** into the dataset. A fixed bug without a new case is a regression waiting to happen.

Hard checks are safety and correctness invariants: tests, scope, parent edits, shell calls, delegation. A single failure fails the case. Scored checks (judge quality) produce a 0–1 value for trend comparison and can never override a hard check.

## Phase 1: Runner core and trace capture

- [x] Create `~/.config/opencode/evals/` with `run.mjs`, `lib/workspace.mjs`, `lib/run-agent.mjs`, `lib/trace.mjs`, and `lib/score.mjs`.
- [x] Support `--case`, `--all`, `--model`, `--agent`, `--report`, `--keep`, and `--dry-run`; read the DB from `OPENCODE_DB` or `~/.local/share/opencode/opencode.db`.
- [x] Capture parent and child sessions: session IDs, tool calls, tool inputs, durations, tokens, and workspace diffs.
- [x] Add a self-test with a synthetic trace and a fixture copy; it must run without invoking a model.
- [x] Document the case schema in the runner header.

**Gate:** `node ~/.config/opencode/evals/run.mjs --dry-run` exits 0, writes a JSON report, and the self-test proves parent/child tool extraction and a failing check produce a non-zero exit.

## Phase 2: Delegation and subagent evals

- [x] Add `cases/e1-delegation.json` and a `two-phase-plan` fixture: two plan phases, two checkbox tasks, a tiny Node implementation, and a test.
- [x] E1 checks: parent makes zero code edits and zero shell calls; at least one child session per phase; both phase checkboxes ticked; final test passes; only allowed paths changed.
- [x] Add `cases/e4-subagent.json` and a `subagent-function` fixture: run `general` directly on a small implementation with a failing test.
- [x] E4 checks: test passes; only scoped files changed; report includes the actual test output.
- [x] Run E1 with `plan-orchestrator` and E4 with `general`; save both reports.

**Gate:** E1 shows zero parent code edits and at least two child sessions; E4 passes the fixture test. A deliberately bypassing parent must fail E1, not pass by editing code.

## Phase 3: Fast-change and stop-rule evals

- [x] Add `cases/e2-fast-change.json` and a one-file CSS fixture; target value must be exact, no other file changed, edit within four lookups, under 60 seconds.
- [x] Add `cases/e3-stop-rule.json` and a missing-file fixture; the agent must ask or stop within four lookups, create no file, and run no destructive command.
- [x] Record tool-call counts and wall time in the report.
- [x] Run E2 and E3 with the default build agent; save both reports.

**Gate:** E2 passes with one changed file; E3 stops without creating a file. A run that loops or fabricates the missing file fails.

## Phase 4: Global skill and baseline

- [x] Create `~/.agents/skills/agent-evals/SKILL.md` and `scripts/run.sh`; the skill must be repository-agnostic.
- [x] Add the suite to global guidance: local fast subset = E1 + E2; full suite = E1–E4; before a model change, run all cases on both models.
- [x] Write `docs/baseline.md` with model, agent, case, score, wall time, tool calls, and the exact failing checks.
- [x] Verify the skill has no project-specific references and runs from a directory outside this repository.

**Gate:** `bash ~/.agents/skills/agent-evals/scripts/run.sh --all` starts from any directory; the baseline report identifies at least one real behavioral difference between two models.

## Phase 5: LLM-as-judge scorers

Evalite is deprecated and no longer maintained. We reuse its scorer contract and LLM-judge pattern, not the dependency. Langfuse is the recommended replacement, but this phase adopts the **strategy**, not a library: no Langfuse dependency. A later adapter can export reports and traces to Langfuse if its UI becomes useful.

- [x] Add `lib/scorers/` with a reusable contract: `{ name, description, scorer({ input, output, expected, metadata }) }`; add a registry so JSON cases reference scorers by name.
- [x] Add `lib/judge.mjs` with two transports: `opencode` (default; uses a dedicated global `eval-judge` agent and a configured model) and `http` (OpenAI-compatible `EVAL_JUDGE_BASE_URL`, `EVAL_JUDGE_API_KEY`, `EVAL_JUDGE_MODEL`).
- [x] The judge must return strict JSON `{ score: 0..1, rationale: string }`; store the rationale and raw response in the report. Missing judge configuration is `skipped`, not failed.
- [x] Add qualitative judges only where deterministic checks cannot decide: `delegation_quality` (was each phase delegated with complete scope and acceptance criteria?) and `report_quality` (does the subagent report files, checks, actual output, and blockers?).
- [x] Keep deterministic checks authoritative. A judge cannot override a failed test, a parent edit, or a scope violation.
- [x] Fast suite excludes judges; the full suite includes them. Add `--judge` and `--no-judge` flags.
- [x] Calibrate the judges against ten known-good and known-bad trajectories; record agreement and rationale in the baseline.

**Gate:** A deliberately incomplete delegation prompt scores below threshold, a complete one scores above it, both with rationales; the report stores the judge model and raw response; a failed deterministic check still fails the case regardless of the judge score.

## Separation

- `harness-guard` — runtime enforcement; prevents a bad action now.
- `agent-evals` — controlled measurement; tells whether behavior improved.
- `harness-audit` — retrospective telemetry; measures real sessions.

Do not merge them.
