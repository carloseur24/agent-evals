# Runtime guardrails

Runtime enforcement for the harness: the global `harness-guard` plugin, the
`plan-orchestrator` agent, and the managed `harness-invariants` block in the
global `AGENTS.md`.

## Layout

```text
guardrails/
  plugins/harness-guard.js          fast-change budget, plan gate, protected-branch guard
  agents/plan-orchestrator.md       plan executor with edit and shell denied
  instructions/harness-invariants.md  source of the marked AGENTS.md block
  tests/harness-guard.test.mjs      deterministic guard self-test
  scripts/install.sh                symlink and block installation
  scripts/install-block.mjs         AGENTS.md block sync
  scripts/doctor.mjs                machine readiness check
```

Local state lives outside the repo under `$AGENT_EVALS_STATE` (default
`~/.local/state/agent-evals`): `harness-guard.log` and
`backups/AGENTS.md.bak`.

## Install

```bash
bash guardrails/scripts/install.sh
```

The root installer runs it too, so one command still wires everything:

```bash
bash scripts/install.sh
```

Both installers are idempotent. The guardrails installer creates:

```text
~/.config/opencode/plugins/harness-guard.js
  -> <repo>/guardrails/plugins/harness-guard.js
~/.config/opencode/agents/plan-orchestrator.md
  -> <repo>/guardrails/agents/plan-orchestrator.md
~/.config/opencode/agent-guardrails
  -> <repo>/guardrails
```

Existing links to the same target are left alone. A real file, real directory,
or different symlink is refused unless `--force` is passed. The installer also
creates `reports/`, `drafts/`, and `backups/` under `$AGENT_EVALS_STATE`.

`install-block.mjs` replaces the marked block in `~/.config/opencode/AGENTS.md`
from `instructions/harness-invariants.md`. If no block exists, it inserts one
before `<!-- execution-harness:start -->`. It refuses a partially marked file,
never duplicates the block, and backs up `AGENTS.md` to
`$AGENT_EVALS_STATE/backups/AGENTS.md.bak` only when that backup does not already
exist. Every other block is preserved.

## Check

```bash
node guardrails/scripts/doctor.mjs
```

`doctor` verifies Node and the OpenCode CLI, the three symlinks, the single
matching `AGENTS.md` block, the `plan-orchestrator` edit/shell deny rules, and
the guard self-test. It prints the state root, exits 1 on a hard mismatch, and
never rewrites anything.

```bash
node --test guardrails/tests/harness-guard.test.mjs
```

## Modes

- `HARNESS_GUARD=enforce` (default): block a change when the budget or phase
  gate is violated.
- `HARNESS_GUARD=log`: record `would_block` decisions without blocking.
- `HARNESS_GUARD=off`: disable enforcement.
- `HARNESS_GUARD_FAST_MAX` changes the default fast budget of four lookups.

The plugin writes `$AGENT_EVALS_STATE/harness-guard.log` (default
`~/.local/state/agent-evals/harness-guard.log`); the file is generated and never
committed.

## Protected branches and branch names

The guard blocks `git commit`, `git push`, and `git merge` while the current
branch is `main` or `master`, in every session including child sessions. It also
blocks a push whose refspec names `main` or `master` (for example
`git push origin main`), and `git push --all` or `--mirror`. Read-only commands
(`status`, `log`, `diff`, `show`, `branch --show-current`, `ls-remote`) are
unaffected. `HARNESS_GUARD=log` records these decisions without blocking and
`HARNESS_GUARD=off` disables them.

Every other branch must follow:

```text
<repo-folder>/<type>-<short-description>
```

The prefix is the repository folder name, resolved from the common git dir, so
renaming the checkout changes it automatically. For example,
`agent-evals/feat-agent-harness-first-loop`. Allowed types: `feat`, `fix`,
`chore`, `docs`, `test`, `refactor`, `perf`, `ci`, `build`, `style`. The
description is lowercase letters, digits, and hyphens, starting with a letter or
digit. The guard refuses `git switch -c` / `git checkout -b` with a
non-conforming name and refuses a write on a non-conforming branch.

