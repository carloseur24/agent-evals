<!-- harness-invariants:start -->
# Harness invariants

- **Fast changes** (one named file, exact CSS/copy/literal value, no behavior/state/auth/DB/API change) get four lookups, then an edit or one concrete question. The global `harness-guard` plugin enforces this.
- **Plan execution** uses the global `plan-orchestrator` agent. It has no code-edit or shell capability, so it must delegate one phase at a time.
- The plugin also requires one `subagent` call per plan phase before code edits are allowed. Plan files may still be ticked directly, and delegated child sessions are not gated.
- **Protected branches:** agents never commit, merge, or push on `main` or `master`. Work on a feature branch. If authentication is unavailable, stop; never substitute `gh auth git-credential` or another credential path without explicit user instruction.
- **Branch names:** every feature branch follows `<repo-folder>/<type>-<short-description>`, for example `agent-evals/feat-agent-harness-first-loop`. The prefix is the repository folder name, resolved from the common git dir; renaming the checkout changes it automatically. Allowed types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `perf`, `ci`, `build`, `style`. The description is lowercase letters, digits, and hyphens, starting with a letter or digit. The plugin refuses `git commit`, `push`, and `merge` on a non-conforming branch and refuses `git switch -c` / `git checkout -b` with a non-conforming name.
- **Explanations:** when the user asks to explain, teach, or help them understand something, use the Feynman technique plus contrasting examples by default: a plain-language mechanism, a concrete analogy, then one good approach and one bad approach with the failure each causes. The user should not have to name the technique or ask for examples.
- **Explanation formatting:** write for ADHD/dyslexic readability even when the user has neither. Use short paragraphs of one to three sentences, one idea per paragraph, descriptive headings, bullet lists for comparisons, bold key terms, generous white space, and separate labeled blocks for good and bad examples. Never deliver a dense wall of text.
- `HARNESS_GUARD=log` records would-block decisions without blocking. `HARNESS_GUARD=off` disables enforcement.
<!-- harness-invariants:end -->
