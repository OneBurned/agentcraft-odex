import { expect, it } from 'vitest';
import { ReviewStream, reviewStep } from '../src/review-stream.js';

const tool = (name: string, input: unknown = {}) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: `mcp__klava__${name}`, input }] } });
const line = (value: unknown) => JSON.stringify(value) + '\n';
it('handles split UTF-8/NDJSON and retains only tool labels plus the final result', () => {
  const steps: string[] = []; const stream = new ReviewStream(s => steps.push(s));
  const result = { type: 'result', is_error: false, structured_output: { verdict: 'pass', summary: 'Проверено' } };
  const data = Buffer.from([
    { type: 'system', message: 'PRIVATE diagnostic' },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'PRIVATE reasoning' }, { type: 'text', text: 'PRIVATE prose' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'PRIVATE file contents' }] } },
    tool('project_read', { file: 'src/тест.ts', project: 'agentcraft', text: 'PRIVATE injected input' }),
    result,
  ].map(line).join(''));
  for (let i = 0; i < data.length; i += 7) stream.push(data.subarray(i, i + 7));
  expect(stream.finish()).toEqual(result);
  expect(steps).toEqual(['Читаю src/тест.ts (agentcraft)']);
  expect(steps.join()).not.toContain('PRIVATE');
});
it('throttles steps to 2.5 seconds and collapses repeats throughout a review', () => {
  let now = 0; const steps: string[] = []; const stream = new ReviewStream(s => steps.push(s), () => now);
  stream.push(line(tool('project_read', { file: 'a.ts' })));
  now = 2499; stream.push(line(tool('project_read', { file: 'b.ts' })));
  now = 2500; stream.push(line(tool('project_read', { file: 'b.ts' })));
  now = 5000; stream.push(line(tool('project_read', { file: 'a.ts' })));
  stream.push(line(tool('skill_read', { file: 'common/docs-update/SKILL.md' })));
  expect(steps).toEqual(['Читаю a.ts', 'Читаю b.ts', 'Правила: common/docs-update/SKILL.md']);
});
it('never reflects search text, arbitrary tools, notes, diagnostic paths or untrusted action labels', () => {
  expect(reviewStep('mcp__klava__project_search', { project: 'agentcraft', text: 'SECRET', contains: 'SECRET' })).toBe('Поиск по файлам (agentcraft)');
  expect(reviewStep('mcp__klava__remember', { note: 'SECRET' })).toBe('Записываю заметку');
  expect(reviewStep('Bash', { command: 'SECRET' })).toBeUndefined();
  expect(reviewStep('mcp__other__project_read', { file: 'SECRET' })).toBeUndefined();
  expect(reviewStep('mcp__klava__project_read', { file: 'C:\\PRIVATE\\file', project: 'PRIVATE\ntext' })).toBe('Читаю файл');
  expect(reviewStep('mcp__klava__project_read', { file: '../PRIVATE' })).toBe('Читаю файл');
  expect(reviewStep('mcp__klava__project_git', { action: 'constructor' })).toBe('Проверка Git');
  expect(reviewStep('mcp__klava__project_git', { action: 'diff', file: 'src/a.ts', project: 'agentcraft' })).toBe('Diff src/a.ts (agentcraft)');
});
it('hides raw parse errors, requires a final envelope and bounds discarded output too', () => {
  expect(() => new ReviewStream().push('PRIVATE invalid JSON\n')).toThrow('Не удалось прочитать поток ревью Claude.');
  expect(() => new ReviewStream().finish()).toThrow('Не удалось прочитать поток ревью Claude.');
  expect(() => new ReviewStream().push(line({ type: 'user', content: 'x'.repeat(2_000_001) }))).toThrow('слишком большой');
});
it('accepts the last line without a newline and ignores tool events after the result', () => {
  const steps: string[] = []; const stream = new ReviewStream(s => steps.push(s));
  const result = { type: 'result', structured_output: { verdict: 'question', summary: 'Вопрос' } };
  stream.push(line(result)); stream.push(line(tool('projects'))); expect(steps).toEqual([]);
  expect(stream.finish()).toEqual(result);
  const last = new ReviewStream(); last.push(JSON.stringify(result)); expect(last.finish()).toEqual(result);
});
