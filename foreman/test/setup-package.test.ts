import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { configureFresh, prepareClaude, SetupPlan } from '../../tools/setup-package.js';
import { WorkspaceReader } from '../src/claude-workspace-access.js';
import { tempDir, rmrf, demoRepo } from './helpers.js';
import { PROJECT_ROOT } from '../src/config.js';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmrf(d); });
async function fixture() {
  const target = tempDir('setup-profile-'); dirs.push(target); await fs.writeFile(path.join(target, 'installation.json'), '{}');
  await fs.cp(path.join(PROJECT_ROOT, 'tools/portable-templates/workspace'), path.join(target, 'workspace-template'), { recursive: true });
  const repo = await demoRepo(); dirs.push(repo);
  return { target, repo, profile: path.join(target, 'data/portable') };
}
it('creates an empty team without providers or user configuration and does not overwrite it on rerun', async () => {
  const x = await fixture(); const team = await configureFresh(x.target, { projects: [], agents: [] }, async () => []);
  expect(team.agents).toEqual([]);
  const before = await fs.readFile(path.join(x.profile, 'team.json'), 'utf8');
  await expect(configureFresh(x.target, { projects: [], agents: [] }, async () => [])).rejects.toThrow('Existing profile');
  expect(await fs.readFile(path.join(x.profile, 'team.json'), 'utf8')).toBe(before);
});
it('registers local projects and three disabled agents without touching Git or needing GitHub', async () => {
  const x = await fixture(), before = await fs.readFile(path.join(x.repo, '.git/config'), 'utf8');
  const team = await configureFresh(x.target, { projects: [{ path: x.repo }], agents: [
    { name: 'Plan', provider: 'codex', roles: ['planner'] }, { name: 'Develop', provider: 'codex', roles: ['developer'] }, { name: 'Review', provider: 'claude', roles: ['planner', 'reviewer'] },
  ] }, async () => []);
  expect(team.agents).toHaveLength(3); expect(team.agents.every(a => !a.enabled && a.connectionRef === null)).toBe(true);
  expect(await fs.readFile(path.join(x.repo, '.git/config'), 'utf8')).toBe(before);
  const prepared = await prepareClaude(x.target, team.agents[2]!.id, async () => []);
  const access = JSON.parse(await fs.readFile(path.join(prepared.workspace, 'access.json'), 'utf8'));
  expect(access.repositories[0].github).toBeUndefined(); expect(access.repositories[0].path).toBe(x.repo);
  const run = vi.fn(async () => '[]'), reader = new WorkspaceReader(prepared.workspace, access, run);
  expect(await reader.call('projects', {})).toMatchObject([{ access: 'read-only local source' }]);
  await expect(reader.call('github_read', { project: access.repositories[0].id, action: 'repository' })).rejects.toThrow('не настроен');
  expect(run).not.toHaveBeenCalled();
  expect(await fs.readdir(prepared.workspace)).not.toContain('.claude');
});
it('validation rejects unsupported roles, credentials and non-root project paths without publishing a partial profile', async () => {
  const x = await fixture();
  expect(() => SetupPlan.parse({ projects: [], agents: [], token: 'fixture' })).toThrow();
  await expect(configureFresh(x.target, { projects: [], agents: [{ name: 'No', provider: 'claude', roles: ['unknown'] }] }, async () => [])).rejects.toThrow();
  await fs.mkdir(path.join(x.repo, 'subdirectory'));
  await expect(configureFresh(x.target, { projects: [{ path: path.join(x.repo, 'subdirectory') }], agents: [] }, async () => [])).rejects.toThrow('repository root');
  await expect(fs.access(path.join(x.profile, 'state.json'))).rejects.toThrow();
  const team = await configureFresh(x.target, { projects: [{ path: x.repo, github: 'example/project' }], agents: [] }, async () => []);
  expect(team.agents).toEqual([]);
});
it('refuses configuration while Minecraft or a bridge is running', async () => {
  const x = await fixture();
  await expect(configureFresh(x.target, { projects: [], agents: [] }, async () => [{ Name: 'javaw.exe', CommandLine: 'Minecraft' }])).rejects.toThrow('Minecraft');
  await expect(configureFresh(x.target, { projects: [], agents: [] }, async () => [{ Name: 'node.exe', CommandLine: 'observer-main.mjs' }])).rejects.toThrow('bridge');
  await expect(fs.access(x.profile)).rejects.toThrow();
});
