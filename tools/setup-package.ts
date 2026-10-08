import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { z } from '../foreman/node_modules/zod/index.js';
import { Foreman } from '../foreman/src/foreman.js';
import { loadConfig } from '../foreman/src/config.js';
import { silentLogger } from '../foreman/src/context.js';
import { AgentConnections } from '../foreman/src/agent-connections.js';
import { AgentRuntime } from '../foreman/src/agent-runtime.js';
import { teamCapabilities } from '../foreman/src/team-capabilities.js';
import type { TeamRegistry } from '../foreman/src/team.js';
import { requireSession, conversation } from '../foreman/src/claude-conversation.js';
import { WorkspaceConfig } from '../foreman/src/claude-workspace.js';
// @ts-expect-error Plain-JS transaction library also runs directly in Node's installer tests.
import { installPackage, rollbackPackage, recoverPackage, withOfflineProfile, noLinks, inside } from './lib/portable-install.mjs';

const Project = z.object({ path: z.string().refine(path.isAbsolute), github: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).optional() }).strict();
const Agent = z.object({ name: z.string().trim().min(1).max(28), provider: z.enum(['codex', 'claude']), roles: z.array(z.enum(['planner', 'developer', 'reviewer'])).min(1),
  connection: z.record(z.string(), z.unknown()).optional() }).strict();
export const SetupPlan = z.object({ projects: z.array(Project).max(8), agents: z.array(Agent).max(100) }).strict();
type Plan = z.infer<typeof SetupPlan>;
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Fresh profile only. Never starts the server, adapters, models or a Git mutation. */
export async function configureFresh(target: string, raw: unknown, probe?: () => Promise<unknown[]>): Promise<ReturnType<TeamRegistry['snapshot']>> {
  const plan = SetupPlan.parse(raw);
  return withOfflineProfile(target, probe, async (checkStopped: () => Promise<void>) => {
    await fs.access(path.join(target, 'installation.json'));
    const home = path.join(target, 'data'), profile = path.join(home, 'portable'); await noLinks(profile);
    if (await fs.stat(profile).catch(e => { if (e.code === 'ENOENT') return null; throw e; })) throw Error('Existing profile preserved. Use the in-game desk / Профиль уже существует: настрой его в пульте.');
    for (const a of plan.agents) {
      const c = teamCapabilities.find(c => c.provider === a.provider)!;
      if (a.roles.some(r => !(c.roles as readonly string[]).includes(r))) throw Error('Unsupported provider/role / Недоступная роль для провайдера.');
    }
    const cfg = loadConfig(['--home', home, '--profile', 'portable', '--backend', 'observer', '--no-notify'], {});
    // Publish a complete profile at once; a failed project/binding validation leaves no partial live team.
    const stage = path.join(target, '.installer-drafts', randomUUID()); await noLinks(stage);
    cfg.home = stage; cfg.dataDir = path.join(stage, 'portable'); cfg.projectRoot = target;
    const fm = new Foreman({ config: cfg, logger: silentLogger });
    try {
      const projects = [];
      for (const p of plan.projects) { const r = await fm.repos.add(p.path); projects.push({ id: `project_${projects.length + 1}`, name: r.name.slice(0, 100), path: r.path, ...(p.github ? { github: p.github } : {}) }); }
      const store = new AgentConnections(cfg.dataDir, fm.team!);
      for (const a of plan.agents) {
        fm.teamAction('team.create', { revision: fm.team!.snapshot().revision, agent: { name: a.name, provider: a.provider, roles: a.roles, enabled: false, visible: true,
          appearance: { skin: 'marlow', color: '#DFC185', slim: false } } });
        const id = fm.team!.snapshot().agents.at(-1)!.id;
        if (a.connection) store.bind({ id, revision: fm.team!.snapshot().revision, connection: a.connection }, () => {});
      }
      await fs.writeFile(path.join(cfg.dataDir, 'setup-projects.json'), JSON.stringify({ projects }, null, 2) + '\n', { flag: 'wx' });
      const result = fm.team!.snapshot(); await fm.close();
      await checkStopped(); await fs.mkdir(home, { recursive: true }); await noLinks(profile);
      // The directory was required to be absent above; do not replace a concurrently created profile.
      if (await fs.stat(profile).catch(() => null)) throw Error('Profile appeared during setup; staged data preserved');
      await fs.rename(cfg.dataDir, profile); return result;
    } finally { await fm.close(); }
  });
}
/** Prepare documents only. The user creates/authenticates the native Claude session themselves. */
export async function prepareClaude(target: string, id: string, probe?: () => Promise<unknown[]>) {
  return withOfflineProfile(target, probe, async () => {
    const profile = path.join(target, 'data/portable');
    const team = JSON.parse(await fs.readFile(path.join(profile, 'team.json'), 'utf8'));
    if (!team.agents.some((a: any) => a.id === id && a.provider === 'claude' && !a.archived)) throw Error('Select a Claude agent');
    const { projects } = JSON.parse(await fs.readFile(path.join(profile, 'setup-projects.json'), 'utf8'));
    if (!projects.length) throw Error('Select at least one project first / Сначала выбери хотя бы один проект.');
    const access = WorkspaceConfig.parse({ version: 1, repositories: projects });
    const dir = path.join(target, 'workspaces', id); if (!inside(target, dir)) throw Error('Invalid agent ID'); await noLinks(dir);
    await fs.mkdir(path.dirname(dir), { recursive: true }); await fs.mkdir(dir, { recursive: false });
    for (const name of ['CLAUDE.md', 'PROJECTS.md']) await fs.copyFile(path.join(target, 'workspace-template', name), path.join(dir, name), fs.constants.COPYFILE_EXCL);
    await fs.copyFile(path.join(target, 'workspace-template/NOTES.example.md'), path.join(dir, 'MEMORY.md'), fs.constants.COPYFILE_EXCL);
    await fs.writeFile(path.join(dir, 'access.json'), JSON.stringify(access, null, 2) + '\n', { flag: 'wx' });
    const sessionId = randomUUID();
    await fs.writeFile(path.join(dir, 'conversation.json'), JSON.stringify({ version: 1, sessionId }) + '\n', { flag: 'wx' });
    // No native history, auth files or model invocation. The user runs this interactive command explicitly.
    await fs.writeFile(path.join(dir, 'Start-Session.ps1'), `Set-Location -LiteralPath $PSScriptRoot\r\n& claude --session-id '${sessionId}'\r\n`, { flag: 'wx' });
    await fs.writeFile(path.join(dir, 'Start-Session.cmd'), '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Session.ps1"\r\npause\r\n', { flag: 'wx' });
    return { workspace: dir, sessionId };
  });
}
export async function checkAgent(target: string, id: string, probe?: () => Promise<unknown[]>) {
  return withOfflineProfile(target, probe, async () => {
    await fs.access(path.join(target, 'installation.json')); await fs.access(path.join(target, 'data/portable/team.json'));
    const cfg = loadConfig(['--home', path.join(target, 'data'), '--profile', 'portable', '--backend', 'observer', '--no-notify'], {}); cfg.projectRoot = target;
    const fm = new Foreman({ config: cfg, logger: silentLogger }), runtime = new AgentRuntime(fm);
    try {
      const c = runtime.connections.read(id);
      if (c?.provider === 'claude') await requireSession(c.workspace, conversation(c.workspace)!);
      return await runtime.check(id);
    } finally { await runtime.stop(); await fm.close(); }
  });
}

