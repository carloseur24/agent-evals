<!-- harness-invariants:start -->
# Harness invariants

- **Fast changes** (one named file, exact CSS/copy/literal value, no behavior/state/auth/DB/API change) get four lookups, then an edit or one concrete question. The global `harness-guard` plugin enforces this.
- **Plan execution** uses the global `plan-orchestrator` agent. It has no code-edit or shell capability, so it must delegate one phase at a time.
- The plugin also requires one `subagent` call per plan phase before code edits are allowed. Plan files may still be ticked directly, and delegated child sessions are not gated.
- `HARNESS_GUARD=log` records would-block decisions without blocking. `HARNESS_GUARD=off` disables enforcement.
<!-- harness-invariants:end -->
