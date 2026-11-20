import { spawnSync } from 'node:child_process';

const result = spawnSync(
  process.execPath,
  ['--test', 'test/greeting.test.mjs', 'test/labels.test.mjs'],
  { stdio: 'inherit' },
);

process.exit(result.status ?? 1);
