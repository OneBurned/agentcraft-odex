// Explicit packaged-CLI guard test; synthetic paths only, no real profile or model calls.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const pkg = path.resolve(process.argv[2]);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentcraft-migration-package-'));
async function run(args) {
  const child = spawn(path.join(pkg, 'runtime/node.exe'), [path.join(pkg, 'migrate-team.mjs'), ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  return { code, output };
}
try {
  const profile = path.join(temp, 'profile'), game = path.join(temp, 'game');
  await fs.mkdir(profile); await fs.mkdir(game);
  const original = '{"fixture":"untouched"}\r\n';
  await fs.writeFile(path.join(profile, 'state.json'), original);
  await fs.writeFile(path.join(profile, 'foreman.json'), JSON.stringify({ pid: process.pid }));
  const args = ['apply', '--profile-dir', profile, '--game-dir', game, '--codex-binding', path.join(temp, 'binding.json'), '--backup-dir', path.join(temp, 'backup')];
  const { code, output } = await run(args);
  assert.equal(code, 1); assert.match(output, /Останови мост/);
  assert.equal(await fs.readFile(path.join(profile, 'state.json'), 'utf8'), original);
  assert.deepEqual((await fs.readdir(profile)).sort(), ['foreman.json', 'state.json']);
  assert.equal(await fs.stat(profile + '.migration-lock.json').then(() => true, () => false), false);
  assert.equal(await fs.stat(path.join(temp, 'backup')).then(() => true, () => false), false);
  await fs.unlink(path.join(profile, 'foreman.json'));
  const workspace = path.join(temp, 'workspace'); await fs.mkdir(workspace);
  for (const name of ['CLAUDE.md', 'MEMORY.md', 'PROJECTS.md']) await fs.writeFile(path.join(workspace, name), 'Synthetic instructions');
  await fs.writeFile(path.join(workspace, 'access.json'), JSON.stringify({ version: 1, repositories: [{ id: 'fixture', name: 'Fixture', path: temp, github: 'example/fixture' }] }));
  await fs.writeFile(path.join(workspace, 'conversation.json'), JSON.stringify({ version: 1, sessionId: randomUUID() }));
  await fs.writeFile(path.join(profile, 'claude-workspace.json'), JSON.stringify({ directory: workspace }));
  await fs.writeFile(path.join(temp, 'binding.json'), JSON.stringify({ threadId: randomUUID(), hostId: 'local', title: 'Fixture', pipePath: '\\\\.\\pipe\\codex-browser-use-nonexistent-' + randomUUID() }));
  const state = JSON.stringify({ version: 1, agents: [{ id: 'marlow' }, { id: 'wren' }], tasks: [], backend: { studio: { version: 1, mode: 'paused', items: [], profiles: [{ id: 'marlow' }, { id: 'wren' }] } } });
  await fs.writeFile(path.join(profile, 'state.json'), state);
  const checked = await run(args);
  assert.equal(checked.code, 1);
  assert.match(checked.output, /Minecraft|Нет связи с приложением Codex|Проверка закрытой игры/);
  assert.equal(await fs.readFile(path.join(profile, 'state.json'), 'utf8'), state);
  assert.equal(await fs.stat(profile + '.migration-lock.json').then(() => true, () => false), false);
  console.log('Packaged migration CLI: live-owner and readiness refusals, workspace validation without source dependencies, unchanged files and released lock passed. No model calls.');
} finally {
  // Only the exact OS-created temporary directory above is removed.
  await fs.rm(temp, { recursive: true, force: true });
}
