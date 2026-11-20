# Agent Evals

Sandboxed, scored regression tests for OpenCode agents and subagents. One run
is **data + task + scorer**: a case is the data, a fixture is the task
workspace, and a scorer reads the captured tool trajectory plus the workspace
artifact. The object under test is behavior, never a single assistant message.

This repository is the source of truth for the suite. The runner has no
dependencies on any consumer project.

## Layout

```text
runner/
  run.mjs                 entry point and CLI
  calibrate.mjs           judge calibration
  lib/                    workspace, agent runner, trace capture, scoring, judges
  lib/scorers/            qualitative scorers (delegation_quality, report_quality)
  cases/*.json            one file per eval case
  fixtures/<name>/        generic task workspaces copied per run
  calibration/*.json      known-good and known-bad judge examples
  self-test/              deterministic runner self-test
templates/fixture/        starting point for a fast or subagent fixture
templates/fixture-delegation/  starting point for a delegated plan fixture
agents/eval-judge.md      read-only global judge agent
docs/baseline.md          model/agent/case baseline and recorded runs
docs/plan.md              original build plan and phase record
docs/factory.md           capture a real session into a case in ~30 minutes
scripts/                  run, install, doctor, validate, from-session, new-case
guardrails/
  plugins/harness-guard.js      fast-change budget and per-phase plan gate
  agents/plan-orchestrator.md   plan executor with edit and shell denied
  instructions/harness-invariants.md  source of the managed AGENTS.md block
  tests/harness-guard.test.mjs  deterministic guard self-test
  scripts/install.sh            guardrail symlinks and block sync
  scripts/doctor.mjs            guardrail readiness check

Local state (outside the repo, never committed):
$AGENT_EVALS_STATE/             default ~/.local/state/agent-evals
  reports/                      run and calibration JSON
  drafts/                       from-session captures
  harness-guard.log             runtime guard decisions
  backups/AGENTS.md.bak         managed block backup
```

## Install and local wiring

Requires Node.js 20+, `git`, and the `opencode` CLI. No npm dependencies are
needed.

```bash
bash scripts/install.sh
```

The installer creates six symlinks idempotently and syncs the managed
`harness-invariants` block in `~/.config/opencode/AGENTS.md`:

```text
~/.config/opencode/agent-evals          -> <repo>
~/.config/opencode/evals                -> <repo>/runner
~/.config/opencode/agents/eval-judge.md -> <repo>/agents/eval-judge.md
~/.config/opencode/plugins/harness-guard.js -> <repo>/guardrails/plugins/harness-guard.js
~/.config/opencode/agents/plan-orchestrator.md -> <repo>/guardrails/agents/plan-orchestrator.md
~/.config/opencode/agent-guardrails     -> <repo>/guardrails
```

Existing links to the same target are left alone. A real file, real directory,
or different symlink is refused unless `--force` is passed. Both installers also
create `reports/`, `drafts/`, and `backups/` under `$AGENT_EVALS_STATE`.

Verify the machine:

```bash
node scripts/doctor.mjs
node guardrails/scripts/doctor.mjs
```

The eval doctor exits 1 only when the runner cannot start or `eval-judge` is not
registered; other problems are warnings. The guardrails doctor exits 1 on any
hard mismatch in the runtime wiring.

## Run

```bash
bash scripts/run.sh --help
bash scripts/run.sh --case e2-fast-change
bash scripts/run.sh --all
bash scripts/run.sh --all --no-judge
```

Package shortcuts:

```bash
pnpm test       # node runner/run.mjs --self-test
pnpm dry        # node runner/run.mjs --dry-run
pnpm all        # node runner/run.mjs --all
pnpm doctor     # node scripts/doctor.mjs
pnpm validate   # node scripts/validate.mjs
pnpm new        # node scripts/new-case.mjs
pnpm from-session  # node scripts/from-session.mjs
pnpm guard:test    # node --test guardrails/tests/harness-guard.test.mjs
pnpm install:guardrails  # bash guardrails/scripts/install.sh
pnpm doctor:guardrails   # node guardrails/scripts/doctor.mjs
```

