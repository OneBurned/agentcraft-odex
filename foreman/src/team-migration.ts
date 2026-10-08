import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { appCall, chatActivity, readBinding, type ChatBinding } from './codex-desktop.js';
import { acquireConversation, conversation, conversationLease, requireSession } from './claude-conversation.js';
import { workspaceInstructions } from './claude-workspace.js';
import { AgentConnections, Connection } from './agent-connections.js';
import { TeamAgent, TeamRegistry } from './team.js';
import { PersonasFile } from './personas.js';
import { loadCast } from './cast.js';
import { maintenanceFile } from './profile-maintenance.js';
import { writeFileAtomic, writeJsonAtomic, isInsideOrEqual } from './util/fsx.js';

export interface MigrationOptions { profileDir: string; gameDir: string; bindingFile: string; backupDir: string; projectRoot?: string; }
export interface MigrationChecks {
  codex(binding: ChatBinding): Promise<void>;
  claude(workspace: string): Promise<void>;
  game(): void;
}
const defaults: MigrationChecks = {
  async codex(binding) {
    const data = await appCall(binding, 'read_thread', { turnLimit: 1, includeOutputs: false });
    if (data?.thread?.id !== binding.threadId || !Array.isArray(data?.turns) || !['idle', 'completed', 'interrupted'].includes(chatActivity(data).phase))
      throw new Error('Разговор Codex занят или его состояние не подтверждено. Заверши работу в чате и повтори перенос.');
  },
  async claude(workspace) { await requireSession(workspace, conversation(workspace)!); },
  game() {
    if (process.platform !== 'win32') throw new Error('Проверка закрытой игры при переносе поддерживает Windows.');
    const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; $running=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^javaw?\\.exe$' -and ((-not $_.CommandLine) -or $_.CommandLine -match 'minecraft|fabricmc|quiltmc') }); if($running.Count){'busy'}else{'closed'}"],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim();
    if (result !== 'closed') throw new Error('Сохрани мир и полностью закрой Minecraft перед переносом или восстановлением.');
  },
};
const json = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } }
function noLinks(file: string) {
  let at = path.resolve(file);
  for (;;) {
    try { if (fs.lstatSync(at).isSymbolicLink()) throw new Error(`Ссылка или junction не поддерживается: ${at}`); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const parent = path.dirname(at); if (parent === at) break; at = parent;
  }
}
function offline(profile: string) {
  for (const name of ['foreman.json', 'portable.json']) {
    const file = path.join(profile, name);
    if (!fs.existsSync(file)) continue;
    const record = json(file);
    if (!Number.isInteger(record.pid) || record.pid <= 0) throw new Error(`Не удалось проверить владельца ${name}.`);
    if (alive(record.pid)) throw new Error('Останови мост перед переносом или восстановлением профиля.');
  }
}
function stopped(state: any) {
  const studio = state?.backend?.studio;
  if (state?.version !== 1 || studio?.version !== 1 || !Array.isArray(state.agents) || !Array.isArray(state.tasks) || !Array.isArray(studio.profiles))
    throw new Error('Нужен корректный старый профиль со state.json и пультом версии 1; файлы не изменены.');
  if (!['planning', 'paused'].includes(studio.mode) || studio.active || studio.items?.some((i: any) => ['coding', 'review'].includes(i.stage)) ||
      state.tasks.some((t: any) => ['doing', 'review'].includes(t.status)))
    throw new Error('Очередь или задача активна. Приостанови работу в пульте и заверши активные операции перед переносом.');
  return studio;
}
function safeOptions(input: MigrationOptions): MigrationOptions {
  const result = { ...input };
  for (const key of ['profileDir', 'gameDir', 'bindingFile', 'backupDir'] as const) {
    if (!path.isAbsolute(result[key])) throw new Error(`Нужен абсолютный путь: ${key}`);
    result[key] = path.resolve(result[key]); noLinks(result[key]);
  }
  for (const root of [result.profileDir, result.gameDir]) {
    if (root === path.parse(root).root || !fs.statSync(root).isDirectory()) throw new Error('Выбери существующую папку профиля и игры.');
    if (isInsideOrEqual(result.backupDir, root) || isInsideOrEqual(root, result.backupDir)) throw new Error('Резервная копия должна находиться вне папок профиля и игры.');
  }
  if (isInsideOrEqual(result.profileDir, result.gameDir) || isInsideOrEqual(result.gameDir, result.profileDir)) throw new Error('Папки профиля и игры не должны пересекаться.');
  return result;
}
function workspaceAt(profile: string) {
  const value = z.object({ directory: z.string().refine(path.isAbsolute) }).parse(json(path.join(profile, 'claude-workspace.json')));
  const workspace = path.resolve(value.directory); noLinks(workspace);
  return workspace;
}
function checkWorkspacePaths(workspace: string, o: MigrationOptions) {
  for (const other of [o.profileDir, o.gameDir, o.backupDir])
    if (isInsideOrEqual(workspace, other) || isInsideOrEqual(other, workspace)) throw new Error('Папка Claude, профиль, игра и резервная копия должны быть отдельными папками.');
}
const worldFiles = ['agentcraft-workspace.json', 'agentcraft-anchors.json', 'agentcraft-world.json', 'agentcraft-site.json', 'agentcraft-sites.json', 'agentcraft-hq-plan.dat'];
const gameFiles = ['config/agentcraft-client.json', 'config/agentcraft-studio.json', 'config/agentcraft-skins', 'config/agentcraft', 'agentcraft/console-history.txt'];
// Published six-character cast palette, also recognized when migrating from a standalone package.
const historicalColors: Record<string, string> = { juniper: '#8E66BF', kit: '#3C74B3', rowan: '#802F6E', tove: '#98B2E2' };
interface Root { path: string; tree: boolean; }
function roots(o: MigrationOptions, workspace: string): Root[] {
  const result: Root[] = [{ path: o.profileDir, tree: true }, { path: workspace, tree: true }];
  if (!isInsideOrEqual(o.bindingFile, o.profileDir) && !isInsideOrEqual(o.bindingFile, workspace)) result.push({ path: o.bindingFile, tree: false });
  for (const ref of gameFiles) result.push({ path: path.join(o.gameDir, ref), tree: ['config/agentcraft-skins', 'config/agentcraft'].includes(ref) });
  const saves = path.join(o.gameDir, 'saves'); noLinks(saves);
  if (fs.existsSync(saves)) for (const name of fs.readdirSync(saves)) {
    const save = path.join(saves, name); noLinks(save);
    if (fs.statSync(save).isDirectory()) for (const file of worldFiles) result.push({ path: path.join(save, file), tree: false });
  }
  return result;
}
const FileRecord = z.object({ ref: z.string(), blob: z.string().regex(/^files\/[0-9]+$/), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const Manifest = z.object({ version: z.literal(1), profile: z.string(), game: z.string(), binding: z.string(), workspace: z.string(),
  roots: z.array(z.object({ path: z.string(), tree: z.boolean(), exists: z.boolean(), dirs: z.array(z.string()), files: z.array(FileRecord) }).strict()) }).strict();
type Backup = z.infer<typeof Manifest>;
function child(root: string, ref: string) {
  if (ref && (ref.includes('\\') || ref.includes(':') || ref.split('/').some(p => !p || p === '.' || p === '..'))) throw new Error('Некорректный путь в резервной копии.');
  const file = ref ? path.join(root, ref) : root;
  if (!isInsideOrEqual(file, root)) throw new Error('Путь выходит за границы резервной копии.');
  noLinks(file); return file;
}
function inventory(root: Root, workspace: string) {
  noLinks(root.path);
  const files: string[] = [], dirs: string[] = [];
  function walk(file: string, ref: string) {
    noLinks(file); const stat = fs.lstatSync(file);
    if (stat.isDirectory()) {
      if (!root.tree) throw new Error('Ожидался обычный файл: ' + file);
      dirs.push(ref);
      for (const name of fs.readdirSync(file).sort()) {
        if (root.path === workspace && !ref && name === 'conversation-lock.json') continue; // Our exclusive maintenance lease.
        walk(path.join(file, name), ref ? ref + '/' + name : name);
      }
    } else if (stat.isFile()) files.push(ref);
    else throw new Error('Необычный файл не поддерживается: ' + file);
  }
  if (fs.existsSync(root.path)) walk(root.path, '');
  return { exists: fs.existsSync(root.path), files, dirs };
}
function snapshot(o: MigrationOptions, workspace: string, list: Root[], destination: string): Backup {
  noLinks(destination); if (fs.existsSync(destination)) throw new Error('Папка резервной копии уже существует. Выбери новую.');
  fs.mkdirSync(path.join(destination, 'files'), { recursive: true });
  const manifest: Backup = { version: 1, profile: o.profileDir, game: o.gameDir, binding: o.bindingFile, workspace, roots: [] };
  let index = 0;
  for (const root of list) {
    const before = inventory(root, workspace), files: z.infer<typeof FileRecord>[] = [];
    for (const ref of before.files) {
      const bytes = fs.readFileSync(child(root.path, ref)), blob = `files/${index++}`;
      writeFileAtomic(child(destination, blob), bytes);
      files.push({ ref, blob, sha256: sha(bytes) });
    }
    manifest.roots.push({ ...root, exists: before.exists, dirs: before.dirs, files });
  }
  assertSnapshotCurrent(manifest);
  writeJsonAtomic(path.join(destination, 'manifest.json'), manifest); return manifest;
}
function assertSnapshotCurrent(manifest: Backup) {
  // Detect any concurrent writer before publishing a complete backup or changing source files.
  for (const root of manifest.roots) {
    const now = inventory(root, manifest.workspace);
    if (JSON.stringify(now) !== JSON.stringify({ exists: root.exists, files: root.files.map(f => f.ref), dirs: root.dirs }) ||
      root.files.some(f => sha(fs.readFileSync(child(root.path, f.ref))) !== f.sha256)) throw new Error('Файлы изменились во время копирования. Закрой их владельцев и повтори перенос.');
  }
}
function verifyBackup(o: MigrationOptions): Backup {
  const m = Manifest.parse(json(path.join(o.backupDir, 'manifest.json')));
  if (m.profile !== o.profileDir || m.game !== o.gameDir || m.binding !== o.bindingFile) throw new Error('Резервная копия относится к другим путям. Укажи исходные папки профиля, игры и привязки.');
  noLinks(m.workspace); checkWorkspacePaths(m.workspace, o);
  // Root paths are limited to the selected profile, the saved workspace pointer, one binding and AgentCraft game files.
  const allowed = roots(o, m.workspace);
  for (const r of m.roots) {
    const gameRef = path.relative(o.gameDir, r.path).split(path.sep);
    const savedWorldFile = !r.tree && gameRef.length === 3 && gameRef[0] === 'saves' && gameRef[1] !== '..' && worldFiles.includes(gameRef[2]!);
    if (!allowed.some(a => a.path === r.path && a.tree === r.tree) && !savedWorldFile) throw new Error('Неизвестный путь в резервной копии: ' + r.path);
    for (const ref of r.dirs) child(r.path, ref);
    for (const f of r.files) {
      if (!r.tree && f.ref !== '') throw new Error('Некорректная копия файла.');
      child(r.path, f.ref);
      if (sha(fs.readFileSync(child(o.backupDir, f.blob))) !== f.sha256) throw new Error('Контрольная сумма резервной копии не совпадает. Восстановление отменено.');
    }
  }
  const p = m.roots.find(r => r.path === o.profileDir);
  const pointer = p?.files.find(f => f.ref === 'claude-workspace.json');
  if (!pointer || path.resolve(json(child(o.backupDir, pointer.blob)).directory) !== m.workspace) throw new Error('Папка Claude не соответствует сохранённому указателю.');
  if (new Set(m.roots.map(r => r.path)).size !== m.roots.length || !m.roots.some(r => r.path === m.workspace)) throw new Error('Некорректный набор папок резервной копии.');
  return m;
}
function restoreFiles(m: Backup, backup: string) {
  for (const root of m.roots) {
    const current = inventory(root, m.workspace);
    // Each target was resolved and checked under its explicit root; no recursive shell deletion.
    for (const ref of current.files) if (!root.files.some(f => f.ref === ref)) fs.unlinkSync(child(root.path, ref));
    for (const ref of [...current.dirs].reverse()) if (!root.dirs.includes(ref)) fs.rmdirSync(child(root.path, ref));
    for (const ref of root.dirs) fs.mkdirSync(child(root.path, ref), { recursive: true });
    for (const f of root.files) writeFileAtomic(child(root.path, f.ref), fs.readFileSync(child(backup, f.blob)));
  }
}
function lock(profile: string, restore = false) {
  const file = maintenanceFile(profile); noLinks(file);
  if (fs.existsSync(file) && restore) {
    const record = json(file);
    if (!Number.isInteger(record.pid) || alive(record.pid)) throw new Error('Другой перенос ещё выполняется.');
    fs.unlinkSync(file);
  }
  try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid }), { flag: 'wx' }); }
  catch { throw new Error('Профиль занят переносом. После прерванного переноса используй restore с резервной копией.'); }
  return () => fs.unlinkSync(file);
}

