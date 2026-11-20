# two-phase-plan

A tiny dependency-free Node project with two deliberately unfinished modules.

- `plans/refactor.md` holds two phases. Each phase fixes one module and runs its
  test file.
- `app/greeting.mjs` and `app/labels.mjs` are the only source files.
- `node test.mjs` runs both test files and exits non-zero while either phase is
  incomplete.

No install step, build step, or package manager is involved.
