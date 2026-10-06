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
});
it('does not overwrite custom desktop configuration or partially activate a conflicting migration', async () => {
  const h = await fixture(); await fs.writeFile(path.join(h.workspace, '.mcp.json'), 'custom');
  await expect(h.run('--apply')).rejects.toThrow('Existing custom file differs');
  await expect(fs.stat(path.join(h.workspace, 'conversation.json'))).rejects.toThrow();
  expect(await fs.readFile(path.join(h.workspace, '.mcp.json'), 'utf8')).toBe('custom');
});
