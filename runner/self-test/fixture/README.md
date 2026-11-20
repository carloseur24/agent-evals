Self-test fixture for the Agent Evals runner.

`src/sum.mjs` starts broken and `test/sum.test.mjs` starts failing. The synthetic
dry-run applies the child edit that fixes it, then scores the workspace copy.
