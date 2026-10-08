// Isolated installed-package trial. No real provider login, personal profile or Minecraft launch.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { auditPortable } from '../audit-portable.mjs';
import { installPackage, inspectRelease, inside } from '../lib/portable-install.mjs';
import { ForemanClient } from '../lib/foremanclient.mjs';

const source = path.resolve(process.argv[2]);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentcraft-clean-trial-'));
const target = path.join(temp, 'installed'), game = path.join(temp, 'game'), home = path.join(target, 'data');
const profile = path.join(home, 'portable'), account = path.join(temp, 'empty-account');
let child, client;
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())); return port;
}
async function launch() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP)$/i.test(key)));
  Object.assign(env, { USERPROFILE: account, HOME: account, APPDATA: path.join(account, 'Roaming'), LOCALAPPDATA: path.join(account, 'Local'),
    CODEX_HOME: path.join(account, 'codex'), CLAUDE_CONFIG_DIR: path.join(account, 'claude'), AGENTCRAFT_CHAT_CONFIG: path.join(profile, 'no-binding.json') });
  child = spawn(path.join(target, 'runtime/node.exe'), [path.join(target, 'foreman/src/observer-main.mjs'), '--home', home, '--profile', 'portable', '--port', String(await freePort())],
    { cwd: target, env, windowsHide: true, stdio: 'ignore' });
  const failure = new Promise((_, reject) => child.once('error', reject));
  const ready = (async () => {
    for (let n = 0; n < 150; n++) {
      if (child.exitCode !== null) throw Error('Installed bridge exited before readiness');
      const owner = await fs.readFile(path.join(profile, 'portable.json'), 'utf8').then(JSON.parse).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (owner) {
        assert.equal(owner.pid, child.pid); // Never connect to or stop someone else's bridge.
        client = await ForemanClient.connect({ port: owner.port, timeoutMs: 5000 }); return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error('Installed bridge readiness timed out');
  })();
  await Promise.race([failure, ready]);
}
async function stop() {
  client?.close(); client = undefined;
  const owner = JSON.parse(await fs.readFile(path.join(profile, 'portable.json'), 'utf8')); assert.equal(owner.pid, child.pid);
  const exited = once(child, 'exit'); await fs.writeFile(path.join(profile, 'portable-stop.json'), JSON.stringify(owner));
  let timeout;
  try {
    const [code] = await Promise.race([exited, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Installed bridge did not stop')), 10000); })]);
    assert.equal(code, 0); child = undefined;
  } finally { clearTimeout(timeout); }
}
try {
  const release = await inspectRelease(source), audit = await auditPortable(source); assert.equal(audit.ok, true, JSON.stringify(audit));
  await fs.mkdir(game); await fs.mkdir(account);
  const fabricVersion = path.join(temp, 'fabric.json');
  await fs.writeFile(fabricVersion, JSON.stringify({ id: 'trial-fixture', inheritsFrom: release.build.minecraft,
    mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient', libraries: [{ name: 'net.fabricmc:fabric-loader:' + release.build.fabricLoader.replace(/\+$/, '') }] }));
  // Only the disposable installation uses a process fixture. OS process guards have separate tests.
  await installPackage({ source, target, game, fabricVersion }, { probe: async () => [] });
  assert.equal((await inspectRelease(target)).build.version, release.build.version);
  await assert.rejects(fs.access(home), /ENOENT/);
  await launch();
  assert.equal(client.state.agents.size, 0); assert.equal(client.state.tasks.size, 0); assert.equal(client.state.repos.size, 0); assert.equal(client.state.memory.size, 0);
  const before = (await client.send('studio.action', { action: 'team.get', payload: {} })).result;
  assert.equal(before.agents.length, 0);
  await client.send('studio.action', { action: 'team.create', payload: { revision: before.revision, agent: { name: 'Trial reviewer', provider: 'codex', roles: ['reviewer'], enabled: false,
    visible: true, appearance: { skin: 'marlow', color: '#123456', slim: false } } } });
  const created = (await client.send('studio.action', { action: 'team.get', payload: {} })).result.agents[0];
  assert.equal(created.connectionRef, null); assert.equal(created.enabled, false);
  await stop(); await launch();
  const restored = (await client.send('studio.action', { action: 'team.get', payload: {} })).result.agents;
  assert.equal(restored.length, 1); assert.equal(restored[0].id, created.id); assert.equal(restored[0].connectionRef, null);
  await stop();
  assert.deepEqual(await fs.readdir(account), []);
  assert.equal((await auditPortable(source)).ok, true); // Only unused release folders are distributable.
  console.log(JSON.stringify({ trial: 'clean installed package', passed: ['release leak audit', 'separate installation', 'fresh empty profile', 'installed bridge startup', 'empty account environment', 'disabled unbound agent', 'restart persistence', 'isolated shutdown'], modelsInvoked: false, gameLaunched: false, processProbe: 'fixture for disposable installation', fabricMetadata: 'fixture' }));
} finally {
  client?.close();
  if (child && child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
  assert(inside(os.tmpdir(), temp)); assert(path.basename(temp).startsWith('agentcraft-clean-trial-'));
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
