// Run with node --import tsx. Interactive Claude shares the game's reviewed workspace,
// and resumes the exact shared conversation when configured.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { claudeWorkspace } from '../foreman/src/claude-workspace.ts';
import { findClaude } from '../foreman/src/studio-review.ts';
import { acquireConversation, conversation, importContext, requireSession, returnConversation } from '../foreman/src/claude-conversation.ts';
import { createInterface } from 'node:readline/promises';

const args = process.argv.slice(2);
const index = args.indexOf('--workspace');
if (index < 0 || !args[index + 1]) throw new Error('Specify --workspace <directory>.');
const workspace = claudeWorkspace(path.resolve(args[index + 1]));
const config = conversation(workspace.directory);
if (args.includes('--return')) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Закрой сессию Клавы в разделе Code. Для возврата в игру введи «закрыл»: ');
    if (answer.trim().toLowerCase() !== 'закрыл') throw new Error('Возврат отменён.');
    returnConversation(workspace.directory, true);
    console.log('Разговор возвращён игре. История сохранена.');
  } finally { rl.close(); }
  process.exit(0);
}
const exe = findClaude();
if (!exe) throw new Error('Claude Code is not installed.');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'klava-terminal-'));
const contextFile = path.join(temp, 'instructions.md');
const systemIndex = workspace.args.indexOf('--append-system-prompt');
const system = workspace.args[systemIndex + 1];
const launchArgs = [...workspace.args.slice(0, systemIndex), '--append-system-prompt-file', contextFile,
  '--tools', '', '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--system-prompt-snapshot', 'off'];
const check = args.includes('--check');
const desktop = args.includes('--desktop');
if (desktop && !config) throw new Error('Сначала подключи общую сессию Клавы.');
if (check) launchArgs.push('-p', '--output-format', 'json', '--no-session-persistence',
  'Проверка запуска терминала. По загруженным инструкциям кратко назови своё имя, роль и два проекта. Ничего не записывай и не выполняй ревью.');
else {
  launchArgs.push('--name', 'Клава — TradeRecord и AgentCraft');
  if (config) launchArgs.push('--resume', config.sessionId);
  else if (args.includes('--continue')) launchArgs.push('--continue');
}
let lease, keepDesktopLease = false;
try {
  if (config && !check) {
    lease = acquireConversation(workspace.directory, desktop ? 'desktop' : 'terminal');
    await requireSession(workspace.directory, config);
  }
  await fs.writeFile(contextFile, `${system}\n\n${workspace.instructions}${config ? importContext(config) : ''}`, 'utf8');
  const actualArgs = desktop ? ['--desktop', '--resume', config.sessionId] : launchArgs;
  const child = spawn(exe, actualArgs, { cwd: workspace.directory, stdio: 'inherit', shell: false, windowsHide: check });
  lease?.child(child.pid);
  // Let Claude handle Ctrl+C in the shared interactive console.
  const interrupted = () => {};
  process.on('SIGINT', interrupted);
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve(code ?? 1));
    });
    // Desktop owns its process independently. Only the explicit return launcher releases it.
    keepDesktopLease = desktop && process.exitCode === 0;
    if (keepDesktopLease) console.log('После закрытия сессии в Code запусти Return-Klava-To-Game.cmd.');
  } finally { process.removeListener('SIGINT', interrupted); }
} finally {
  if (!keepDesktopLease) lease?.release();
  await fs.unlink(contextFile).catch(() => {});
  await fs.rmdir(temp).catch(() => {});
}
