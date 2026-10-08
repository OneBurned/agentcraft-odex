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
import { TeamRegistry } from '../foreman/src/team.ts';
import { AgentConnections } from '../foreman/src/agent-connections.ts';

const args = process.argv.slice(2);
const index = args.indexOf('--workspace');
const profileIndex = args.indexOf('--profile-dir'), agentIndex = args.indexOf('--agent');
let directory = index >= 0 ? args[index + 1] : undefined;
let agentName = 'Claude — AgentCraft';
let agentConnection, connections;
if (profileIndex >= 0 || agentIndex >= 0) {
  if (directory || !args[profileIndex + 1] || profileIndex < 0 || agentIndex < 0 || !args[agentIndex + 1])
    throw new Error('Use --profile-dir <directory> --agent <id>, or --workspace <directory>.');
  const profile = path.resolve(args[profileIndex + 1]);
  await fs.access(path.join(profile, 'team.json'));
  const team = new TeamRegistry(profile);
  const agent = team.get(args[agentIndex + 1]);
  if (!agent || agent.archived) throw new Error('Unknown or archived agent');
  connections = new AgentConnections(profile, team);
  agentConnection = connections.read(agent.id);
  if (agentConnection?.provider !== 'claude') throw new Error('Agent has no Claude connection');
  connections.assertCurrent(agentConnection);
  directory = agentConnection.workspace; agentName = agent.name;
}
if (!directory) throw new Error('Specify --workspace, or --profile-dir and --agent.');
const workspace = claudeWorkspace(path.resolve(directory));
const config = conversation(workspace.directory);
if (args.includes('--return')) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Закрой выбранную сессию Claude в разделе Code. Для возврата в игру введи «закрыл»: ');
    if (answer.trim().toLowerCase() !== 'закрыл') throw new Error('Возврат отменён.');
    returnConversation(workspace.directory, true);
    console.log('Разговор возвращён игре. История сохранена.');
  } finally { rl.close(); }
  process.exit(0);
}
const exe = findClaude(agentConnection?.executable);
if (!exe) throw new Error('Claude Code is not installed.');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'klava-terminal-'));
const contextFile = path.join(temp, 'instructions.md');
const systemIndex = workspace.args.indexOf('--append-system-prompt');
const system = workspace.args[systemIndex + 1];
const launchArgs = [...workspace.args.slice(0, systemIndex), '--append-system-prompt-file', contextFile,
  '--tools', '', '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--system-prompt-snapshot', 'off'];
const check = args.includes('--check');
const desktop = args.includes('--desktop');
if (desktop && !config) throw new Error('Сначала подключи общую сессию Claude.');
if (check) launchArgs.push('-p', '--output-format', 'json', '--no-session-persistence',
  'Проверка запуска терминала. По загруженным инструкциям кратко назови своё имя, роль и доступные проекты. Ничего не записывай и не выполняй ревью.');
else {
  launchArgs.push('--name', agentName);
  if (config) launchArgs.push('--resume', config.sessionId);
  else if (args.includes('--continue')) launchArgs.push('--continue');
}
let lease, keepDesktopLease = false;
try {
  if (config && !check) {
    if (agentConnection) connections.assertCurrent(agentConnection);
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
