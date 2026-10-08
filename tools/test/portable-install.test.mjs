import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { writeZip } from '../lib/zip.mjs';
import { installPackage, rollbackPackage, recoverPackage, writeReleaseManifest, inspectRelease, verifyFabric, assertStopped, inside } from '../lib/portable-install.mjs';
const clean = { probe: async () => [] };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-installer-'));
  t.after(async () => { assert(inside(os.tmpdir(), root)); assert(path.basename(root).startsWith('ac-installer-')); await fs.rm(root, { recursive: true, force: true }); });
  const source = path.join(root, 'release one'), target = path.join(root, 'installed with spaces'), game = path.join(root, 'game'), fabricVersion = path.join(root, 'fabric.json');
  await fs.mkdir(path.join(game, 'mods'), { recursive: true });
  await fs.writeFile(fabricVersion, JSON.stringify({ id: 'fabric-test', inheritsFrom: '26.3', mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient', libraries: [{ name: 'net.fabricmc:fabric-loader:0.19.5' }] }));
  const jar = id => writeZip([{ name: 'fabric.mod.json', data: Buffer.from(JSON.stringify({ id, version: 'test' })) }]);
  async function release(folder, version) {
    const members = { 'BUILD.json': JSON.stringify({ version, minecraft: '26.3', fabricLoader: '0.19.5+' }), 'PACKAGE-READY.json': JSON.stringify({ version, privacyAudit: 'pass' }),
      'runtime/node.exe': 'fixture runtime ' + version, 'foreman/src/observer-main.mjs': 'fixture bridge ' + version, 'Setup.cmd': 'fixture setup', 'setup.mjs': 'fixture entry', 'Start-Bridge.ps1': 'fixture launcher',
      'config/agentcraft-client.json': '{"fixture":true}', [`mods/agentcraft-${version}.jar`]: jar('agentcraft'), 'mods/fabric-api.jar': jar('fabric-api'), 'README.txt': version };
    for (const [name, bytes] of Object.entries(members)) { await fs.mkdir(path.dirname(path.join(folder, name)), { recursive: true }); await fs.writeFile(path.join(folder, name), bytes); }
    await writeReleaseManifest(folder); return folder;
  }
  await release(source, 'one');
  return { root, source, target, game, fabricVersion, jar, release, options: { source, target, game, fabricVersion } };
}
test('installs mods by their real IDs, preserving custom filenames/settings/other mods', async t => {
  const x = await fixture(t);
  await fs.writeFile(path.join(x.game, 'mods/renamed-old.jar'), x.jar('agentcraft'));
  await fs.writeFile(path.join(x.game, 'mods/unrelated.jar'), x.jar('other'));
  await fs.mkdir(path.join(x.game, 'config')); await fs.writeFile(path.join(x.game, 'config/agentcraft-client.json'), 'personal settings');
  const result = await installPackage(x.options, clean);
  assert.equal(await fs.readFile(path.join(x.game, 'config/agentcraft-client.json'), 'utf8'), 'personal settings');
  assert.deepEqual((await fs.readdir(path.join(x.game, 'mods'))).sort(), ['agentcraft-one.jar', 'fabric-api.jar', 'unrelated.jar']);
  const tx = JSON.parse(await fs.readFile(path.join(result.backup, 'transaction.json')));
  const replaced = tx.operations.find(o => o.name === 'mods/renamed-old.jar'); assert(replaced.before);
  assert.deepEqual(await fs.readFile(path.join(result.backup, replaced.backup)), x.jar('agentcraft'));
  assert.equal(await fs.readFile(path.join(x.target, 'README.txt'), 'utf8'), 'one');
});
test('update preserves team, personas, history, memory, bindings, places and worlds; rollback returns binaries', async t => {
  const x = await fixture(t); await installPackage(x.options, clean);
  const personal = ['team.json', 'personas.json', 'agents/a/memory/notes.md', 'connections/a.json', 'state.json'];
  for (const name of personal) { const f = path.join(x.target, 'data/portable', name); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, 'personal ' + name); }
  await fs.mkdir(path.join(x.game, 'saves/World'), { recursive: true }); await fs.writeFile(path.join(x.game, 'saves/World/level.dat'), 'world');
  await fs.writeFile(path.join(x.game, 'config/agentcraft-studio.json'), 'places and skins');
  const source = await x.release(path.join(x.root, 'release two'), 'two');
  const updated = await installPackage({ ...x.options, source }, clean);
  assert.equal(await fs.readFile(path.join(x.target, 'README.txt'), 'utf8'), 'two');
  for (const name of personal) { assert.equal(await fs.readFile(path.join(x.target, 'data/portable', name), 'utf8'), 'personal ' + name); assert.equal(await fs.readFile(path.join(updated.backup, 'profile/portable', name), 'utf8'), 'personal ' + name); }
  // New user data after update is retained by binary rollback, not silently reverted to an old snapshot.
  await fs.writeFile(path.join(x.target, 'data/portable/personas.json'), 'new personal description');
  await rollbackPackage(x.target, clean);
  assert.equal(await fs.readFile(path.join(x.target, 'README.txt'), 'utf8'), 'one');
  assert.deepEqual((await fs.readdir(path.join(x.game, 'mods'))).sort(), ['agentcraft-one.jar', 'fabric-api.jar']);
  assert.equal(await fs.readFile(path.join(x.target, 'data/portable/personas.json'), 'utf8'), 'new personal description');
  assert.equal(await fs.readFile(path.join(x.game, 'config/agentcraft-studio.json'), 'utf8'), 'places and skins');
  assert.equal(await fs.readFile(path.join(x.game, 'saves/World/level.dat'), 'utf8'), 'world');
});
test('rejects wrong Fabric/Minecraft and unsafe/nonempty/overlapping paths before copying', async t => {
  const x = await fixture(t); const build = (await inspectRelease(x.source)).build;
  await assert.rejects(installPackage({ ...x.options, target: x.source }, clean), /separate/);
  await assert.rejects(installPackage({ ...x.options, target: path.join(x.game, 'package') }, clean), /separate/);
  await fs.mkdir(x.target); await fs.writeFile(path.join(x.target, 'personal.txt'), 'keep');
  await assert.rejects(installPackage(x.options, clean), /empty/);
  for (const data of [ { inheritsFrom: '26.2', mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient', libraries: [{ name: 'net.fabricmc:fabric-loader:0.19.5' }] },
    { inheritsFrom: '26.3', mainClass: 'net.minecraft.client.main.Main', libraries: [] },
    { inheritsFrom: '26.3', mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient', libraries: [{ name: 'net.fabricmc:fabric-loader:0.19.4' }] } ]) {
    await fs.writeFile(x.fabricVersion, JSON.stringify(data)); await assert.rejects(verifyFabric(x.fabricVersion, build), /Select Fabric/);
  }
  assert.equal(await fs.readFile(path.join(x.target, 'personal.txt'), 'utf8'), 'keep'); assert.deepEqual(await fs.readdir(path.join(x.game, 'mods')), []);
});
test('refuses running Minecraft, bridges and unverifiable java commands', async t => {
  const x = await fixture(t);
  for (const process of [{ Name: 'javaw.exe', CommandLine: 'net.minecraft.client.main.Main' }, { Name: 'java.exe', CommandLine: null },
    { Name: 'node.exe', CommandLine: 'node observer-main.mjs' }]) {
    await assert.rejects(installPackage(x.options, { probe: async () => [process] }), /Minecraft|bridge/);
  }
  assert.doesNotThrow(() => assertStopped([{ Name: 'java.exe', CommandLine: 'GradleDaemon' }], x.target));
  assert.deepEqual(await fs.readdir(path.join(x.game, 'mods')), []);
});
test('checks runfile PIDs even when the process list omits the bridge', async t => {
  const x = await fixture(t); await installPackage(x.options, clean);
  await fs.mkdir(path.join(x.target, 'data/portable'), { recursive: true });
  await fs.writeFile(path.join(x.target, 'data/portable/foreman.json'), JSON.stringify({ pid: process.pid }));
  await assert.rejects(installPackage(x.options, clean), /owner process/); await assert.rejects(rollbackPackage(x.target, clean), /owner process/);
});
test('rejects checksum mismatch, links, traversal and user data in a release', async t => {
  const x = await fixture(t); await fs.writeFile(path.join(x.source, 'README.txt'), 'modified');
  await assert.rejects(installPackage(x.options, clean), /checksum/);
  await writeReleaseManifest(x.source);
  const link = path.join(x.root, 'linked game'); await fs.symlink(x.game, link, 'junction');
  await assert.rejects(installPackage({ ...x.options, game: link }, clean), /junction/);
  const manifest = JSON.parse(await fs.readFile(path.join(x.source, 'release-manifest.json')));
  manifest.files['../outside'] = '0'.repeat(64); await fs.writeFile(path.join(x.source, 'release-manifest.json'), JSON.stringify(manifest));
  await assert.rejects(inspectRelease(x.source), /Unsafe/);
  delete manifest.files['../outside']; manifest.files['data/portable/team.json'] = '0'.repeat(64);
  await fs.writeFile(path.join(x.source, 'release-manifest.json'), JSON.stringify(manifest)); await assert.rejects(inspectRelease(x.source), /User state/);
});
test('copy failure restores original package and mods automatically', async t => {
  const x = await fixture(t); await installPackage(x.options, clean); const source = await x.release(path.join(x.root, 'two'), 'two');
  await assert.rejects(installPackage({ ...x.options, source }, { ...clean, afterWrite: async n => { if (n === 4) throw Error('injected write failure'); } }), /injected/);
  assert.equal(await fs.readFile(path.join(x.target, 'README.txt'), 'utf8'), 'one');
  assert.equal((await inspectRelease(x.target)).build.version, 'one');
  await assert.rejects(fs.access(path.join(x.target, '.installer-active.json')), /ENOENT/);
});

test('recovery refuses a live installer and releases a guard left before journal preparation', async t => {
  const x = await fixture(t); let checked = false;
  await installPackage(x.options, { ...clean, afterWrite: async n => {
    if (n !== 0) return;
    await assert.rejects(recoverPackage(x.target, clean), /Setup is still running/); checked = true;
  } });
  assert.equal(checked, true);
  await fs.writeFile(path.join(x.target, '.installer-active.json'), JSON.stringify({ id: 'unfinished-preparation' }));
  const result = await recoverPackage(x.target, clean); assert.equal(result.prepared, false);
  assert.equal((await inspectRelease(x.target)).build.version, 'one');
  await assert.rejects(fs.access(path.join(x.target, '.installer-active.json')), /ENOENT/);
});
test('interrupted recovery is explicit; changed managed files are never overwritten', async t => {
  const x = await fixture(t); await installPackage(x.options, clean); const source = await x.release(path.join(x.root, 'two'), 'two'); let blocked = false;
  await assert.rejects(installPackage({ ...x.options, source }, {
    probe: async () => blocked ? [{ Name: 'javaw.exe', CommandLine: 'Minecraft' }] : [],
    afterWrite: async n => { if (n === 3) { blocked = true; throw Error('interrupted'); } },
  }), /Recover/);
  await fs.access(path.join(x.target, '.installer-active.json'));
  await recoverPackage(x.target, clean); assert.equal((await inspectRelease(x.target)).build.version, 'one');
  await installPackage({ ...x.options, source }, clean);
  await fs.writeFile(path.join(x.target, 'README.txt'), 'customized');
  await assert.rejects(rollbackPackage(x.target, clean), /Changed since update/);
  assert.equal(await fs.readFile(path.join(x.target, 'README.txt'), 'utf8'), 'customized');
});
