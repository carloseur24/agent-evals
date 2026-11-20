# fast-change

A one-file CSS fixture for the fast-change eval.

- `styles/app.css` holds a `.button` rule whose padding is `0.5rem`.
- `node test.mjs` exits 0 only when that rule declares `padding: 0.75rem;`.

No install step, build step, or package manager is involved.
