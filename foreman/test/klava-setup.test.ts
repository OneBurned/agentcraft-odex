import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { claudeWorkspace } from '../src/claude-workspace.js';
const exec = promisify(execFile); const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) { if (!dir.startsWith(path.join(os.tmpdir(), 'klava-setup-test-'))) throw new Error('Unexpected cleanup path'); await fs.rm(dir, { recursive: true, force: true }); } });
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klava-setup-test-')); dirs.push(dir);
  const workspace = path.join(dir, 'workspace'); const profile = path.join(dir, 'profile'); const repo = path.join(dir, 'repo'); const skills = path.join(dir, 'skills');
  await fs.mkdir(path.join(repo, '.git'), { recursive: true }); await fs.mkdir(skills); await fs.writeFile(path.join(skills, 'AGENTS.md'), 'shared rules');
  const run = (...args: string[]) => exec(process.execPath, [path.resolve('../tools/setup-klava.mjs'), '--workspace', workspace, '--traderecord', repo, '--profile-dir', profile, ...args], { windowsHide: true });
  const read = (name: string) => fs.readFile(path.join(workspace, name), 'utf8');
  return { dir, workspace, profile, skills, run, read };
}
it('explicitly upgrades old workspaces while preserving personal files and keeping a backup', async () => {
  const h = await fixture(); await h.run(); await fs.unlink(path.join(h.workspace, 'WORKSPACE.md'));
  const personal = { 'CLAUDE.md': 'Моя личность и правила', 'PROJECTS.md': 'Мои описания', 'MEMORY.md': 'Не потерять договорённости' };
  for (const [file, content] of Object.entries(personal)) await fs.writeFile(path.join(h.workspace, file), content);
  const oldAccess = await h.read('access.json');
  await expect(h.run('--skills', h.skills)).rejects.toThrow('--update');
  expect(await h.read('access.json')).toBe(oldAccess);
  const updated = JSON.parse((await h.run('--skills', h.skills, '--update')).stdout);
  expect(JSON.parse(await h.read('access.json')).skillsRoot).toBe(h.skills);
  for (const [file, content] of Object.entries(personal)) {
    expect(await h.read(file)).toBe(content); expect(await fs.readFile(path.join(updated.backup, file), 'utf8')).toBe(content);
  }
  expect(await fs.readFile(path.join(updated.backup, 'access.json'), 'utf8')).toBe(oldAccess);
  expect(claudeWorkspace(h.workspace).instructions).toContain('changed_files');
  expect(claudeWorkspace(h.workspace).instructions).toContain('Моя личность');
  expect(JSON.parse((await h.run('--skills', h.skills, '--update')).stdout).backup).toBeUndefined();
});
it('ignores JSON key ordering and preserves an existing skills root when the option is omitted', async () => {
  const h = await fixture(); await h.run('--skills', h.skills);
  const original = JSON.parse(await h.read('access.json'));
  const reordered = JSON.stringify({ repositories: original.repositories.map((r: Record<string, string>) => ({ github: r.github, path: r.path, name: r.name, id: r.id })), skillsRoot: original.skillsRoot, version: original.version }, null, 1);
  await fs.writeFile(path.join(h.workspace, 'access.json'), reordered);
  await h.run('--skills', h.skills); await h.run('--update');
  expect(await h.read('access.json')).toBe(reordered);
});
it('refuses changing repositories, existing skill roots or a bound profile even with --update', async () => {
  const h = await fixture(); await h.run('--skills', h.skills);
  const old = await h.read('access.json');
  const other = path.join(h.dir, 'other'); await fs.mkdir(other); await fs.writeFile(path.join(other, 'AGENTS.md'), 'other');
  await expect(h.run('--skills', other, '--update')).rejects.toThrow('reviewed manually');
  expect(await h.read('access.json')).toBe(old);
  const changed = JSON.parse(old); changed.repositories[0].github = 'Other/Repo';
  await fs.writeFile(path.join(h.workspace, 'access.json'), JSON.stringify(changed));
  await expect(h.run('--update')).rejects.toThrow('reviewed manually');
  await fs.writeFile(path.join(h.workspace, 'access.json'), old);
  await fs.writeFile(path.join(h.profile, 'claude-workspace.json'), JSON.stringify({ directory: other }));
  await expect(h.run('--update')).rejects.toThrow('another workspace');
  expect(await h.read('access.json')).toBe(old);
});
