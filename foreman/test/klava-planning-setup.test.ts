import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
const exec = promisify(execFile); const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-planning-setup-')); dirs.push(root);
  const workspace = path.join(root, 'workspace'), profile = path.join(root, 'profile');
  await fs.mkdir(path.join(workspace, '.claude'), { recursive: true }); await fs.mkdir(profile);
  for (const name of ['CLAUDE.md', 'PROJECTS.md', 'MEMORY.md', 'WORKSPACE.md']) await fs.writeFile(path.join(workspace, name), `personal ${name}`);
  await fs.writeFile(path.join(workspace, 'access.json'), JSON.stringify({ version: 1, repositories: [{ id: 'repo', name: 'Repo', path: root, github: 'Owner/Repo' }] }));
  await fs.writeFile(path.join(profile, 'claude-workspace.json'), JSON.stringify({ directory: workspace }));
  const settings = { custom: true, permissions: { allow: ['mcp__klava__projects'], deny: ['Bash'], ask: ['Read'] } };
  await fs.writeFile(path.join(workspace, '.claude/settings.json'), JSON.stringify(settings));
  const run = (...args: string[]) => exec(process.execPath, ['--import', pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href, path.resolve('../tools/configure-klava-planning.mjs'), '--workspace', workspace, '--profile-dir', profile, '--port', '17878', ...args], { windowsHide: true });
  return { root, workspace, profile, settings, run };
}
it('prepares without activation and applies with backup while preserving personality, memory and custom permissions', async () => {
  const h = await fixture(); await h.run('--prepare', path.join(h.root, 'nested', 'preview'));
  await expect(fs.stat(path.join(h.workspace, 'planning.json'))).rejects.toThrow();
  await expect(fs.stat(path.join(h.profile, 'planning.json'))).rejects.toThrow();
  await expect(h.run('--prepare', h.workspace)).rejects.toThrow('outside');
  const result = JSON.parse((await h.run('--apply')).stdout);
  const settings = JSON.parse(await fs.readFile(path.join(h.workspace, '.claude/settings.json'), 'utf8'));
  expect(settings).toMatchObject({ custom: true, permissions: { deny: h.settings.permissions.deny, ask: h.settings.permissions.ask } });
  expect(settings.permissions.allow).toEqual([...h.settings.permissions.allow, 'mcp__klava__planning_list', 'mcp__klava__planning_create']);
  for (const name of ['CLAUDE.md', 'PROJECTS.md', 'MEMORY.md']) expect(await fs.readFile(path.join(h.workspace, name), 'utf8')).toBe(`personal ${name}`);
  expect(await fs.readFile(path.join(result.backup, 'WORKSPACE.md'), 'utf8')).toBe('personal WORKSPACE.md');
  const binding = await fs.readFile(path.join(h.workspace, 'planning.json'), 'utf8');
  expect(await fs.readFile(path.join(h.profile, 'planning.json'), 'utf8')).toBe(binding);
  await h.run('--apply'); expect(await fs.readFile(path.join(h.workspace, 'planning.json'), 'utf8')).toBe(binding);
});
it('refuses a different profile binding before changing any live files', async () => {
  const h = await fixture(); await fs.writeFile(path.join(h.profile, 'claude-workspace.json'), JSON.stringify({ directory: h.root }));
  await expect(h.run('--apply')).rejects.toThrow('another workspace');
  expect(await fs.readFile(path.join(h.workspace, 'WORKSPACE.md'), 'utf8')).toBe('personal WORKSPACE.md');
  await expect(fs.stat(path.join(h.workspace, 'planning.json'))).rejects.toThrow();
});
