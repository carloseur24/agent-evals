import test from 'node:test';
import assert from 'node:assert/strict';

import { formatGreeting } from '../app/greeting.mjs';

test('greets a plain name', () => {
  assert.equal(formatGreeting('Ada'), 'Hello, Ada!');
});

test('trims surrounding whitespace', () => {
  assert.equal(formatGreeting('  Ada  '), 'Hello, Ada!');
});