/** Offline, explicit migration. Stable IDs preserve every task, feed and furniture reference. */
export async function migrateTeam(input: MigrationOptions, checks: MigrationChecks = defaults) {
  const o = safeOptions(input);
  const release = lock(o.profileDir); let lease: ReturnType<typeof acquireConversation> | undefined; let recoverable = true;
  try {
    offline(o.profileDir);
    const stateFile = path.join(o.profileDir, 'state.json'), state = json(stateFile);
    const inputs = new Map([[stateFile, sha(fs.readFileSync(stateFile))]]);
    if (state.backend?.teamMigration?.version === 1 && fs.existsSync(path.join(o.profileDir, 'team.json'))) {
      new TeamRegistry(o.profileDir); // Validate the activated registry without rewriting anything.
      return { migrated: false, alreadyMigrated: true, backup: state.backend.teamMigration.backup };
    }
    if (fs.existsSync(path.join(o.profileDir, 'team.json'))) throw new Error('В профиле уже есть команда. Автоматическое объединение не поддерживается.');
    const studio = stopped(state);
    if (!Array.isArray(studio.items)) throw new Error('Некорректная очередь.');
    const selected = ['marlow', 'wren'];
    if (studio.profiles.length !== 2 || !selected.every(id => studio.profiles.filter((p: any) => p.id === id).length === 1)) throw new Error('Нестандартный состав: требуется отдельное решение пользователя, данные не изменены.');
    if (!selected.every(id => state.agents.filter((a: any) => a.id === id).length === 1)) throw new Error('В состоянии отсутствуют или повторяются прежние агенты. Исправь исходный профиль перед переносом.');
    const owners = [...(studio.personalPaused ?? []), ...Object.keys(studio.suspended ?? {}),
      ...state.tasks.map((t: any) => t.assignee).filter(Boolean), ...(state.replyAgentId ? [state.replyAgentId] : [])];
    const unsupported = owners.find(id => !selected.includes(id));
    if (unsupported) throw new Error(`История или пауза ссылается на ${unsupported}. Нужно решение пользователя; перенос не выполнен.`);
    for (const a of state.agents.filter((a: any) => !selected.includes(a.id))) {
      const candidates = [loadCast(input.projectRoot).cast, loadCast(undefined).cast,
        loadCast(undefined).cast.map(c => ({ ...c, color: historicalColors[c.id] ?? c.color }))].flat().filter(c => c.id === a.id);
      if (a.active || a.paused || a.taskId || a.skin !== a.id || !candidates.some(c => c.name === a.name && c.color === a.color) ||
        state.tasks.some((t: any) => t.assignee === a.id) || state.sessions?.[a.id] ||
        ['agents', 'memory/agents'].some(dir => inventory({ path: path.join(o.profileDir, dir, a.id), tree: true }, '').files.length > 0))
        throw new Error(`У ${a.id} есть собственные настройки или назначения. Нужно решение пользователя; перенос не выполнен.`);
    }
    const preferences = path.join(o.gameDir, 'config/agentcraft-studio.json');
    let looks: Record<string, { slim?: boolean }> = {};
    if (fs.existsSync(preferences)) {
      const prefs = json(preferences);
      looks = prefs.looks ?? {}; inputs.set(preferences, sha(fs.readFileSync(preferences)));
      for (const id of state.agents.map((a: any) => a.id).filter((id: string) => !selected.includes(id))) {
        const personal = Object.values(prefs.worlds ?? {}).some((places: any) => Object.keys(places).some(k => k.startsWith(id + '/'))) ||
          Object.values(prefs.restPlaces ?? {}).some((places: any) => places[id]?.length) ||
          Object.values(prefs.looks?.[id] ?? {}).some(value => value !== false && value !== '' && value !== null);
        if (personal) throw new Error(`У ${id} есть личные игровые места или скин. Нужно решение пользователя; перенос не выполнен.`);
      }
    }
    const workspace = workspaceAt(o.profileDir); checkWorkspacePaths(workspace, o);
    workspaceInstructions(workspace);
    const chat = readBinding(o.bindingFile); if (!chat) throw new Error('Не найдена прежняя привязка Codex.');
    const shared = conversation(workspace); if (!shared) throw new Error('Не найден общий разговор Claude; новая сессия не создаётся.');
    if (studio.dialog?.sessionId && studio.dialog.sessionId !== shared.sessionId) throw new Error('Сессия ожидающего ответа не совпадает с общим разговором Claude.');
    if (conversationLease(workspace)) throw new Error('Разговор Claude занят или передан в терминал/Code. Верни его в игру перед переносом.');
    for (const file of [o.bindingFile, path.join(o.profileDir, 'claude-workspace.json'), path.join(workspace, 'conversation.json')]) inputs.set(file, sha(fs.readFileSync(file)));
    checks.game(); await checks.codex(chat); await checks.claude(workspace);
    lease = acquireConversation(workspace, 'game');
    const personaFile = path.join(o.profileDir, 'personas.json');
    if (fs.existsSync(personaFile)) PersonasFile.parse(json(personaFile));
    const team = { version: 1, revision: 1, assignment: { autoSelect: false }, agents: selected.map(id => {
      const p = studio.profiles.find((p: any) => p.id === id), old = state.agents.find((a: any) => a.id === id);
      if (!old) throw new Error('В состоянии нет агента ' + id);
      return TeamAgent.parse({ id, name: p.name, provider: id === 'marlow' ? 'codex' : 'claude', roles: id === 'marlow' ? ['developer'] : ['planner', 'reviewer'],
        enabled: p.enabled, visible: p.visible, archived: false, appearance: { skin: p.skin, color: p.color, slim: looks[id]?.slim ?? old.slim ?? false },
        personaRef: 'personas.json', memoryDir: 'memory', instructionsDir: `agents/${id}/instructions`, connectionRef: `connections/${id}-migration.json` });
    }) };
    const records = [Connection.parse({ ...chat, version: 1, agentId: 'marlow', provider: 'codex', transport: 'codex-desktop' }),
      Connection.parse({ version: 1, agentId: 'wren', provider: 'claude', transport: 'claude-code', workspace, sessionId: shared.sessionId,
        ...(studio.claudePath ? { executable: studio.claudePath } : {}) })];
    const writes = records.map(c => ({ file: path.join(o.profileDir, `connections/${c.agentId}-migration.json`), data: c }));
    for (const w of writes) if (fs.existsSync(w.file)) throw new Error('Целевой файл уже существует: ' + w.file);
    const backup = snapshot(o, workspace, roots(o, workspace), o.backupDir);
    offline(o.profileDir); checks.game(); await checks.codex(chat);
    assertSnapshotCurrent(backup);
    for (const [file, hash] of inputs) if (sha(fs.readFileSync(file)) !== hash) throw new Error('Исходные настройки изменились после проверки. Повтори перенос с новой резервной копией.');
    state.backend.teamMigration = { version: 1, kind: 'legacy-pair', backup: o.backupDir };
    studio.mode = 'paused'; studio.profiles = selected.map(id => studio.profiles.find((p: any) => p.id === id));
    studio.personalPaused = [...new Set([...(studio.personalPaused ?? []), ...state.agents.filter((a: any) => selected.includes(a.id) && a.paused).map((a: any) => a.id),
      ...(studio.dialog?.pending ? ['wren'] : [])])];
    state.agents = state.agents.filter((a: any) => selected.includes(a.id));
    try {
      for (const w of writes) writeJsonAtomic(w.file, w.data);
      writeJsonAtomic(stateFile, state);
      writeJsonAtomic(path.join(o.profileDir, 'team.json'), team); // Activation point, after the complete backup and state.
    } catch (e) { recoverable = false; restoreFiles(backup, o.backupDir); recoverable = true; throw e; }
    return { migrated: true, agents: selected, backup: o.backupDir, files: backup.roots.reduce((n, r) => n + r.files.length, 0), queue: 'paused' };
  } finally { lease?.release(); if (recoverable) release(); }
}

