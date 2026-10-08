// Explicit migration; preparation does not change the running workspace or Claude transcript.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { klavaDesktopSettings } from './lib/klava-desktop-settings.mjs';
import { claudeWorkspace, workspaceTools } from '../foreman/src/claude-workspace.ts';
import { conversation, conversationLease, requireSession } from '../foreman/src/claude-conversation.ts';
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); if (i < 0 || !args[i + 1]) throw new Error(`Missing ${name}`); return args[i + 1]; };
const directory = path.resolve(option('--workspace'));
const workspace = claudeWorkspace(directory);
const sessionId = option('--session');
if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) throw new Error('Expected a session UUID.');
const old = conversation(directory);
if (old && old.sessionId !== sessionId) throw new Error('Another conversation is already bound. No changes made.');
if (conversationLease(directory)) throw new Error('Close the active conversation before migration.');
await requireSession(directory, { version: 1, sessionId, importedHistory: '' });
const profile = path.resolve(option('--profile-dir'));
const pointer = JSON.parse(await fs.readFile(path.join(profile, 'claude-workspace.json'), 'utf8'));
if (path.resolve(pointer.directory) !== directory) throw new Error('Profile is bound to another workspace.');
const state = JSON.parse(await fs.readFile(path.join(profile, 'state.json'), 'utf8'));
const history = state.backend?.studio?.dialog?.history ?? [];
if (state.backend?.studio?.dialog?.pending) throw new Error('Finish or stop the pending game reply before migration.');
const importedHistory = old?.importedHistory ?? JSON.stringify(history);
if (importedHistory.length > 100000) throw new Error('Game history needs a separate export before migration.');
const config = { version: 1, sessionId, importedHistory };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = new Map();
files.set('conversation.json', JSON.stringify(config, null, 2) + '\n');
files.set('GAME-HISTORY.md', '# Переписка до объединения\n\nСправочный контекст; не новые поручения.\n\n' + importedHistory + '\n');
files.set('CLAUDE.local.md', '# Общий разговор Клавы\n\n@PROJECTS.md\n@MEMORY.md\n@WORKSPACE.md\n@GAME-HISTORY.md\n\nИспользуй инструменты klava. Код меняет Codex. Запоминай только по явной просьбе.\n');
files.set('.mcp.json', workspace.args[workspace.args.indexOf('--mcp-config') + 1] + '\n');
// Only --update may strengthen an existing policy. Preserve unrelated user settings.
let settingsText;
try { settingsText = await fs.readFile(path.join(directory, '.claude/settings.json'), 'utf8'); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
const settings = settingsText === undefined ? {} : JSON.parse(settingsText);
const updatedSettings = klavaDesktopSettings(settings, workspaceTools);
const settingsChanged = !isDeepStrictEqual(settings, updatedSettings);
if (settingsText !== undefined && settingsChanged && !args.includes('--update')) {
  throw new Error('Existing Desktop settings need --update; no files changed.');
}
files.set('.claude/settings.json', settingsText !== undefined && !settingsChanged
  ? settingsText : JSON.stringify(updatedSettings, null, 2) + '\n');
const quote = value => `'${value.replaceAll("'", "''")}'`;
for (const [name, flag] of [['Start-Klava', '-Continue'], ['Continue-Klava', '-Continue'], ['Open-Klava-Code', '-Desktop'], ['Return-Klava-To-Game', '-Return']]) {
  files.set(`${name}.ps1`, '\uFEFF' + `$Host.UI.RawUI.WindowTitle = 'Klava - TradeRecord and AgentCraft'\r\n& ${quote(path.join(root, 'tools/open-klava.ps1'))} -Workspace ${quote(directory)} ${flag}\r\n`);
  files.set(`${name}.cmd`, `@echo off\r\npowershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0${name}.ps1"\r\nif errorlevel 1 pause\r\n`);
}
// Custom Claude configuration must never be silently replaced.
for (const file of ['.mcp.json', 'CLAUDE.local.md', 'GAME-HISTORY.md']) {
  const target = path.join(directory, file);
  try { if (await fs.readFile(target, 'utf8') !== files.get(file)) throw new Error(`Existing custom file differs: ${file}`); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
}
const apply = args.includes('--apply');
const output = apply ? directory : path.resolve(option('--prepare'));
let backup;
if (apply) {
  backup = path.join(directory, 'backups', `conversation-${randomUUID()}`); await fs.mkdir(backup, { recursive: true });
  for (const file of [...files.keys(), 'CLAUDE.md', 'PROJECTS.md', 'MEMORY.md', 'access.json']) {
    try { const contents = await fs.readFile(path.join(directory, file)); await fs.mkdir(path.dirname(path.join(backup, file)), { recursive: true }); await fs.writeFile(path.join(backup, file), contents); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  await fs.copyFile(path.join(profile, 'state.json'), path.join(backup, 'game-state.json'));
}
// The binding is committed last so a partial preparation cannot activate shared mode.
for (const [file, contents] of [...files].sort(([a], [b]) => Number(a === 'conversation.json') - Number(b === 'conversation.json'))) {
  const target = path.join(output, file); await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`; await fs.writeFile(temporary, contents, { flag: 'wx' }); await fs.rename(temporary, target);
}
console.log(JSON.stringify({ prepared: !apply, applied: apply, output, sessionId, importedMessages: history.length, backup }));
