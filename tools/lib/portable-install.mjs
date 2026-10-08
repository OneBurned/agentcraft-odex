// Package transactions touch only declared release files and the two identified Minecraft mods.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readZip } from './zip.mjs';
const exec = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = async file => { try { return await fs.readFile(file); } catch (e) { if (e.code !== 'ENOENT') throw e; return null; } };
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
export function inside(root, file) { const rel = path.relative(root, file); return rel === '' || !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel); }
export async function noLinks(file) {
  let current = path.resolve(file), parent;
  while (current !== (parent = path.dirname(current))) {
    try { const stat = await fs.lstat(current); if (stat.isSymbolicLink()) throw Error('Symlinks/junctions are not supported / Ссылки и junction не поддерживаются.'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    current = parent;
  }
}
function relative(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes(':') || name.startsWith('/') || name.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) throw Error('Unsafe package path');
  return name;
}
async function child(root, name) { const file = path.resolve(root, relative(name)); if (!inside(root, file)) throw Error('Path escaped its root'); await noLinks(file); return file; }
function managedName(name) {
  relative(name);
  if (/^(data|logs|workspaces|backups|\.installer[^/]*)(\/|$)/i.test(name) || /^installation\.json$/i.test(name)) throw Error('User state is not a release file');
}
export async function files(root, prefix = '') {
  const out = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const name = prefix + entry.name, file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw Error('Linked files cannot be packaged/backed up');
    if (entry.isDirectory()) out.push(...await files(file, name + '/'));
    else if (entry.isFile()) out.push(name); else throw Error('Unsupported file');
  }
  return out;
}
export async function writeReleaseManifest(root) {
  const entries = {};
  for (const name of await files(root)) if (name !== 'release-manifest.json') entries[name] = hash(await fs.readFile(await child(root, name)));
  await fs.writeFile(path.join(root, 'release-manifest.json'), encode({ format: 1, files: entries }));
}
export async function inspectRelease(root) {
  root = path.resolve(root); await noLinks(root);
  const ready = await json(path.join(root, 'PACKAGE-READY.json')), build = await json(path.join(root, 'BUILD.json')), manifest = await json(path.join(root, 'release-manifest.json'));
  if (ready.privacyAudit !== 'pass' || ready.version !== build.version || manifest.format !== 1 || !manifest.files || typeof manifest.files !== 'object') throw Error('Incomplete release / Пакет не готов.');
  for (const [name, digest] of Object.entries(manifest.files)) {
    managedName(name);
    if (!/^[a-f0-9]{64}$/.test(digest) || hash(await fs.readFile(await child(root, name))) !== digest) throw Error(`Package checksum mismatch: ${name}`);
  }
  for (const required of ['BUILD.json', 'PACKAGE-READY.json', 'runtime/node.exe', 'foreman/src/observer-main.mjs', 'Setup.cmd', 'setup.mjs', 'Start-Bridge.ps1', 'config/agentcraft-client.json'])
    if (!manifest.files[required]) throw Error(`Missing release member: ${required}`);
  const mods = [];
  for (const name of Object.keys(manifest.files).filter(n => /^mods\/[^/]+\.jar$/.test(n))) {
    const info = modInfo(await fs.readFile(await child(root, name)));
    if (['agentcraft', 'fabric-api'].includes(info?.id)) mods.push({ name, id: info.id });
  }
  if (mods.length !== 2 || new Set(mods.map(m => m.id)).size !== 2) throw Error('Expected AgentCraft and Fabric API');
  return { root, build, manifest, mods };
}
function modInfo(bytes) { const entry = readZip(bytes).find(e => e.name === 'fabric.mod.json'); return entry ? JSON.parse(entry.data.toString('utf8')) : undefined; }
export async function verifyFabric(file, build) {
  await noLinks(file); const v = await json(file);
  const loader = v.libraries?.find(l => typeof l.name === 'string' && l.name.startsWith('net.fabricmc:fabric-loader:'))?.name.split(':')[2];
  const tuple = s => /^\d+\.\d+\.\d+$/.test(s ?? '') ? s.split('.').map(Number) : null;
  const actual = tuple(loader), minimum = tuple(build.fabricLoader?.replace(/\+$/, ''));
  if (v.inheritsFrom !== build.minecraft || !/net\.fabricmc\.loader\..*KnotClient$/.test(v.mainClass ?? '') || !actual || !minimum || actual[0] < minimum[0] || actual[0] === minimum[0] && (actual[1] < minimum[1] || actual[1] === minimum[1] && actual[2] < minimum[2]))
    throw Error(`Select Fabric ${build.fabricLoader}, Minecraft ${build.minecraft} / Выбери подходящий JSON профиля Fabric.`);
  return { id: v.id, loader, minecraft: v.inheritsFrom };
}
export async function windowsProcesses() {
  if (process.platform !== 'win32') throw Error('This installer supports Windows / Мастер предназначен для Windows.');
  const script = "Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress";
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
  const result = JSON.parse(stdout.replace(/^\uFEFF/, '')); return Array.isArray(result) ? result : [result];
}
export function assertStopped(processes, target) {
  for (const p of processes) {
    if (p.ProcessId === process.pid) continue;
    const name = String(p.Name ?? '').toLowerCase(), cmd = p.CommandLine;
    if (/^javaw?\.exe$/.test(name) && (!cmd || /minecraft|fabricmc|KnotClient|net\.minecraft/i.test(cmd))) throw Error('Close Minecraft first / Сохрани мир и закрой Minecraft.');
    if (/^node(?:\.exe)?$/.test(name) && (!cmd || /observer-main\.(mjs|ts)|foreman[\\/]src[\\/]main\.(ts|mjs)/i.test(cmd) || String(cmd).toLowerCase().includes(target.toLowerCase())))
      throw Error('Stop the bridge first / Сначала останови мост.');
  }
}
async function assertOwnerFilesStopped(target) {
  const data = path.join(target, 'data');
  if (!await read(path.join(target, 'installation.json')) && !await fs.stat(data).catch(() => null)) return;
  await noLinks(data);
  const names = await fs.readdir(data, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  const runfiles = [path.join(data, 'foreman.json'), ...names.filter(e => e.isDirectory()).flatMap(e => ['foreman.json', 'portable.json'].map(f => path.join(data, e.name, f)))];
  for (const f of runfiles) {
    await noLinks(f); const bytes = await read(f); if (!bytes) continue;
    const owner = JSON.parse(bytes);
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw Error('Unrecognized bridge owner file / Проверь файл владельца моста.');
    try { process.kill(owner.pid, 0); throw Error('Bridge owner process is alive / Процесс владельца моста ещё существует.'); }
    catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
}
async function stopped(target, probe) { assertStopped(await probe(), target); await assertOwnerFilesStopped(target); }
export async function assertInstallationStopped(target, probe = windowsProcesses) {
  target = await rootPath(target); await stopped(target, probe);
  if (await read(path.join(target, '.installer-active.json'))) throw Error('Complete setup recovery first / Сначала выполни восстановление установки.');
}
export async function withOfflineProfile(target, probe = windowsProcesses, action) {
  target = await rootPath(target); await assertInstallationStopped(target, probe);
  const lock = path.join(target, '.installer-active.json'); await noLinks(lock);
  await fs.writeFile(lock, encode({ kind: 'profile', pid: process.pid }), { flag: 'wx' });
  try { await stopped(target, probe); return await action(() => stopped(target, probe)); }
  finally { await remove(lock); }
}
async function rootPath(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw Error('Use an absolute directory / Нужен полный путь к папке.');
  const root = path.resolve(p); if (root === path.parse(root).root) throw Error('Do not select a drive root / Не выбирай корень диска.'); await noLinks(root); return root;
}
async function put(file, bytes) {
  await noLinks(file); await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.install-' + randomUUID(); await fs.writeFile(temp, bytes, { flag: 'wx' });
  try { await fs.rename(temp, file); } catch (e) { await fs.unlink(temp); throw e; }
}
async function remove(file) { await noLinks(file); try { await fs.unlink(file); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
async function snapshotData(target, game, backup) {
  const sources = [{ root: path.join(target, 'data'), prefix: 'profile' }];
  const config = path.join(game, 'config'); await noLinks(config);
  for (const e of await fs.readdir(config, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; })) {
    if (!/^agentcraft(?:[-.]|$)/i.test(e.name)) continue;
    const source = path.join(config, e.name); await noLinks(source);
    if (e.isDirectory()) sources.push({ root: source, prefix: 'game-settings/' + e.name });
    else if (e.isFile()) await put(await child(backup, 'game-settings/' + e.name), await fs.readFile(source));
  }
  for (const s of sources) {
    await noLinks(s.root); if (!await fs.stat(s.root).catch(() => null)) continue;
    for (const name of await files(s.root)) await put(await child(backup, s.prefix + '/' + name), await fs.readFile(await child(s.root, name)));
  }
}
async function location(tx, op) {
  if (!['package', 'game'].includes(op.area)) throw Error('Invalid transaction area');
  if (op.area === 'package' && op.name !== 'installation.json') managedName(op.name);
  if (op.area === 'game' && !/^(mods\/[^/]+\.jar|config\/agentcraft-client\.json|config\/agentcraft\/buildings\/[^/]+)$/.test(op.name)) throw Error('Unexpected managed game path');
  return child(op.area === 'package' ? tx.target : tx.game, op.name);
}
async function restore(tx, backup) {
  // Verify the entire set before changing anything. Never overwrite unrelated edits during recovery.
  for (const op of tx.operations) {
    const current = await read(await location(tx, op)), currentHash = current === null ? null : hash(current);
    if (currentHash !== op.before && currentHash !== op.after) throw Error(`File changed after setup; preserved: ${op.name}`);
    if (op.before !== null && hash(await fs.readFile(await child(backup, op.backup))) !== op.before) throw Error('Backup checksum mismatch');
  }
  for (const op of [...tx.operations].reverse()) {
    const dest = await location(tx, op);
    if (op.before === null) await remove(dest); else await put(dest, await fs.readFile(await child(backup, op.backup)));
  }
}
async function transact({ target, game, operations, state }, { probe, afterWrite } = {}) {
  const id = Date.now() + '-' + randomUUID(), backup = await child(target, '.installer-backups/' + id), lock = path.join(target, '.installer-active.json');
  await fs.mkdir(target, { recursive: true }); await noLinks(lock);
  await fs.writeFile(lock, encode({ id, pid: process.pid }), { flag: 'wx' }).catch(e => { if (e.code === 'EEXIST') throw Error('Setup interrupted or active: use Recover / Мастер занят или прерван: выбери Восстановление.'); throw e; });
  const tx = { format: 1, id, target, game, operations: [], complete: false };
  let prepared = false;
  try {
    await stopped(target, probe); await fs.mkdir(backup, { recursive: true });
    await snapshotData(target, game, backup);
    if (state) operations.push({ area: 'package', name: 'installation.json', bytes: encode({ ...state, lastTransaction: id }) });
    for (const [n, op] of operations.entries()) {
      const before = await read(await location(tx, op));
      if (before !== null) await put(await child(backup, `files/${n}`), before);
      tx.operations.push({ area: op.area, name: op.name, before: before === null ? null : hash(before), after: op.bytes === null ? null : hash(op.bytes), backup: `files/${n}` });
    }
    await put(path.join(backup, 'transaction.json'), encode(tx)); prepared = true;
    await stopped(target, probe);
    for (const [n, op] of operations.entries()) {
      const dest = await location(tx, op), before = await read(dest);
      if ((before === null ? null : hash(before)) !== tx.operations[n].before) throw Error(`File changed during setup: ${op.name}`);
      if (op.bytes === null) await remove(dest); else { await put(dest, op.bytes); if (hash(await fs.readFile(dest)) !== tx.operations[n].after) throw Error('Copy verification failed'); }
      if (afterWrite) await afterWrite(n); // injected only by module tests, never a command-line bypass
    }
    tx.complete = true; await put(path.join(backup, 'transaction.json'), encode(tx)); await remove(lock);
    return { target, game, backup, version: state?.version };
  } catch (e) {
    if (prepared) {
      try { await stopped(target, probe); await restore(tx, backup); await remove(lock); }
      catch {
        await put(lock, encode({ id })); // This operation has ended; allow explicit recovery in this process too.
        throw Error(`Setup failed; recovery required / Нужна команда Recover. Backup: ${backup}. ${e.message}`);
      }
    } else await remove(lock);
    throw e;
  }
}
export async function installPackage(options, dependencies = {}) {
  const probe = dependencies.probe ?? windowsProcesses, release = await inspectRelease(options.source);
  const target = await rootPath(options.target), game = await rootPath(options.game);
  if ([release.root, game].some(p => inside(p, target) || inside(target, p)) || inside(game, release.root) || inside(release.root, game)) throw Error('Package source, destination and game folders must be separate / Папки пакета, установки и игры должны быть раздельными.');
  if (inside(target, process.execPath)) throw Error('Run Setup from the newly extracted package / Запусти мастер из отдельно распакованного пакета.');
  if (!(await fs.stat(game)).isDirectory()) throw Error('Game directory does not exist');
  await verifyFabric(options.fabricVersion, release.build);
  const oldBytes = await read(path.join(target, 'installation.json')), old = oldBytes ? JSON.parse(oldBytes) : undefined;
  if (old && (old.format !== 1 || path.resolve(old.game) !== game)) throw Error('Update must use the recorded game folder / Обновление должно использовать прежнюю папку игры.');
  if (!old && (await fs.readdir(target).catch(e => { if (e.code === 'ENOENT') return []; throw e; })).length) throw Error('Choose an empty destination / Выбери пустую папку установки.');
  await stopped(target, probe);
  const payload = { ...release.manifest.files, 'release-manifest.json': hash(await fs.readFile(path.join(release.root, 'release-manifest.json'))) };
  const operations = [];
  for (const name of new Set([...Object.keys(old?.managed ?? {}), ...Object.keys(payload)])) {
    managedName(name);
    const dest = await child(target, name), current = await read(dest);
    if (old && current !== null && (old.managed?.[name] === undefined || hash(current) !== old.managed[name])) throw Error(`Managed file was customized; preserved: ${name}`);
    const bytes = payload[name] ? await fs.readFile(await child(release.root, name)) : null;
    if (bytes !== null && hash(bytes) !== payload[name]) throw Error('Source changed during setup');
    operations.push({ area: 'package', name, bytes });
  }
  const mods = path.join(game, 'mods'); await noLinks(mods);
  const gameMods = await fs.readdir(mods, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  const replacement = new Map(release.mods.map(m => [path.basename(m.name), m]));
  for (const e of gameMods.filter(e => e.name.endsWith('.jar'))) {
    const jar = await child(game, 'mods/' + e.name), info = modInfo(await fs.readFile(jar));
    if (['agentcraft', 'fabric-api'].includes(info?.id)) {
      if (!replacement.has(e.name)) operations.push({ area: 'game', name: 'mods/' + e.name, bytes: null });
    } else if (replacement.has(e.name)) throw Error('A destination JAR belongs to another mod');
  }
  const staged = new Map(operations.map(op => [op.name, op.bytes]));
  for (const m of release.mods) operations.push({ area: 'game', name: 'mods/' + path.basename(m.name), bytes: staged.get(m.name) });
  for (const name of Object.keys(payload).filter(n => /^buildings\/(?:[a-z0-9][a-z0-9_-]{0,63}\.schem|SOURCES\.txt)$/.test(n)))
    operations.push({ area: 'game', name: 'config/agentcraft/' + name, bytes: staged.get(name) });
  if (!await read(await child(game, 'config/agentcraft-client.json'))) operations.push({ area: 'game', name: 'config/agentcraft-client.json', bytes: staged.get('config/agentcraft-client.json') });
  const state = { format: 1, version: release.build.version, game, fabricVersion: path.resolve(options.fabricVersion), managed: payload };
  return transact({ target, game, operations, state }, { probe, afterWrite: dependencies.afterWrite });
}
export async function recoverPackage(target, dependencies = {}) {
  target = await rootPath(target); const probe = dependencies.probe ?? windowsProcesses;
  await stopped(target, probe); const lock = await json(path.join(target, '.installer-active.json'));
  if (lock.pid !== undefined) {
    if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0) throw Error('Invalid setup owner');
    try { process.kill(lock.pid, 0); throw Error('Setup is still running'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
  if (lock.kind === 'profile') {
    if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0) throw Error('Invalid setup owner');
    await remove(path.join(target, '.installer-active.json')); return { recovered: true, profile: 'Atomic publication; unfinished drafts retained separately.' };
  }
  const backup = await child(target, '.installer-backups/' + relative(lock.id));
  const journal = await read(await child(backup, 'transaction.json'));
  if (journal === null) {
    // Destination writes start only after the complete journal is saved.
    await remove(path.join(target, '.installer-active.json')); return { recovered: true, backup, prepared: false };
  }
  const tx = JSON.parse(journal);
  if (tx.target !== target || tx.id !== lock.id || tx.format !== 1) throw Error('Recovery belongs to another installation');
  await rootPath(tx.game); await restore(tx, backup); await remove(path.join(target, '.installer-active.json')); return { recovered: true, backup };
}
export async function rollbackPackage(target, dependencies = {}) {
  target = await rootPath(target); const probe = dependencies.probe ?? windowsProcesses;
  if (inside(target, process.execPath)) throw Error('Run rollback from a separate extracted package');
  await stopped(target, probe); const current = await json(path.join(target, 'installation.json'));
  const backup = await child(target, '.installer-backups/' + relative(current.lastTransaction)); const tx = await json(path.join(backup, 'transaction.json'));
  if (!tx.complete || tx.target !== target || tx.game !== current.game || tx.format !== 1) throw Error('Invalid rollback transaction');
  if (!tx.operations.some(op => op.area === 'package' && op.name === 'installation.json' && op.before !== null)) throw Error('First installation has no previous version / У первой установки нет предыдущей версии.');
  const operations = [];
  for (const op of tx.operations) {
    const bytes = await read(await location(tx, op));
    if ((bytes === null ? null : hash(bytes)) !== op.after) throw Error(`Changed since update; preserved: ${op.name}`);
    const previous = op.before === null ? null : await fs.readFile(await child(backup, op.backup));
    if (previous !== null && hash(previous) !== op.before) throw Error('Backup checksum mismatch');
    operations.push({ area: op.area, name: op.name, bytes: previous });
  }
  return transact({ target, game: current.game, operations }, { probe, afterWrite: dependencies.afterWrite });
}