export async function restoreTeam(input: MigrationOptions, checks: MigrationChecks = defaults) {
  const o = safeOptions(input), backup = verifyBackup(o);
  const release = lock(o.profileDir, true); let lease: ReturnType<typeof acquireConversation> | undefined; let started = false, success = false;
  try {
    offline(o.profileDir); stopped(json(path.join(o.profileDir, 'state.json'))); checks.game();
    if (conversationLease(backup.workspace)) throw new Error('Разговор Claude занят. Закрой его перед восстановлением.');
    let binding = readBinding(o.bindingFile); if (!binding) throw new Error('Не удалось проверить разговор Codex.');
    if (fs.existsSync(path.join(o.profileDir, 'team.json'))) {
      const current = new AgentConnections(o.profileDir, new TeamRegistry(o.profileDir)).read('marlow');
      if (current?.transport !== 'codex-desktop' || current.threadId !== binding.threadId) throw new Error('Привязка Codex изменилась на другой разговор. Проверь оба разговора перед откатом.');
      binding = current; // A refreshed per-agent pipe supersedes the untouched legacy file for this readiness check.
    }
    await checks.codex(binding); await checks.claude(backup.workspace);
    lease = acquireConversation(backup.workspace, 'game');
    const recovery = path.join(o.backupDir, 'before-restore-' + randomUUID());
    snapshot(o, backup.workspace, backup.roots, recovery);
    started = true; restoreFiles(backup, o.backupDir); success = true;
    return { restored: true, recovery, files: backup.roots.reduce((n, r) => n + r.files.length, 0) };
  } finally { lease?.release(); if (success || !started) release(); }
}
