import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
const exec = promisify(execFile); const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-conversation-setup-')); dirs.push(root);
  const workspace = path.join(root, 'workspace'), profile = path.join(root, 'profile'), claude = path.join(root, 'claude');
  await fs.mkdir(workspace); await fs.mkdir(profile);
  for (const name of ['CLAUDE.md', 'PROJECTS.md', 'MEMORY.md']) await fs.writeFile(path.join(workspace, name), `personal ${name}`);
  await fs.writeFile(path.join(workspace, 'access.json'), JSON.stringify({ version: 1, repositories: [{ id: 'repo', name: 'Repo', path: root, github: 'Owner/Repo' }] }));
  await fs.writeFile(path.join(profile, 'claude-workspace.json'), JSON.stringify({ directory: workspace }));
  await fs.writeFile(path.join(profile, 'state.json'), JSON.stringify({ backend: { studio: { dialog: { history: [{ role: 'user', text: 'old game' }] } } } }));
  const sessionId = randomUUID(); const project = path.join(claude, 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-')); await fs.mkdir(project, { recursive: true });
  const transcript = path.join(project, `${sessionId}.jsonl`);
  const content = JSON.stringify({ type: 'user', uuid: randomUUID(), parentUuid: null, sessionId, cwd: workspace, timestamp: new Date().toISOString(), message: { role: 'user', content: 'existing conversation' } }) + '\n';
  await fs.writeFile(transcript, content);
  const run = (...args: string[]) => exec(process.execPath, ['--import', pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href, path.resolve('../tools/configure-klava-conversation.mjs'), '--workspace', workspace, '--profile-dir', profile, '--session', sessionId, ...args], { env: { ...process.env, CLAUDE_CONFIG_DIR: claude }, windowsHide: true });
  return { root, workspace, transcript, content, run };
}
it('prepares without activation, then applies with a backup and preserves native history and personal files', async () => {
  const h = await fixture(); const prepared = path.join(h.root, 'prepared'); await h.run('--prepare', prepared);
  await expect(fs.stat(path.join(h.workspace, 'conversation.json'))).rejects.toThrow();
  expect(JSON.parse(await fs.readFile(path.join(prepared, 'conversation.json'), 'utf8')).importedHistory).toContain('old game');
  const applied = JSON.parse((await h.run('--apply')).stdout);
  expect(applied.applied).toBe(true); expect(await fs.readFile(path.join(applied.backup, 'CLAUDE.md'), 'utf8')).toBe('personal CLAUDE.md');
  expect(await fs.readFile(path.join(h.workspace, 'CLAUDE.md'), 'utf8')).toBe('personal CLAUDE.md');
  expect(await fs.readFile(h.transcript, 'utf8')).toBe(h.content);
  expect(await fs.readFile(path.join(h.workspace, 'Open-Klava-Code.ps1'), 'utf8')).toContain('-Desktop');
  const settings = JSON.parse(await fs.readFile(path.join(h.workspace, '.claude/settings.json'), 'utf8'));
  expect(settings.permissions.deny).toEqual(expect.arrayContaining([
    'PowerShell', 'Artifact*', 'mcp__terminal__*', 'mcp__Claude_Browser__*',
    'mcp__claude-in-chrome__*', 'mcp__scheduled-tasks__*', 'mcp__ccd_*',
  ]));
  expect(settings.permissions.allow).toEqual(expect.arrayContaining(['mcp__klava__projects', 'mcp__klava__planning_create', 'mcp__klava__skill_read']));
  expect(settings.permissions.deny).not.toContain('mcp__*');
});
it('requires explicit update, preserves custom settings and backs up exact old contents', async () => {
  const h = await fixture(); await h.run('--apply');
  const settingsFile = path.join(h.workspace, '.claude/settings.json');
  const custom = { model: 'sonnet', env: { EXAMPLE: 'kept' }, hooks: {},
    enabledMcpjsonServers: ['custom'], permissions: { defaultMode: 'default',
      additionalDirectories: ['D:/review'], allow: ['mcp__terminal__run_in_terminal'],
      deny: ['WebFetch'], ask: ['mcp__klava__remember'] } };
  const original = JSON.stringify(custom);
  await fs.writeFile(settingsFile, original);
  await expect(h.run('--apply')).rejects.toThrow('need --update');
  expect(await fs.readFile(settingsFile, 'utf8')).toBe(original);
  const prepared = path.join(h.root, 'prepared-update');
  await h.run('--update', '--prepare', prepared);
  expect(await fs.readFile(settingsFile, 'utf8')).toBe(original);
  const applied = JSON.parse((await h.run('--update', '--apply')).stdout);
  expect(await fs.readFile(path.join(applied.backup, '.claude/settings.json'), 'utf8')).toBe(original);
  const mergedText = await fs.readFile(settingsFile, 'utf8');
  const merged = JSON.parse(mergedText);
  expect(merged).toMatchObject({ model: custom.model, env: custom.env, hooks: custom.hooks,
    permissions: { defaultMode: 'default', additionalDirectories: ['D:/review'],
      ask: custom.permissions.ask, allow: expect.arrayContaining(custom.permissions.allow),
      deny: expect.arrayContaining(custom.permissions.deny) } });
  expect(merged.disableAllHooks).toBe(true);
  expect(merged.permissions.deny).toContain('mcp__terminal__*');
  expect(merged.permissions.allow).toContain('mcp__klava__planning_create');
  expect(merged.enabledMcpjsonServers).toEqual(['custom', 'klava']);
  // Reordered keys/whitespace are not an update; no rewrite is needed.
  const reordered = JSON.stringify(Object.fromEntries(Object.entries(merged).reverse()));
  await fs.writeFile(settingsFile, reordered);
  await h.run('--apply');
  expect(await fs.readFile(settingsFile, 'utf8')).toBe(reordered);
  expect(await fs.readFile(h.transcript, 'utf8')).toBe(h.content);
});
it.each(['null', '{broken', '{"permissions":[]}', '{"permissions":{"deny":"Bash"}}', '{"permissions":{"ask":[1]}}'])(
  'rejects malformed existing settings before backup or activation: %s', async contents => {
    const h = await fixture(); await fs.mkdir(path.join(h.workspace, '.claude'));
    const file = path.join(h.workspace, '.claude/settings.json'); await fs.writeFile(file, contents);
    await expect(h.run('--update', '--apply')).rejects.toThrow();
    expect(await fs.readFile(file, 'utf8')).toBe(contents);
    await expect(fs.stat(path.join(h.workspace, 'conversation.json'))).rejects.toThrow();
    await expect(fs.stat(path.join(h.workspace, 'backups'))).rejects.toThrow();
  });
it('update does not permit overwriting unrelated custom configuration', async () => {
  const h = await fixture(); await fs.writeFile(path.join(h.workspace, '.mcp.json'), 'custom');
  await expect(h.run('--update', '--apply')).rejects.toThrow('Existing custom file differs');
  await expect(fs.stat(path.join(h.workspace, '.claude/settings.json'))).rejects.toThrow();
});
it('does not overwrite custom desktop configuration or partially activate a conflicting migration', async () => {
  const h = await fixture(); await fs.writeFile(path.join(h.workspace, '.mcp.json'), 'custom');
  await expect(h.run('--apply')).rejects.toThrow('Existing custom file differs');
  await expect(fs.stat(path.join(h.workspace, 'conversation.json'))).rejects.toThrow();
  expect(await fs.readFile(path.join(h.workspace, '.mcp.json'), 'utf8')).toBe('custom');
});
