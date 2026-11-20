import test from 'node:test';
import assert from 'node:assert/strict';

import { formatLabel } from '../app/labels.mjs';

test('turns dashes into upper-case words', () => {
  assert.equal(formatLabel('save-changes'), 'SAVE CHANGES');
});

test('handles mixed separators and case', () => {
  assert.equal(formatLabel('Delete_Account'), 'DELETE ACCOUNT');
});