export async function main() {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  let lang = 'ru'; const tr = (ru: string, en: string) => lang === 'ru' ? ru : en;
  const ask = async (ru: string, en: string) => (await readline.question(tr(ru, en) + '\n> ')).trim();
  try {
    lang = (await readline.question('Language / Язык: 1 Русский, 2 English\n> ')).trim() === '2' ? 'en' : 'ru';
    console.log(tr('AgentCraft: установка, обновление и откат. Игра и мост должны быть закрыты.', 'AgentCraft: install, update and rollback. Close Minecraft and stop the bridge.'));
    const action = await ask('1 Установить / обновить, 2 Откатить, 3 Восстановить прерванную установку, 4 Проверить агента', '1 Install / update, 2 Roll back, 3 Recover interrupted setup, 4 Check an agent');
    if (!['1', '2', '3', '4'].includes(action)) return;
    const chosen = await ask('Полный путь к папке установки (отдельно от распакованного пакета и Minecraft):', 'Absolute installation directory (separate from extracted package and Minecraft):');
    if (!path.isAbsolute(chosen)) throw Error('Absolute path required / Нужен полный путь'); const target = path.resolve(chosen);
    if (action === '2' || action === '3') {
      if (await ask('Восстановить файлы программы и мода? Пользовательские настройки сохраняются. Введи YES.', 'Restore program and mod files? Current user settings are retained. Type YES.') !== 'YES') return;
      console.log(JSON.stringify(await (action === '2' ? rollbackPackage(target) : recoverPackage(target)))); return;
    }
    if (action === '4') { console.log(JSON.stringify(await checkAgent(target, await ask('ID агента:', 'Agent ID:')), null, 2)); return; }
    if (action !== '1') return;
    let installed: any; try { installed = JSON.parse(await fs.readFile(path.join(target, 'installation.json'), 'utf8')); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    const game = installed?.game ?? await ask('Папка игры из настроек профиля Fabric:', 'Game directory from your Fabric launcher profile:');
    const fabricVersion = await ask('Полный путь к JSON версии Fabric (versions/<версия>/<версия>.json):', 'Absolute Fabric version JSON (versions/<version>/<version>.json):');
    const plan: Plan = { projects: [], agents: [] };
    const needsProfile = !await fs.stat(path.join(target, 'data/portable/state.json')).catch(() => null);
    if (needsProfile) {
      while (true) {
        const repo = await ask('Корневая папка локального Git-проекта (Enter — закончить):', 'Local Git repository root (Enter to finish):'); if (!repo) break;
        const github = await ask('GitHub owner/repo (необязательно, Enter — только локально):', 'GitHub owner/repo (optional, Enter for local only):');
        plan.projects.push(Project.parse({ path: repo, ...(github ? { github } : {}) }));
      }
      while (true) {
        const name = await ask('Имя нового агента (Enter — закончить; пустую команду можно настроить в игре):', 'New agent name (Enter to finish; an empty team can be configured in game):'); if (!name) break;
        const type = Number(await ask('Подключение: 1 Codex приложение, 2 Codex CLI, 3 Claude Code', 'Connection: 1 Codex desktop, 2 Codex CLI, 3 Claude Code')) - 1;
        const capability = teamCapabilities[type]; if (!capability) throw Error('Choose 1, 2 or 3');
        console.log(tr(capability.hint, capability.provider === 'claude' ? 'Developer/reviewer supported; arbitrary-team planner tools are not connected.' : 'Planner/developer/reviewer supported; planning draft creation also needs a scoped permit.'));
        const roles = (await ask('Роли через запятую: planner, developer, reviewer (только доступные выше):', 'Roles separated by commas: planner, developer, reviewer (supported above only):')).split(',').map(s => s.trim());
        const a = Agent.parse({ name, provider: capability.provider, roles });
        if (roles.some(r => !(capability.roles as readonly string[]).includes(r))) throw Error('Unsupported role / Недоступная роль');
        if (await ask('Подключить существующий разговор сейчас? y / Enter — позже в игре', 'Bind an existing conversation now? y / Enter to configure in game later') === 'y') {
          if (capability.transport === 'codex-desktop') a.connection = { provider: 'codex', transport: 'codex-desktop', hostId: 'local', title: name,
            threadId: await ask('ID отдельного чата Codex:', 'Dedicated Codex thread ID:'), pipePath: await ask('pipePath этого приложения Codex:', 'Codex application pipePath:') };
          else {
            const workspace = await ask('Полный путь к проекту CLI или настроенному пространству Claude:', 'Absolute CLI project or prepared Claude workspace directory:');
            const executable = await ask('Полный путь к исполняемому файлу CLI (для Claude можно Enter):', 'Absolute native CLI executable (Claude can use Enter for discovery):');
            if (capability.transport === 'codex-cli') a.connection = { provider: 'codex', transport: 'codex-cli', workspace, executable, sessionId: randomUUID(),
              sandbox: await ask('Права: read-only либо workspace-write для разработки:', 'Sandbox: read-only or workspace-write for development:') };
            else a.connection = { provider: 'claude', transport: 'claude-code', workspace,
              sessionId: await ask('sessionId из conversation.json:', 'sessionId from conversation.json:'), ...(executable ? { executable } : {}) };
          }
        }
        plan.agents.push(a);
      }
    }
    SetupPlan.parse(plan);
    console.log(tr(`Установка: ${target}\nИгра: ${game}\n${installed ? 'Обновление сохраняет существующий профиль.' : `Проектов: ${plan.projects.length}; агентов: ${plan.agents.length}. Новые агенты выключены.`}`, `Installation: ${target}\nGame: ${game}\n${installed ? 'Update preserves the existing profile.' : `Projects: ${plan.projects.length}; agents: ${plan.agents.length}. New agents are disabled.`}`));
    if (await ask('Начать? Введи YES.', 'Proceed? Type YES.') !== 'YES') return;
    const result = await installPackage({ source: packageRoot, target, game, fabricVersion }); console.log(JSON.stringify(result, null, 2));
    if (needsProfile) {
      const team = await configureFresh(target, plan);
      for (const a of team.agents) {
        console.log(`${a.name}: ${a.id}`);
        if (a.provider === 'claude' && !a.connectionRef && plan.projects.length && await ask('Подготовить отдельное пространство Claude? y / Enter', 'Prepare a separate Claude workspace? y / Enter') === 'y') {
          await fs.mkdir(path.join(target, 'workspaces'), { recursive: true });
          const workspace = await prepareClaude(target, a.id); console.log(JSON.stringify(workspace, null, 2));
          console.log(tr('Выполни claude auth login самостоятельно. Запусти Start-Session.cmd в этой папке, отправь сообщение и закрой сессию. Затем подключи это пространство в пульте.', 'Sign in with claude auth login yourself. Run Start-Session.cmd in this folder, send a message, then close that session. Bind this workspace from the in-game desk.'));
        }
        if (a.connectionRef && await ask('Проверить подключение без запуска задачи? y / Enter', 'Check the connection without starting a task? y / Enter') === 'y') {
          try { console.log(JSON.stringify(await checkAgent(target, a.id), null, 2)); } catch (e: any) { console.log(tr('Подключение не подтверждено: ', 'Connection not confirmed: ') + e.message); }
        }
      }
    }
    console.log(tr('Готово. Запусти Start-Bridge.cmd из папки установки, затем Minecraft 26.3 / Fabric / Java 25. Открой Пульт → Команда. Инструкция: README.ru.txt. Логины и токены не копировались.', 'Ready. Run Start-Bridge.cmd in the installation folder, then Minecraft 26.3 / Fabric / Java 25. Open Command desk → Team. Read README.en.txt. No logins or tokens were copied.'));
  } finally { readline.close(); }
}
