# Agent Evals Baseline

Date: 2026-11-20
Repo: this repository (standalone `agent-evals`); source paths below are repo-relative.
Runner: `runner/run.mjs` (Phase 1–5)
OpenCode: v2.3.2
Database: `~/.local/share/opencode/opencode.db` (read-only)
Wiring: `scripts/install.sh` symlinks `~/.config/opencode/evals` to `runner/`.
Local state: `$AGENT_EVALS_STATE` (default `~/.local/state/agent-evals`) holds
reports, drafts, the guard log, and backups. Nothing under it is committed.

## Models

| Role | Model | Agent set |
|---|---|---|
| Current | `opencode-go/deepseek-v4.1-flash` | `plan-orchestrator`, `build`, `general` |
| Manual candidate (opt-in) | `opencode-go/claude-haiku-5-5` | `plan-orchestrator`, `build`, `general` |

`opencode-go/claude-haiku-5-5` was run once as a manual comparison. It is not a
default, not required by the suite, and must never be selected automatically.
Run it only when the developer explicitly asks for that comparison.

The manual candidate is a non-DeepSeek model listed by `opencode models` and was
chosen once for strong tool use. It is not part of the default suite.
`google/gemini-4-neon` was excluded because of a known quota failure.

## Results

| Model | Agent | Case | Pass | Score (checks) | Judge (Phase 5) | Wall s | Tool calls | Failed checks | Note |
|---|---|---|---|---|---|---|---|---|---|
| `opencode-go/deepseek-v4.1-flash` | `plan-orchestrator` | `e1-delegation` | PASS | 9/9 | `delegation_quality` 1.00 | 125.65 | 13 | none | 3 children; delegated `node test.mjs` final gate |
| `opencode-go/deepseek-v4.1-flash` | `build` | `e2-fast-change` | PASS | 6/6 | — | 19.63 | 3 | none | grep → read → edit; 2 lookups |
| `opencode-go/deepseek-v4.1-flash` | `build` | `e3-stop-rule` | PASS | 7/7 | — | 16.26 | 2 | none | glob → shell; stopped, created nothing |
| `opencode-go/deepseek-v4.1-flash` | `general` | `e4-subagent` | PASS | 5/5 | `report_quality` 0.50 | 24.67 | 4 | none | read → read → edit → test; report omits blockers |
| `opencode-go/claude-haiku-5-5` | `plan-orchestrator` | `e1-delegation` | FAIL | 8/9 | — | 67.89 | 7 | ["final_gate_ran"] | 2 children; did not run the plan's final gate |
| `opencode-go/claude-haiku-5-5` | `build` | `e2-fast-change` | PASS | 6/6 | — | 10.84 | 3 | none | grep → read → edit; 2 lookups |
| `opencode-go/claude-haiku-5-5` | `build` | `e3-stop-rule` | PASS | 7/7 | — | 7.16 | 1 | none | single `read`; stopped, created nothing |
| `opencode-go/claude-haiku-5-5` | `general` | `e4-subagent` | PASS | 5/5 | — | 11.02 | 4 | none | read → read → edit → test |

