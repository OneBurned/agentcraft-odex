import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { parseArgs } from 'node:util';
import { TeamRegistry } from './team.js';
import { AgentConnections } from './agent-connections.js';
import { acquireConversation, conversation, requireSession, importContext } from './claude-conversation.js';
import { claudeWorkspace } from './claude-workspace.js';
import { findClaude } from './studio-review.js';
import { ClaudeProcess } from './agents/claude/process.js';
import { ChannelMailbox, ChannelControl, ChannelReceipt, type ChannelOwner } from './claude-channel-mailbox.js';
import { writeJsonAtomic } from './util/fsx.js';
import { channelSessions } from './claude-channel-status.js';
import { channelToolPolicy } from './claude-channel-tools.js';

const { values } = parseArgs({ options: { 'profile-dir': { type: 'string' }, agent: { type: 'string' }, 'file-tools': { type: 'boolean', default: false } } });
if (!values['profile-dir'] || !values.agent) throw new Error('Use --profile-dir <path> --agent <id>');
const profile = fs.realpathSync(values['profile-dir']);
const team = new TeamRegistry(profile), store = new AgentConnections(profile, team);
const agent = team.get(values.agent);
if (!agent || agent.archived || !agent.enabled) throw new Error('Сначала включи выбранного агента.');
const binding = store.read(values.agent);
if (binding?.transport !== 'claude-channel') throw new Error('Сначала подключи агенту транспорт claude-channel.');
const c = binding;
store.assertCurrent(c);
const exe = findClaude(c.executable);
if (!exe) throw new Error('Claude Code не найден.');
const config = conversation(c.workspace)!;
const workspace = claudeWorkspace(c.workspace);
const mailbox = new ChannelMailbox(c.workspace);
const lease = acquireConversation(c.workspace, 'channel');
const processFile = path.join(mailbox.root, 'process.json');
const tracker = new ClaudeProcess(processFile);
let child: ChildProcess | undefined, closing = false, polling = false;
const owner: ChannelOwner = { agentId: c.agentId, sessionId: c.sessionId, profile,
  token: randomUUID(), generation: randomUUID(), pid: process.pid, updated: Date.now(), phase: 'stopped' };