- Fast subset on every change: E1 delegation + E2 fast change.
- Full suite on a model, prompt, plugin, guard, or harness change: E1–E4.
- Default model is `opencode-go/deepseek-v4.1-flash`. A second model is opt-in
  only when a developer explicitly names it.
- `--dry-run` proves the runner and scorers work without invoking a model.
- `--no-judge` keeps hard checks only.

Reports are written under `$AGENT_EVALS_STATE/reports/` by default
(`~/.local/state/agent-evals/reports`) and are never committed. `--report <path>`
still overrides the destination. Start comparisons at `docs/baseline.md`; keep
the raw JSON for each run.

## Case, fixture, calibration

A **case** (`runner/cases/<id>.json`) declares the agent, model, timeout,
fixture, prompt, hard expectations, and optional judges.

A **fixture** (`runner/fixtures/<name>/`) is a throwaway workspace copied into
a temp directory and committed as a git baseline. The runner diffs the agent's
changes against that baseline. A fixture must not contain its own `.git`.

A **calibration example** (`runner/calibration/*.json`) pairs a compact,
synthetic trajectory or report with a `good`/`bad` label and a scorer. Judges
are trustworthy only when known-good examples score at or above the threshold
and known-bad examples score below it.

Qualitative judges are advisory: they are recorded with score and rationale,
and they can never change `passed`, `failed_checks`, or the exit code. Hard
checks always win.

## Build a case from a session

A real debugging or implementation session becomes a reusable case in about 30
minutes. Capture and scaffolding are automated; choosing the invariant and the
smallest fixture stays human. Full workflow: [docs/factory.md](docs/factory.md).

Capture a read-only draft from the OpenCode database:

```bash
node scripts/from-session.mjs --session ses_<id-or-title> --id my-case \
  --trace ~/.local/state/agent-evals/reports/my-case-trace.json
```

Scaffold a case and, optionally, a fixture from the captured draft:

```bash
node scripts/new-case.mjs --from-draft ~/.local/state/agent-evals/drafts/my-case.json \
  --fixture my-case --new-fixture
```

- `--from-draft` carries the draft's id, prompt, agent, and model; `--template`
  is inferred from the draft agent and can be overridden. `source_session` and
  draft notes stay in the draft.
- `--source-session ses_...` and `--notes <text>` are draft-only provenance for
  a manual capture that was not created by `from-session`.
- Drafts go to `$AGENT_EVALS_STATE/drafts/` and are never committed. Promotion
  to `runner/cases/<id>.json` is manual.
- `--template` is `fast`, `subagent`, or `delegation`. Presets choose the shape,
  not the exact invariant; replace them before running.
- `--new-fixture` copies `templates/fixture/` or
  `templates/fixture-delegation/` and never overwrites an existing fixture.
- The rule: the case must fail before the fix and pass after it, or it is not a
  regression test.

## Portability rules

- No project names, project paths, tenants, or domain-specific fixtures. All
  fixtures are small, generic Node workspaces.
- No secrets, API keys, credentials, or real user data in cases, fixtures,
  calibration files, or reports.
- No dependency on the repository that invoked the suite. `AGENT_EVALS_HOME`
  may point at another runner directory; the default is `<repo>/runner`.
- Reports are local state: `$AGENT_EVALS_STATE/reports`, never source.
- `scripts/validate.mjs` enforces the static contract: case schema, fixture
  references, calibration coverage, judge permissions, required docs, forbidden
  project paths, and no local provenance in runnable cases.

## Evals are not the runtime guard

The runtime guard (`harness-guard`) lives in `guardrails/` and blocks or logs
dangerous actions during a live session. Evals are regression tests: they
replay a scenario in a sandbox and score the resulting trajectory and artifact.
Passing evals never enables the guard, and changing the guard requires running
the evals rather than replacing them.

## License

MIT. See [LICENSE](LICENSE).
# agent-evals
