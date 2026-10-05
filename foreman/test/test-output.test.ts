import { expect, it } from 'vitest';
import { parseTestOutput } from '../src/repos.js';

it.each(['#', 'ℹ'])('reads Node test totals with the %s reporter prefix and Windows newlines', prefix => {
  // Node 24 on this Windows host emits the spec reporter even when stdout is piped.
  const result = parseTestOutput(`✔ example\r\n${prefix} tests 10\r\n${prefix} pass 10\r\n${prefix} fail 0\r\n`);
  expect(result).toEqual({ failures: [], summary: 'tests 10, pass 10, fail 0' });
});

it('preserves failing test names alongside spec reporter totals', () => {
  expect(parseTestOutput('✖ rejects invalid input\nℹ tests 2\nℹ pass 1\nℹ fail 1\n')).toEqual({
    failures: ['rejects invalid input'], summary: 'tests 2, pass 1, fail 1',
  });
});
