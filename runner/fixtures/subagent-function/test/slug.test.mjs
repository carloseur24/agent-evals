import test from 'node:test';
import assert from 'node:assert/strict';

import { slugify } from '../src/slug.mjs';

test('lowercases words and joins them with dashes', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});

test('trims and collapses punctuation', () => {
  assert.equal(slugify('  Agent Evals: Phase 2!  '), 'agent-evals-phase-2');
});
