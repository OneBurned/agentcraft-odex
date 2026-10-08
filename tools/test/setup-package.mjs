// Exercise the built installer and offline setup without modifying the user's installation/accounts.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { installPackage, rollbackPackage, inspectRelease, inside, windowsProcesses } from '../lib/portable-install.mjs';
const source = path.resolve(process.argv[2]), temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-setup-package-'));
const target = path.join(temp, 'installation'), game = path.join(temp, 'minecraft'), fabricVersion = path.join(temp, 'fabric.json'), repo = path.join(temp, 'project');
const clean = { probe: async () => [] };
try {
  const release = await inspectRelease(source);
  await fs.mkdir(game); await fs.mkdir(repo);
  await fs.writeFile(fabricVersion, JSON.stringify({ id: 'fixture', inheritsFrom: release.build.minecraft, mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient', libraries: [{ name: 'net.fabricmc:fabric-loader:' + release.build.fabricLoader.replace(/\+$/, '') }] }));
  execFileSync('git', ['init', '-q', repo], { windowsHide: true }); await fs.writeFile(path.join(repo, 'README.txt'), 'fixture project');
  execFileSync('git', ['add', '.'], { cwd: repo, windowsHide: true }); execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Initial'], { cwd: repo, windowsHide: true });
  await installPackage({ source, target, game, fabricVersion }, clean);
  const setup = await import(pathToFileURL(path.join(source, 'foreman/src/setup.mjs')).href);
  const team = await setup.configureFresh(target, { projects: [{ path: repo }], agents: [{ name: 'User reviewer', provider: 'claude', roles: ['reviewer'] }] }, clean.probe);
  assert.equal(team.agents.length, 1); assert.equal(team.agents[0].enabled, false);
  const workspace = await setup.prepareClaude(target, team.agents[0].id, clean.probe);
  assert.equal(JSON.parse(await fs.readFile(path.join(workspace.workspace, 'access.json'))).repositories[0].path, repo);
  await assert.rejects(setup.checkAgent(target, team.agents[0].id, clean.probe), /подключение/);
  const files = ['team.json', 'state.json', 'setup-projects.json'], saved = new Map();
  for (const name of files) saved.set(name, await fs.readFile(path.join(target, 'data/portable', name), 'utf8'));
  await installPackage({ source, target, game, fabricVersion }, clean);
  await rollbackPackage(target, clean);
  for (const name of files) assert.equal(await fs.readFile(path.join(target, 'data/portable', name), 'utf8'), saved.get(name));
  await fs.writeFile(path.join(target, '.installer-active.json'), '{}');
  const blocked = spawnSync(path.join(source, 'runtime/node.exe'), [path.join(target, 'foreman/src/observer-main.mjs'), '--home', path.join(target, 'data'), '--profile', 'portable', '--port', '19879'], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
  assert.notEqual(blocked.status, 0); assert.match(blocked.stderr, /Установка не завершена/);
  await fs.unlink(path.join(target, '.installer-active.json'));
  // Read-only OS probe: inspect only the result shape; never print process command lines.
  const processes = await windowsProcesses(); assert(Array.isArray(processes)); assert(processes.some(p => p.ProcessId === process.pid));
  await new Promise((resolve, reject) => {
    const child = spawn(path.join(source, 'runtime/node.exe'), [path.join(source, 'setup.mjs')], { windowsHide: true, stdio: 'pipe' });
    let output = '', language = false, cancel = false;
    const timeout = setTimeout(() => { child.kill(); reject(Error('Wizard cancellation timed out')); }, 10000);
    child.stdout.on('data', b => {
      output += b.toString();
      if (!language && output.includes('Language')) { language = true; child.stdin.write('2\n'); }
      if (!cancel && output.includes('1 Install / update')) { cancel = true; child.stdin.write('0\n'); }
    });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timeout); try { assert.equal(code, 0); assert(language && cancel); resolve(); } catch (e) { reject(e); } });
  });
  console.log('Packaged setup: release integrity, install, fresh local-only profile, Claude workspace, unchanged data across update/rollback, startup guard and Windows process probe passed. No model, real account or game calls.');
} finally {
  assert(inside(os.tmpdir(), temp)); assert(path.basename(temp).startsWith('ac-setup-package-'));
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
