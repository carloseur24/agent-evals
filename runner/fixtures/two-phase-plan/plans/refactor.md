# Refactor the greeting modules

The project is plain Node.js with no dependencies. Tests use the built-in runner,
so no install step is needed. Each phase fixes one module and its test file; the
final gate runs both test files through `node test.mjs`.

## Phase 1: Implement greeting formatting

- [ ] Implement `formatGreeting(name)` in `app/greeting.mjs` so `node --test test/greeting.test.mjs` passes.
- [ ] Run `node --test test/greeting.test.mjs` and report its result.

## Phase 2: Implement label formatting

- [ ] Implement `formatLabel(key)` in `app/labels.mjs` so `node --test test/labels.test.mjs` passes.
- [ ] Run `node --test test/labels.test.mjs` and report its result.

**Gate:** `node test.mjs` exits 0 after both phases.
