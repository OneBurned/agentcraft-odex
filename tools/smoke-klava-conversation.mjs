// Opt-in real Claude smoke check in a disposable workspace, never the user's conversation.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { findClaude } from '../foreman/src/studio-review.ts';
import { ClaudeDialog } from '../foreman/src/claude-dialog.ts';
import { acquireConversation, conversationMessages } from '../foreman/src/claude-conversation.ts';
const exe = findClaude(); if (!exe) throw new Error('Claude CLI missing');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-shared-smoke-'));
const sessionId = randomUUID();
const workspace = { directory, instructions: 'Проверка сохранения истории. Отвечай кратко по-русски. Не используй инструменты.', args: ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'] };
async function cli(message, resume = false) {
  const child = spawn(exe, ['-p', '--output-format', 'json', '--tools', '', ...workspace.args, '--setting-sources', '', '--settings', '{"disableAllHooks":true}', resume ? '--resume' : '--session-id', sessionId], { cwd: directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => output += b); child.stderr.resume(); child.stdin.on('error', () => {});
  const timeout = setTimeout(() => child.kill(), 90000);
  const result = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve(output) : reject(new Error(`Claude smoke exit ${code}`))); });
  child.stdin.end(message);
  try { const answer = JSON.parse(await result); if (answer.is_error || answer.session_id !== sessionId) throw new Error('Unexpected session result'); return answer.result; }
  finally { clearTimeout(timeout); }
}
console.log('Creating isolated native conversation');
await cli('Проверка: наше кодовое слово — БИРЮЗА. Ответь только «принято».');
const config = { version: 1, sessionId, importedHistory: '' };
await fs.writeFile(path.join(directory, 'conversation.json'), JSON.stringify(config));
const runner = new ClaudeDialog(() => exe, () => workspace);
console.log('Game resumes terminal history');
const game = await runner.run('', new AbortController().signal, { text: 'Какое наше кодовое слово? Ответь только им.', context: '{}', retry: false });
if (!game.toUpperCase().includes('БИРЮЗА')) throw new Error('Game lost terminal context');
const lease = acquireConversation(directory, 'terminal');
console.log('Terminal resumes game history');
try {
  await cli('Добавь в контекст разговора второе кодовое слово: КЕДР. Файлы не меняй. Ответь только «принято».', true);
  const status = runner.externalStatus(); if (!status?.includes('терминале')) throw new Error('Terminal lease not visible');
  await runner.run('must not start', new AbortController().signal).then(() => { throw new Error('Overlapping writer allowed'); }, e => { if (!e.message.includes('терминале')) throw e; });
} finally { lease.release(); }
console.log('Game resumes terminal continuation');
const continued = await runner.run('', new AbortController().signal, { text: 'Назови оба наших кодовых слова. Только два слова.', context: '{}', retry: false });
if (!continued.toUpperCase().includes('БИРЮЗА') || !continued.toUpperCase().includes('КЕДР')) throw new Error('Return to game lost context');
const history = await conversationMessages(directory, config);
console.log(JSON.stringify({ passed: true, sessionId, messageCount: history.length, directory, sameConversation: true, exclusiveWriter: true }));
