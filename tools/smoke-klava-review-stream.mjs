// Opt-in real Claude check, isolated from the user's projects and shared conversation.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ClaudeReviewer, findClaude, gitText, cleanHead } from '../foreman/src/studio-review.ts';
import { claudeWorkspace } from '../foreman/src/claude-workspace.ts';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-review-stream-'));
const repo = path.join(root, 'repo'), workspace = path.join(root, 'workspace');
await fs.mkdir(repo); await fs.mkdir(workspace);
await gitText(repo, ['init']);
async function commit() {
  await gitText(repo, ['add', 'math.ts']);
  await gitText(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'Fixture']);
  return cleanHead(repo);
}
await fs.writeFile(path.join(repo, 'math.ts'), 'export const double = (x: number) => x;\n');
const base = await commit();
await fs.writeFile(path.join(repo, 'math.ts'), 'export const double = (x: number) => 2 * x;\n');
const head = await commit();
for (const name of ['CLAUDE.md', 'PROJECTS.md', 'MEMORY.md']) await fs.writeFile(path.join(workspace, name), 'Изолированная проверка ревью. Не записывай память и не обращайся к GitHub.');
await fs.writeFile(path.join(workspace, 'access.json'), JSON.stringify({ version: 1, repositories: [
  { id: 'fixture', name: 'Fixture', path: repo, github: 'Example/Fixture' },
] }));
const reviewer = new ClaudeReviewer(() => findClaude(), () => claudeWorkspace(workspace));
const steps = []; const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 90000);
try {
  const result = await reviewer.run({ cwd: repo, base, head,
    task: 'Функция double должна удваивать число. Для проверки потокового протокола перед вердиктом обязательно прочитай math.ts через mcp__klava__project_read, project=fixture, file=math.ts. Другие инструменты не нужны.',
    checks: 'Изолированный тест транспорта; тесты приложения не заявлены.', knowledge: '',
  }, controller.signal, step => steps.push(step));
  if (!steps.some(s => s.includes('math.ts'))) throw new Error('Expected project_read step was not received');
  console.log(JSON.stringify({ passed: true, root, steps, verdict: result.verdict, validSummary: !!result.summary.trim() }));
} finally { clearTimeout(timeout); }
