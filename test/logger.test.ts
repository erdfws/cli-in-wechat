import test from 'node:test';
import assert from 'node:assert/strict';

import { formatLogTimestamp } from '../src/utils/logger.js';

test('formatLogTimestamp uses local clock format with milliseconds', () => {
  const date = new Date(2026, 3, 3, 14, 5, 6, 78);
  assert.equal(formatLogTimestamp(date), '14:05:06.078');
});
