# Build an eval case from a session

Target: a real debugging or implementation session becomes a reusable eval in
about 30 minutes. Capture and scaffolding are automated. The judgment — which
invariant matters and what the smallest reproduction is — stays human.

> **The rule:** a case must fail before the fix and pass after it, or it is not a
> regression test. A case that passes on both sides measures nothing.

Reports, drafts, the guard log, and backups live under `$AGENT_EVALS_STATE`
(default `~/.local/state/agent-evals`); they are never committed.

## 1. Capture the session (~5 min)

```bash
node scripts/from-session.mjs --session <session-id|title-substring> \
  --id <slug> \
  --trace ~/.local/state/agent-evals/reports/<slug>-trace.json
```

- `--session` accepts a `ses_...` id, an exact title, or a unique title
  substring. An ambiguous substring prints every match (id, title, agent) and
  exits 2; narrow the query instead of guessing.
- The first user text message becomes `prompt`; `--prompt` overrides it.
- The draft records the source session, agent, model label, timeout, and an
  observed summary (title, duration, tokens, parent/child tool calls).
- Output defaults to `$AGENT_EVALS_STATE/drafts/<id>.json`
  (`~/.local/state/agent-evals/drafts` by default), outside the repository.

Inspect the trace to choose the invariant (replace the path if
`$AGENT_EVALS_STATE` is set):

```bash
node -e "const t=require(process.env.HOME + '/.local/state/agent-evals/reports/<slug>-trace.json'); console.log(t.observed, t.trace.parent.tool_calls.map((c)=>c.name))"
```

The trace is bounded to the runner's default tool-output limit. It never dumps
the database, the environment, or raw message rows.

**Promotion is manual.** A draft has `"fixture": "TODO"` and `"expect": {}` on
purpose. Do not copy it into `runner/cases/` until steps 2–4 are done.

## 2. Reduce it to the smallest synthetic fixture (~10 min)

Create `runner/fixtures/<fixture>/` from the smallest workspace that still
reproduces the behavior. Keep the failure and the test that proves it; delete
everything else.

- Start from `templates/fixture/` for a fast or subagent case.
- Start from `templates/fixture-delegation/` for a plan-orchestrator case.
- Never copy production data, secrets, customer text, credentials, tenant names,
  or private paths. Rewrite names and values as generic placeholders.
- The fixture must run with plain `node` and no install step.
- The failing test has to fail for the same reason the real session failed.

## 3. Scaffold the case (~5 min)

```bash
node scripts/new-case.mjs --from-draft ~/.local/state/agent-evals/drafts/<slug>.json \
  --fixture <fixture> --new-fixture
```

| Template | Agent | Shape |
|---|---|---|
| `fast` | `build` | One scoped edit, few lookups, short wall clock. |
| `subagent` | `general` | One isolated implementation task. |
| `delegation` | `plan-orchestrator` | Parent delegates phases, edits only the plan, runs the final gate. |

- `--from-draft` carries the draft's id, prompt, agent, and model; `--id`,
  `--prompt`, `--agent`, and `--model` still override. `source_session` and draft
  notes stay in the draft, so a runnable case remains portable.
- `--template` is inferred from the draft agent: `plan-orchestrator` →
  `delegation`, `general` → `subagent`, otherwise `fast`. Pass it to override.
- `--new-fixture` copies the matching template and never overwrites a fixture.
- Without `--new-fixture`, `--fixture` must name an existing fixture.
- `--timeout` overrides the preset; `--expect '<json>'` deep-merges over it.
- `--source-session ses_...` and `--notes <text>` add draft-only provenance to a
  manual capture that was not created by `from-session`.
- `--draft` writes to `$AGENT_EVALS_STATE/drafts/`; `--out` wins over both
  defaults.
- `--dry-run` prints the case and the planned fixture copy without writing.

The presets choose the **shape** of the change. They are not assertions about
your case; replace them with the exact invariant in step 4.

## 4. Replace the preset checks with the exact invariant (~5 min)

Open the generated case and make `expect` say what actually must be true. The
factory does not invent assertions; this is the human step.

Typical invariant pieces:

- `files_changed`: the exact files or globs the fix may touch. Narrow it.
- `tests`: the command that proves the artifact works, with its own timeout.
- `max_lookups_before_first_edit`: how much searching is reasonable.
- `parent_code_edits_max`, `parent_shell_max`, `subagents_min`: the delegation
  split.
- `final_gate_ran`: the exact final command and exit code.
- `wall_time_max_s`: a budget you are willing to enforce.

Delete preset checks that do not describe this case. Do not weaken a check to
fit an observed run; if the run is wrong, keep the check and record the failure.

## 5. Validate and run the case (~5 min)

```bash
node scripts/validate.mjs
bash scripts/run.sh --case <slug>
```

The first run is the **red** run. Run the case against the state you are
regressing — the old prompt, model, fixture, or agent configuration — and
confirm it fails with the expected `failed_checks`. The failure must be the one
you intended, not a typo or a missing fixture.

Then run against the fixed state and confirm it passes. If the case cannot fail
on the broken state, it is not a regression test yet.

`validate` checks the static contract: ids, fixture references, relative globs,
required scripts/docs/templates, and portability. It never calls a model.

## 6. Record the result (~5 min)

- Reports are written under `$AGENT_EVALS_STATE/reports/` by default
  (`~/.local/state/agent-evals/reports`) and are never committed.
- Keep the raw JSON for the run you are comparing.
- Add the meaningful result to `docs/baseline.md`.
- If the case uses a judge and reveals a new known-good or known-bad behavior,
  add a synthetic calibration example under `runner/calibration/`.

## Automated vs human

| Automated | Human |
|---|---|
| Read-only session lookup and trace capture | Which behavior is the invariant |
| Draft JSON with prompt and observed summary | The smallest reproduction |
| Fixture and case scaffolding | Fixture contents and generic names |
| Preset shape, deep-merged overrides | Exact checks and allowed paths |
| Static validation, runner, reports | Red/green evidence and baseline entry |

## All commands through the installed link

After `bash scripts/install.sh`:

```bash
node ~/.config/opencode/agent-evals/scripts/from-session.mjs --session <id> --id <slug>
node ~/.config/opencode/agent-evals/scripts/new-case.mjs --id <slug> --fixture <name> \
  --new-fixture --template fast --prompt "<text>"
node ~/.config/opencode/agent-evals/scripts/validate.mjs
bash ~/.config/opencode/agent-evals/scripts/run.sh --case <slug>
```

`~/.config/opencode/evals` remains the runner link; the factory entry points live
under `~/.config/opencode/agent-evals`.
