import { expect, it } from 'vitest';
import { channelToolPolicy } from '../src/claude-channel-tools.js';

it('keeps native tools absent unless explicitly enabled', () => {
  const p = channelToolPolicy();
  expect(p.args[p.args.indexOf('--tools') + 1]).toBe('');
  expect(p.instructions).toBeUndefined();
});

it('enables shell and file tools without bypassing prompts or loading user hooks', () => {
  const p = channelToolPolicy(true);
  expect(p.args[p.args.indexOf('--tools') + 1]!.split(',')).toEqual(['Bash', 'PowerShell', 'Read', 'Edit', 'Write', 'Glob', 'Grep']);
  expect(p.args[p.args.indexOf('--permission-mode') + 1]).toBe('default');
  expect(p.args).not.toContain('--allowedTools');
  expect(p.args).not.toContain('--dangerously-skip-permissions');
  expect(p.args[p.args.indexOf('--setting-sources') + 1]).toBe('');
  expect(JSON.parse(p.args[p.args.indexOf('--settings') + 1]!)).toEqual({ disableAllHooks: true });
  expect(p.instructions).toContain('не исправляй их без отдельной просьбы');
});
