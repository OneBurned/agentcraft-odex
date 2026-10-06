// Run with node --import tsx. Interactive Claude shares the game's reviewed workspace,
// while retaining its own normal terminal conversation history.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { claudeWorkspace } from '../foreman/src/claude-workspace.ts';
import { findClaude } from '../foreman/src/studio-review.ts';

const args = process.argv.slice(2);
const index = args.indexOf('--workspace');
if (index < 0 || !args[index + 1]) throw new Error('Specify --workspace <directory>.');
const workspace = claudeWorkspace(path.resolve(args[index + 1]));
const exe = findClaude();
if (!exe) throw new Error('Claude Code is not installed.');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'klava-terminal-'));
const contextFile = path.join(temp, 'instructions.md');
const systemIndex = workspace.args.indexOf('--append-system-prompt');
const system = workspace.args[systemIndex + 1];
const launchArgs = [...workspace.args.slice(0, systemIndex), '--append-system-prompt-file', contextFile,
  '--tools', '', '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--system-prompt-snapshot', 'off'];
const check = args.includes('--check');
if (check) launchArgs.push('-p', '--output-format', 'json', '--no-session-persistence',
  'Проверка запуска терминала. По загруженным инструкциям кратко назови своё имя, роль и два проекта. Ничего не записывай и не выполняй ревью.');
else {
  launchArgs.push('--name', 'Клава — TradeRecord и AgentCraft');
  if (args.includes('--continue')) launchArgs.push('--continue');
}
try {
  await fs.writeFile(contextFile, `${system}\n\n${workspace.instructions}`, 'utf8');
  const child = spawn(exe, launchArgs, { cwd: workspace.directory, stdio: 'inherit', shell: false, windowsHide: check });
  // Let Claude handle Ctrl+C in the shared interactive console.
  const interrupted = () => {};
  process.on('SIGINT', interrupted);
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => resolve(code ?? 1));
    });
  } finally { process.removeListener('SIGINT', interrupted); }
} finally {
  await fs.unlink(contextFile).catch(() => {});
  await fs.rmdir(temp).catch(() => {});
}
