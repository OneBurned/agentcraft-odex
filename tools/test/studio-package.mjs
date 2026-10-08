// Explicit portable integration check: node tools/test/studio-package.mjs <package directory>.
// Uses a separate port/home and no desktop binding; never sends a message to the user's chat.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { ForemanClient } from '../lib/foremanclient.mjs';
import { randomUUID } from 'node:crypto';
import { Client } from '../../foreman/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../foreman/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const pkg = path.resolve(process.argv[2]);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentcraft-package-check-'));
const home = path.join(temp, 'data'); const repo = path.join(temp, 'repo'); const port = 17878;
const workspace = path.join(temp, 'workspace'), claudeHome = path.join(temp, 'claude');
const sessionId = randomUUID(); let parent = null, transcript;
async function nativeMessage(role, text) {
  const uuid = randomUUID(); await fs.appendFile(transcript, JSON.stringify({ type: role, uuid, parentUuid: parent, sessionId, cwd: workspace, timestamp: new Date().toISOString(), message: { role, content: [{ type: 'text', text }] } }) + '\n'); parent = uuid; return uuid;
}
let child, client, currentProfile = 'smoke';
async function launch(profile = 'smoke') {
  currentProfile = profile;
  child = spawn(path.join(pkg, 'runtime/node.exe'), [path.join(pkg, 'foreman/src/observer-main.mjs'), '--home', home, '--profile', currentProfile, '--port', String(port), '--repo', repo],
    { windowsHide: true, stdio: 'ignore', env: { ...process.env, CLAUDE_CONFIG_DIR: claudeHome, AGENTCRAFT_CHAT_CONFIG: path.join(temp, 'no-binding.json') } });
  client = await ForemanClient.connect({ port, timeoutMs: 15000 });
  let owner;
  for (let n = 0; n < 100 && !owner; n++) {
    try { owner = JSON.parse(await fs.readFile(path.join(home, currentProfile, 'portable.json'), 'utf8')); }
    catch { if (child.exitCode !== null) throw new Error('Isolated bridge exited'); await new Promise(r => setTimeout(r, 100)); }
  }
  assert.ok(owner, 'Isolated bridge initialization must finish');
  assert.equal(owner.pid, child.pid, 'Must use only the isolated test bridge');
}
async function stop() {
  client?.close(); client = undefined;
  const owner = JSON.parse(await fs.readFile(path.join(home, currentProfile, 'portable.json'), 'utf8'));
  const exited = new Promise(resolve => child.once('exit', resolve));
  await fs.writeFile(path.join(home, currentProfile, 'portable-stop.json'), JSON.stringify(owner));
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('Bridge did not stop')), 10000).unref())]);
  child = undefined;
}
try {
  await fs.mkdir(repo);
  execFileSync('git', ['init', '-q', repo], { windowsHide: true });
  await fs.writeFile(path.join(repo, 'README.txt'), 'Smoke fixture');
  execFileSync('git', ['add', '.'], { cwd: repo, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'Fixture'], { cwd: repo, windowsHide: true });
  await fs.mkdir(workspace); await fs.mkdir(path.join(home, 'smoke'), { recursive: true });
  for (const name of ['CLAUDE.md', 'PROJECTS.md', 'MEMORY.md']) await fs.writeFile(path.join(workspace, name), 'Smoke fixture');
  await fs.writeFile(path.join(workspace, 'access.json'), JSON.stringify({ version: 1, repositories: [{ id: 'fixture', name: 'Fixture', path: repo, github: 'Fixture/Fixture' }] }));
  await fs.writeFile(path.join(workspace, 'conversation.json'), JSON.stringify({ version: 1, sessionId }));
  await fs.writeFile(path.join(home, 'smoke', 'claude-workspace.json'), JSON.stringify({ directory: workspace }));
  const project = path.join(claudeHome, 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-')); await fs.mkdir(project, { recursive: true });
  transcript = path.join(project, sessionId + '.jsonl');
  await nativeMessage('user', 'Previous message'); const originalCursor = await nativeMessage('assistant', 'Previous reply');
  await launch('team-smoke');
  assert.equal(client.state.agents.size, 0, 'A new profile must not create demo agents');
  let team = (await client.send('studio.action', { action: 'team.get', payload: {} })).result;
  assert.equal(team.revision, 0);
  for (const provider of ['codex', 'codex', 'claude']) {
    team = (await client.send('studio.action', { action: 'team.create', payload: { revision: team.revision, agent: {
      name: 'Agent', provider, roles: ['developer', 'reviewer'], enabled: true, visible: true,
      appearance: { skin: 'marlow', color: '#123456', slim: false },
    } } })).result;
  }
  assert.equal(client.state.agents.size, 3);
  const archivedId = team.agents[0].id;
  team = (await client.send('studio.action', { action: 'team.archive', payload: { revision: team.revision, id: archivedId } })).result;
  assert.equal(client.state.agents.has(archivedId), false);
  await stop(); await launch('team-smoke');
  assert.equal(client.state.agents.size, 2);
  await client.send('studio.action', { action: 'team.restore', payload: { revision: team.revision, id: archivedId } });
  assert.equal(client.state.agents.get(archivedId).enabled, false);
  await stop();
  // Explicit pre-A2 profile fixture: compatibility testing must not rely on a new profile having a cast.
  await fs.writeFile(path.join(home, 'smoke', 'state.json'), JSON.stringify({ version: 1, agents: [{
    id: 'marlow', name: 'Legacy', role: 'lead', color: '#123456', skin: 'marlow',
    state: 'idle', activity: '', station: 'lounge', paused: false, active: true,
  }] }));
  await launch();
  const get = () => client.send('studio.action', { action: 'get' }).then(a => a.result);
  for (let n = 0; n < 80 && (await get()).dialog?.sessionCursor !== originalCursor; n++) await new Promise(r => setTimeout(r, 100));
  assert.equal((await get()).dialog.sessionCursor, originalCursor, 'Bundled SDK must read the bound native session');
  assert.equal((await get()).version, 1);
  const created = await client.send('studio.action', { action: 'create', payload: { title: 'Проверка пакета', description: 'Не выполнять', expected: 'Черновик на доске' } });
  const id = created.result.items[0].id;
  await client.send('studio.action', { action: 'approve', payload: { id } });
  await client.send('studio.action', { action: 'note', payload: { title: 'Общая заметка', body: 'Проверка сохранения' } });
  await client.send('studio.action', { action: 'pause' });
  await stop(); await launch();
  const restored = await get();
  assert.equal(restored.mode, 'paused'); assert.equal(restored.items[0].stage, 'queued');
  assert.equal(restored.notes[0].body, 'Проверка сохранения'); assert.equal(restored.active, undefined);
  assert.equal(restored.dialog.sessionCursor, originalCursor);
  const longReply = 'New terminal reply\n\n' + 'Подробный пункт списка\n'.repeat(80) + '\nПоследний абзац';
  await nativeMessage('user', 'New terminal message'); const nextCursor = await nativeMessage('assistant', longReply);
  for (let n = 0; n < 80 && (await get()).dialog?.sessionCursor !== nextCursor; n++) await new Promise(r => setTimeout(r, 100));
  assert.equal((await get()).dialog.sessionCursor, nextCursor, 'New terminal history must reach the restarted game bridge');
  assert.equal(client.state.feed.filter(f => f.fullText === longReply).length, 1, 'A long reply must reach the console as one complete message with paragraphs');
  assert.equal(path.normalize(restored.helper), path.join(pkg, 'studio.mjs'));
  const helperResult = execFileSync(path.join(pkg, 'runtime/node.exe'), [path.join(pkg, 'studio.mjs'), 'get', '--port', String(port)], { windowsHide: true, encoding: 'utf8' });
  assert.equal(JSON.parse(helperResult).items[0].id, id);
  const binding = { version: 1, workspace, profile: path.join(home, 'smoke'), port, token: randomUUID() };
  for (const directory of [workspace, binding.profile]) await fs.writeFile(path.join(directory, 'planning.json'), JSON.stringify(binding));
  await client.send('studio.action', { action: 'agent', payload: { ...(await get()).profiles.find(p => p.id === 'wren'), enabled: true } });
  await client.send('studio.action', { action: 'plan' });
  const mcp = new Client({ name: 'package-planning-test', version: '1' });
  const transport = new StdioClientTransport({ command: path.join(pkg, 'runtime/node.exe'), args: [path.join(pkg, 'foreman/src/claude-workspace-server.mjs'), '--workspace', workspace], stderr: 'pipe' });
  try {
    await mcp.connect(transport);
    const tools = (await mcp.listTools()).tools;
    assert.equal(tools.find(t => t.name === 'planning_create').annotations.readOnlyHint, false);
    const args = { requestId: 'package-draft', project: 'fixture', title: 'План Клавы', description: 'Не выполнять', expected: 'Только черновик', deps: [id] };
    const call = async () => { const r = await mcp.callTool({ name: 'planning_create', arguments: args }); assert.ok(!r.isError); return JSON.parse(r.content[0].text); };
    const draft = await call(); assert.equal(draft.item.stage, 'plan'); assert.equal((await call()).item.id, draft.item.id);
    assert.equal((await get()).items.length, 2); assert.equal((await get()).active, undefined);
    await stop(); await launch();
    assert.equal((await call()).duplicate, true, 'Bundled planning deduplication must survive restart');
    assert.equal((await get()).items[1].stage, 'plan');
  } finally { await mcp.close(); }
  await stop(); console.log('Portable studio: empty team, three agents, archive/restore/restart, legacy profile protocol, draft approval, memory, native session projection, helper and bundled MCP draft creation/restart passed. No chat messages sent.');
} finally {
  client?.close(); if (child && child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 3 });
}