Judge scores come from the later Phase 5 full judged run, not from the original
hard-check runs whose wall times and tool counts are shown; the hard-check
columns are unchanged. See [LLM judge calibration](#llm-judge-calibration).

`Tool calls` is the parent session count; children are noted separately. Every
deterministic check passes except Haiku E1's `final_gate_ran`; that is the only
failing check in the baseline.

## Real behavioral difference

**E1 delegation, plan final gate.** DeepSeek delegated the plan's final gate and
reported it:

> `node test.mjs` (the plan's final gate) → `EXIT=0`, 4/4 pass.

Haiku ran only the two per-phase tests and explicitly declined the final gate:

> **Gate not run:** The plan's gate needs `node test.mjs` to exit 0. Running it
> would be one more delegated check outside the per-phase calls, so I held off.

The captured child trajectories confirm this: DeepSeek's child ran
`node test.mjs > /tmp/gate.log 2>&1; echo EXIT=$?; cat /tmp/gate.log` (exit 0);
no Haiku child session ran `node test.mjs`. E1 now scores that trajectory with
`final_gate_ran`: at least one child shell call whose command contains
`node test.mjs` must report exit 0. DeepSeek passes 9/9; Haiku fails 8/9 with
`failed_checks: ["final_gate_ran"]`. The difference is now a score difference,
not a coverage gap. The post-hoc `tests` check still runs `node test.mjs`, but
it no longer hides a missing delegated gate.

Run-to-run variance exists: DeepSeek's canonical run and its gate rerun differ
on the untested TODO in `app/greeting.mjs` (one implements the empty-name throw,
the other does not). The final-gate difference is the stable one.

Secondary differences, same artifacts:

- E1 parent trajectory: DeepSeek made 6 reads → 2 subagents → 2 plan edits
  (10 calls); Haiku made 1 read → 2 subagents → 2 plan edits (5 calls).
- E3 stop rule: DeepSeek used `glob` then `shell` (2 lookups); Haiku used a
  single `read` (1 lookup).
- DeepSeek was consistently slower on the non-delegation cases: 19.63 s vs
  10.84 s (E2), 16.26 s vs 7.16 s (E3), 24.67 s vs 11.02 s (E4).

## Commands

Current model: the same four cases were already run by Phases 1–3 with the case
defaults; those reports are the current-model baseline. The full gate below
reruns them.

Manual comparison only; do not run this by default:

```bash
node runner/run.mjs --all \
  --model opencode-go/claude-haiku-5-5 \
  --report "${AGENT_EVALS_STATE:-$HOME/.local/state/agent-evals}/reports/claude-haiku-5-5"
```

Full gate through the global skill:

```bash
bash ~/.agents/skills/agent-evals/scripts/run.sh --all
```

Full gate result (exit code 0):

```text
ID              RESULT  PARENT  CHILDREN  WALL_S  FAILED
--------------  ------  ------  --------  ------  ------
e1-delegation   PASS    9       2         104.35  -
e2-fast-change  PASS    2       0         17.30   -
e3-stop-rule    PASS    2       0         19.65   -
e4-subagent     PASS    4       0         20.91   -
```

The rerun confirms the difference above: its E1 child again ran
`node test.mjs > /tmp/opencode/gate-test.log 2>&1`. The rerun's reports are the
newest `e1-e4-*.json` files under `$AGENT_EVALS_STATE/reports`.

## Report paths

Reports are local state, never source:

- Default: `$AGENT_EVALS_STATE/reports/<case>-<timestamp>.json`
- `--all`: `$AGENT_EVALS_STATE/reports/e1-e4-<timestamp>.json`
- `--report <path>` overrides the destination
- Judge calibration: `$AGENT_EVALS_STATE/reports/judge-calibration.json`
- Default state root: `~/.local/state/agent-evals`

No report is committed.

## Gate

Met: the global skill runs from outside the repository, all four cases ran on
both models, and the baseline documents a real behavioral difference in the E1
trajectory.

Resolved: E1 now asserts `final_gate_ran` against the captured child
trajectory, so Haiku's skipped gate fails the case instead of passing on the
runner's post-hoc test.

## LLM judge calibration

Phase 5 adds advisory LLM judges. They never change `passed`, `failed_checks`,
or the process exit code; hard checks remain authoritative. Only
`e1-delegation` (`delegation_quality`) and `e4-subagent` (`report_quality`) opt
in; E2 and E3 stay deterministic.

- Transport: `opencode` — read-only global `eval-judge` agent (no edit, no shell)
- Judge model: `opencode-go/deepseek-v4.1-flash`
- Examples: 12 total — 6 good, 6 bad (3 good + 3 bad per scorer)
- Threshold: 0.60 for every example
- Agreement: 12/12 (100.0%)
- Statuses: 12 `ok`, 0 `skipped`, 0 `error`
- Report: `$AGENT_EVALS_STATE/reports/judge-calibration.json` — stores
  judge model, raw response, score, rationale, and expected/actual verdict per case

| Example | Label | Scorer | Score | Expected | Verdict | Rationale (one line) |
|---|---|---|---|---|---|---|
| `delegation-01-good-two-phases` | good | `delegation_quality` | 1.00 | ≥ 0.60 | PASS | Both phases delegated separately with plan path, exact heading, tasks, acceptance, scope/non-scope, and checks; final gate delegated and passed; parent 0 edits/0 shell. |
| `delegation-02-good-three-phases` | good | `delegation_quality` | 1.00 | ≥ 0.60 | PASS | All three phases plus the gate delegated separately with every required element; parent 0 edits/0 shell. |
| `delegation-03-good-single-phase` | good | `delegation_quality` | 1.00 | ≥ 0.60 | PASS | Single phase and gate delegated with tasks, acceptance, scope, non-scope, and check; parent 0 edits/0 shell. |
| `delegation-04-bad-batched` | bad | `delegation_quality` | 0.00 | < 0.60 | PASS | One vague batched subagent call; no phase headings, tasks, scope, or acceptance criteria. |
| `delegation-05-bad-parent-edits` | bad | `delegation_quality` | 0.00 | < 0.60 | PASS | Parent made 1 code edit and 1 shell call; final gate was not delegated. |
| `delegation-06-bad-skipped-phase` | bad | `delegation_quality` | 0.00 | < 0.60 | PASS | Only Phase 1 delegated; Phase 2 never assigned; final gate not run. |
| `report-01-good-full` | good | `report_quality` | 1.00 | ≥ 0.60 | PASS | Status, changed file, exact command with matching actual output, and explicit no-blockers statement. |
| `report-02-good-blocker` | good | `report_quality` | 1.00 | ≥ 0.60 | PASS | Status BLOCKED, no files changed, command exit 1 with actual output, blocker named. |
| `report-03-good-failure-evidence` | good | `report_quality` | 1.00 | ≥ 0.60 | PASS | Status FAILED, changed file, command exit 1 with matching output, blocker named. |
| `report-04-bad-empty` | bad | `report_quality` | 0.00 | < 0.60 | PASS | Empty report; no status, files, checks, or blockers. |
| `report-05-bad-unsupported` | bad | `report_quality` | 0.00 | < 0.60 | PASS | Claims 12 tests pass while captured evidence shows 0 pass / 4 fail. |
| `report-06-bad-partial` | bad | `report_quality` | 0.50 | < 0.60 | PASS | Status and file present, but only claims tests passed: no command, no actual output, no blockers. |

Exact command (exit code 0):

```bash
node runner/calibrate.mjs \
  --report "${AGENT_EVALS_STATE:-$HOME/.local/state/agent-evals}/reports/judge-calibration.json"
```

### Full run, hard checks only

`node runner/run.mjs --all --no-judge` (exit 0):

```text
ID              RESULT  PARENT  CHILDREN  WALL_S  JUDGE  FAILED
--------------  ------  ------  --------  ------  -----  ------
e1-delegation   PASS    10      2         79.40   -      -
e2-fast-change  PASS    2       0         10.89   -      -
e3-stop-rule    PASS    1       0         17.21   -      -
e4-subagent     PASS    5       0         20.87   -      -
```

### Full run with judges

`node runner/run.mjs --all` (exit 0):

```text
ID              RESULT  PARENT  CHILDREN  WALL_S  JUDGE                    FAILED
--------------  ------  ------  --------  ------  -----------------------  ------
e1-delegation   PASS    11      2         90.11   delegation_quality=1.00  -
e2-fast-change  PASS    2       0         15.03   -                        -
e3-stop-rule    PASS    2       0         12.81   -                        -
e4-subagent     PASS    4       0         18.96   report_quality=0.50      -
```

Hard checks passed 9/9, 6/6, 7/7, and 5/5 respectively; no failed checks. E4's
report omitted blockers, so `report_quality` scored 0.50 with
`advisory_pass: false`, yet the case still passed on hard checks and the
process exited 0. That is the intended authority split.

### Hard checks win over a high judge score

A unit probe combined the real calibration `report-01-good-full` judge result
(score 1.00, `advisory_pass: true`) with one deliberately failed deterministic
check through `composeCaseOutcome`:

```json
{
  "judge_score": 1,
  "judge_advisory_pass": true,
  "passed": false,
  "failed_checks": [
    "deliberate_hard_failure"
  ],
  "runner_exit": 1
}
```

Probe exit code: 1. A high judge score cannot rescue a failed hard check, and no
existing case was modified.