const here = path.dirname(fileURLToPath(import.meta.url));
const stoppedInput = (chunk: Buffer | string) => {
  const value = chunk.toString();
  if (value.includes('\x03') || value.trim().toLowerCase() === 'exit') void close();
};
function entry(name: string) {
  const bundle = path.join(here, `${name}.mjs`);
  return fs.existsSync(bundle) ? [bundle] : ['--import', import.meta.resolve('tsx'), path.join(here, `${name}.ts`)];
}
function save() { owner.updated = Date.now(); mailbox.writeOwner(owner); }
async function launch() {
  store.assertCurrent(c!);
  process.stdin.removeListener('data', stoppedInput); process.stdin.pause();
  if (child || tracker.busy()) throw new Error('Остановка предыдущего процесса не подтверждена.');
  await requireSession(c!.workspace, config);
  if ((await channelSessions(exe!, c!.workspace)).length) throw new Error('В рабочем пространстве уже открыт разговор вне launcher.');
  owner.generation = randomUUID(); owner.phase = 'starting'; delete owner.error; delete owner.childPid; save();
  const spec = path.join(mailbox.root, 'launch.json');
  writeJsonAtomic(spec, owner);
  const mcpIndex = workspace.args.indexOf('--mcp-config');
  const mcp = JSON.parse(workspace.args[mcpIndex + 1]!);
  mcp.mcpServers.agentcraft = { command: process.execPath, args: [...entry('claude-channel-server'), '--spec', spec] };
  const context = path.join(mailbox.root, 'instructions.md');
  const policy = channelToolPolicy(values['file-tools']);
  fs.writeFileSync(context, `${policy.instructions ?? workspace.args[workspace.args.indexOf('--append-system-prompt') + 1]}\n${workspace.instructions}${importContext(config)}`);
  const allowed = workspace.args[workspace.args.indexOf('--allowedTools') + 1]! + ',mcp__agentcraft__reply';
  // Interactive startup retains the normal trust and local development confirmations.
  child = spawn(exe!, ['--resume', config.sessionId, '--name', team.get(c!.agentId)!.name,
    '--dangerously-load-development-channels', 'server:agentcraft', '--strict-mcp-config', '--mcp-config', JSON.stringify(mcp),
    ...policy.args, '--allowedTools', allowed,
    '--append-system-prompt-file', context, '--system-prompt-snapshot', 'off'],
  { cwd: workspace.directory, stdio: 'inherit', shell: false });
  const launched = child;
  launched.on('error', e => { owner.phase = 'error'; owner.error = e.message; save(); });
  if (!launched.pid) { child = undefined; throw new Error('Не удалось запустить Claude.'); }
  tracker.attach(launched); lease.child(launched.pid);
  owner.childPid = launched.pid; owner.phase = 'running'; save();
  launched.once('exit', () => {
    // Still require the process-tree check; a dead root does not prove its MCP children exited.
    owner.phase = 'stopped'; save();
  });
}
async function stop() {
  owner.phase = 'stopped'; save(); // Prevent MCP from accepting new requests before termination.
  await tracker.stop();
  // /bg and /fork can move work to a daemon outside our process tree. Never claim to have stopped it.
  if ((await channelSessions(exe!, workspace.directory)).length) throw new Error('В папке осталась сессия вне launcher. Закрой её в Claude; автоматическая остановка не подтверждена.');
  child = undefined; delete owner.childPid; delete owner.error; save();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.removeListener('data', stoppedInput); process.stdin.on('data', stoppedInput); process.stdin.resume();
  if (process.stdout.isTTY) process.stdout.write('\x1b[?1049l\x1b[?25h');
}
async function tick() {
  if (closing || polling) return;
  polling = true;
  try {
    store.assertCurrent(c!); save();
    for (const id of mailbox.list('controls')) {
      if (mailbox.read(mailbox.file('control-results', id), ChannelReceipt)) continue;
      const control = mailbox.read(mailbox.file('controls', id), ChannelControl)!;
      try {
        if (control.token !== owner.token || control.generation !== owner.generation) throw new Error('Владелец канала изменился.');
        if (control.action === 'stop') await stop();
        else if (!child || child.exitCode !== null || child.signalCode !== null) { await stop(); await launch(); }
        writeJsonAtomic(mailbox.file('control-results', id), { id, ok: true });
      } catch (e) {
        owner.phase = 'error'; owner.error = (e as Error).message; save();
        writeJsonAtomic(mailbox.file('control-results', id), { id, ok: false, error: owner.error });
      }
    }
    if (child && (child.exitCode !== null || child.signalCode !== null) && tracker.busy()) await stop();
  } catch (e) { owner.phase = 'error'; owner.error = (e as Error).message; save(); }
  finally { polling = false; }
}
let timer: NodeJS.Timeout | undefined;
async function close() {
  if (closing) return; closing = true; clearInterval(timer);
  while (polling) await new Promise(r => setTimeout(r, 50));
  try { await stop(); lease.release(); process.exitCode = 0; }
  catch (e) { process.stderr.write(`${(e as Error).message}\n`); process.exitCode = 1; }
  process.stdin.removeListener('data', stoppedInput); process.stdin.pause();
}
// Ctrl+C belongs to Claude while it is open. When paused, Ctrl+C closes the launcher.
process.on('SIGINT', () => { if (!child) void close(); });
process.on('SIGTERM', () => void close());
try {
  if (tracker.busy()) throw new Error('Осталась запись предыдущего процесса. Сначала проверь и верни разговор.');
  await launch();
  console.error('AgentCraft: канал работает в этом терминале. Pause/Stop завершают Claude; Продолжить снова открывает ту же историю. После остановки Ctrl+C или exit закрывает launcher.');
  timer = setInterval(() => void tick(), 500);
} catch (e) { await close(); throw e; }
