# Fixture template

Replace this fixture with the smallest reproduction of the session's failure.

- `src/sum.mjs` starts broken: `sum(a, b)` returns `a - b`.
- `test/sum.test.mjs` uses `node:test` and expects `sum(1, 2) === 3`.
- There is no `package.json`; `node --test` runs the test directly.

Keep the workspace tiny and generic. Never copy production data, secrets, or
project-specific paths into a fixture.
