import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WorkspaceReader, sourceFile, type Execute } from '../src/claude-workspace-access.js';
import { claudeWorkspace, loadClaudeWorkspace, type WorkspaceAccess, workspaceTools } from '../src/claude-workspace.js';
import { githubError } from '../src/workspace-command-error.js';
const exec = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true }); });
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klava-workspace-test-')); dirs.push(dir);
  const repo = path.join(dir, 'repo'); const workspace = path.join(dir, 'workspace');
  await fs.mkdir(repo); await fs.mkdir(workspace);
  const git = (...args: string[]) => exec('git', args, { cwd: repo });
  await git('init');
  await fs.writeFile(path.join(repo, 'README.md'), 'Original source\nSecond line\n');
  await fs.writeFile(path.join(repo, '.env'), 'PRIVATE_FIXTURE=secret');
  await git('add', '.'); await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'initial');
  await fs.writeFile(path.join(repo, 'README.md'), 'Current uncommitted source\nSecond line\n');
  for (const name of ['CLAUDE.md', 'PROJECTS.md', 'MEMORY.md']) await fs.writeFile(path.join(workspace, name), `# ${name}\nInitial context\n`);
  const config: WorkspaceAccess = { version: 1, repositories: [{ id: 'one', name: 'First', path: repo, github: 'Owner/Private' }] };
  await fs.writeFile(path.join(workspace, 'access.json'), JSON.stringify(config));
  return { dir, repo, workspace, config, git, reader: new WorkspaceReader(workspace, config) };
}
describe('reviewer workspace boundaries', () => {
  it('inventories all changes, including deleted and restricted files, and reads exact historical content', async () => {
    const h = await fixture(); const base = (await h.git('rev-parse', 'HEAD')).stdout.trim();
    await h.git('mv', 'README.md', 'Renamed file.md');
    await fs.writeFile(path.join(h.repo, '.env'), 'PRIVATE_FIXTURE=changed');
    await fs.writeFile(path.join(h.repo, 'added.md'), 'New file\n');
    await h.git('add', '.'); await h.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'changes');
    const head = (await h.git('rev-parse', 'HEAD')).stdout.trim();
    const inventory = await h.reader.call('project_git', { project: 'one', action: 'changed_files', head });
    expect(inventory).toMatchObject({ base, head, total: 4, nextOffset: null, files: [
      { file: '.env', status: 'M', readable: false }, { file: 'README.md', status: 'D', readable: true },
      { file: 'Renamed file.md', status: 'A', readable: true }, { file: 'added.md', status: 'A', readable: true },
    ] });
    expect(await h.reader.call('project_git', { project: 'one', action: 'diff', file: 'README.md', base, head })).toContain('-Original source');
    expect(await h.reader.call('project_git', { project: 'one', action: 'show', file: 'README.md', head: base })).toMatchObject({ head: base, text: expect.stringContaining('1: Original source') });
    await expect(h.reader.call('project_git', { project: 'one', action: 'show', file: 'README.md', head })).rejects.toThrow('нет');
    await expect(h.reader.call('project_git', { project: 'one', action: 'show', file: '.env', head: base })).rejects.toThrow('разрешённый');
    await expect(h.reader.call('project_git', { project: 'one', action: 'changed_files', head: '--output=file' })).rejects.toThrow();
    await fs.writeFile(path.join(h.repo, 'added.md'), 'Later working changes');
    expect(await h.reader.call('project_git', { project: 'one', action: 'show', file: 'added.md', head })).toMatchObject({ text: '1: New file\n2: ' });
  });
  it('handles an initial commit and pages a large complete inventory', async () => {
    const h = await fixture(); const head = (await h.git('rev-parse', 'HEAD')).stdout.trim();
    expect(await h.reader.call('project_git', { project: 'one', action: 'changed_files', head })).toMatchObject({ base: null, head, total: 2 });
    expect(await h.reader.call('project_git', { project: 'one', action: 'diff', file: 'README.md', head })).toContain('+Original source');
    await Promise.all(Array.from({ length: 105 }, (_, n) => fs.writeFile(path.join(h.repo, `file-${n}.md`), 'source')));
    await h.git('add', '.'); await h.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'many files');
    expect(await h.reader.call('project_git', { project: 'one', action: 'changed_files' })).toMatchObject({ total: 106, nextOffset: 100 });
    expect(await h.reader.call('project_git', { project: 'one', action: 'changed_files', offset: 100 })).toMatchObject({ total: 106, offset: 100, nextOffset: null, files: expect.any(Array) });
  });
  it('reports a full 500-document skill list accurately and enforces size limits', async () => {
    const h = await fixture(); const skillsRoot = path.join(h.dir, 'skills');
    await fs.mkdir(path.join(skillsRoot, 'common'), { recursive: true });
    await Promise.all(Array.from({ length: 500 }, (_, n) => fs.writeFile(path.join(skillsRoot, `common/rule-${n}.md`), 'rule')));
    const reader = new WorkspaceReader(h.workspace, { ...h.config, skillsRoot });
    expect(await reader.call('skill_read', {})).toMatchObject({ limited: false, files: expect.any(Array) });
    await fs.writeFile(path.join(skillsRoot, 'AGENTS.md'), '# index');
    const limited = await reader.call('skill_read', {}) as { limited: boolean; files: string[] };
    expect(limited.limited).toBe(true); expect(limited.files).toHaveLength(500);
    await fs.writeFile(path.join(skillsRoot, 'common/large.md'), 'a'.repeat(128001));
    await expect(reader.call('skill_read', { file: 'common/large.md' })).rejects.toThrow('128');
  });
  it.each([
    [{ code: 'ENOENT' }, 'GITHUB_CLI_MISSING'], [{ killed: true }, 'GITHUB_TIMEOUT'],
    [{ stderr: 'Bad credentials (HTTP 401)' }, 'GITHUB_AUTH_REQUIRED'],
    [{ stderr: 'Forbidden (HTTP 403)' }, 'GITHUB_FORBIDDEN'],
    [{ stderr: 'API rate limit (HTTP 403)' }, 'GITHUB_RATE_LIMIT'],
    [{ stderr: 'Too many requests (HTTP 429)' }, 'GITHUB_RATE_LIMIT'],
    [{ stderr: 'Not Found (HTTP 404)' }, 'GITHUB_NOT_FOUND_OR_HIDDEN'],
    [{ stderr: 'No commit found (HTTP 422)' }, 'GITHUB_INVALID_REFERENCE_OR_REQUEST'],
    [{ stderr: 'error connecting to api.github.com' }, 'GITHUB_NETWORK'],
    [{ stderr: 'unknown failure' }, 'GITHUB_REQUEST_FAILED'],
  ])('classifies GitHub errors without exposing raw diagnostics: %j', (input, code) => {
    const error = githubError({ ...input, stdout: 'PRIVATE_TOKEN_FIXTURE' });
    expect(error.code).toBe(code); expect(error.message).not.toContain('PRIVATE_TOKEN_FIXTURE');
    if (code === 'GITHUB_NOT_FOUND_OR_HIDDEN') expect(error.message).toContain('не доказывает');
  });
  it('reads current shared rules outside Git, limited to the permitted Markdown namespaces', async () => {
    const h = await fixture(); const skillsRoot = path.join(h.dir, 'skills');
    await fs.mkdir(path.join(skillsRoot, 'common/debugging-workflow'), { recursive: true });
    await fs.mkdir(path.join(skillsRoot, 'projects/trackrecord/domain'), { recursive: true });
    await fs.mkdir(path.join(skillsRoot, 'projects/other'), { recursive: true });
    await fs.writeFile(path.join(skillsRoot, 'AGENTS.md'), '# Shared skills');
    const file = path.join(skillsRoot, 'common/debugging-workflow/SKILL.md');
    await fs.writeFile(file, 'Investigate source data.');
    await fs.writeFile(path.join(skillsRoot, 'projects/trackrecord/domain/SKILL.md'), 'Do not invent cash.');
    await fs.writeFile(path.join(skillsRoot, 'projects/other/SKILL.md'), 'Not authorized');
    await fs.writeFile(path.join(skillsRoot, 'common/debugging-workflow/run.ps1'), 'not readable');
    const reader = new WorkspaceReader(h.workspace, { ...h.config, skillsRoot });
    expect(await reader.call('skill_read', {})).toMatchObject({ files: ['AGENTS.md', 'common/debugging-workflow/SKILL.md', 'projects/trackrecord/domain/SKILL.md'] });
    expect(await reader.call('skill_read', { file: 'common/debugging-workflow/SKILL.md' })).toMatchObject({ text: '1: Investigate source data.' });
    await fs.writeFile(file, 'Updated rules.');
    expect(await reader.call('skill_read', { file: 'common/debugging-workflow/SKILL.md' })).toMatchObject({ text: '1: Updated rules.' });
    for (const file of ['../workspace/CLAUDE.md', 'common/../../workspace/CLAUDE.md', 'projects/other/SKILL.md', 'common/debugging-workflow/run.ps1'])
      await expect(reader.call('skill_read', { file })).rejects.toThrow();
    await expect(h.reader.call('skill_read', {})).rejects.toThrow('не подключена');
  });
  it('does not follow shared-skill junctions outside the configured tree', async () => {
    const h = await fixture(); const skillsRoot = path.join(h.dir, 'skills');
    await fs.mkdir(skillsRoot); await fs.symlink(h.workspace, path.join(skillsRoot, 'common'), process.platform === 'win32' ? 'junction' : 'dir');
    const reader = new WorkspaceReader(h.workspace, { ...h.config, skillsRoot });
    expect(await reader.call('skill_read', {})).toMatchObject({ files: [] });
    await expect(reader.call('skill_read', { file: 'common/CLAUDE.md' })).rejects.toThrow('Ссылки');
  });
  it('reads current tracked files and local Git context, not just the committed snapshot', async () => {
    const h = await fixture();
    expect(await h.reader.call('project_files', { project: 'one' })).toMatchObject({ files: ['README.md'] });
    expect(await h.reader.call('project_read', { project: 'one', file: 'README.md', start: 2, lines: 1 })).toMatchObject({ text: '2: Second line' });
    expect(await h.reader.call('project_search', { project: 'one', text: 'uncommitted' })).toMatchObject({ matches: [{ file: 'README.md', line: 1, text: 'Current uncommitted source' }] });
    expect(await h.reader.call('project_git', { project: 'one', action: 'diff', file: 'README.md' })).toContain('+Current uncommitted source');
    expect(await h.reader.call('project_git', { project: 'one', action: 'log' })).toContain('initial');
    expect(await h.reader.call('project_git', { project: 'one', action: 'status' })).toContain('README.md');
  });
  it('denies traversal, secrets, untracked files, extra projects and executable revisions', async () => {
    const h = await fixture();
    await fs.writeFile(path.join(h.repo, 'private.txt'), 'untracked fixture');
    for (const file of ['../MEMORY.md', '.env', 'C:/Windows/win.ini', 'README.md:stream', 'private.txt', 'a/../../README.md'])
      await expect(h.reader.call('project_read', { project: 'one', file })).rejects.toThrow();
    await expect(h.reader.call('project_read', { project: 'other', file: 'README.md' })).rejects.toThrow('не разрешён');
    await expect(h.reader.call('project_git', { project: 'one', action: 'diff', file: '.env' })).rejects.toThrow();
    await expect(h.reader.call('project_git', { project: 'one', action: 'diff', file: 'README.md', base: '--output=owned' })).rejects.toThrow();
    for (const file of ['.git/config', '.claude/settings.json', 'data/users.json', 'artifacts/log.txt', 'appsettings.Production.json', 'credentials.json', 'server.key', 'messaging.json', 'agents/other/messaging.json']) expect(sourceFile(file)).toBe(false);
  });
  it('refuses a tracked path replaced by a junction pointing outside the repo', async () => {
    const h = await fixture(); await fs.mkdir(path.join(h.repo, 'docs')); await fs.writeFile(path.join(h.repo, 'docs/guide.md'), 'tracked'); await h.git('add', 'docs');
    const outside = path.join(h.dir, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'guide.md'), 'private');
    await fs.rm(path.join(h.repo, 'docs'), { recursive: true }); await fs.symlink(outside, path.join(h.repo, 'docs'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(h.reader.call('project_read', { project: 'one', file: 'docs/guide.md' })).rejects.toThrow('Ссылки');
  });
  it('persists explicit notes only in MEMORY.md, retains instructions and deduplicates', async () => {
    const h = await fixture();
    await h.reader.call('remember', { note: 'Общаться кратко.' });
    expect(await h.reader.call('remember', { note: 'Общаться кратко.' })).toContain('Уже');
    const reopened = await WorkspaceReader.open(h.workspace);
    expect(await reopened.call('memory_read', {})).toContain('Общаться кратко.');
    expect(await fs.readFile(path.join(h.workspace, 'CLAUDE.md'), 'utf8')).toBe('# CLAUDE.md\nInitial context\n');
    await expect(h.reader.call('write_file', { file: 'README.md', text: 'changed' })).rejects.toThrow('Неизвестный');
  });
  it('uses fixed GitHub GET endpoints with only configured repositories', async () => {
    const h = await fixture();
    const run = vi.fn<Execute>(async () => JSON.stringify({ full_name: 'Owner/Private', private: true, default_branch: 'main' }));
    const reader = new WorkspaceReader(h.workspace, h.config, run);
    expect(await reader.call('github_read', { project: 'one', action: 'repository' })).toMatchObject({ private: true });
    expect(run).toHaveBeenCalledWith('gh', ['api', '--hostname', 'github.com', '--method', 'GET', 'repos/Owner/Private']);
    await reader.call('github_read', { project: 'one', action: 'pull', number: 17 });
    expect(run.mock.calls[1]![1].at(-1)).toBe('repos/Owner/Private/pulls/17');
    await expect(reader.call('github_read', { project: 'other', action: 'repository' })).rejects.toThrow();
    await expect(reader.call('github_read', { project: 'one', action: 'merge', number: 17 })).rejects.toThrow();
    await expect(reader.call('github_read', { project: 'one', action: 'file', file: '../secrets' })).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('filters secret-file patches in GitHub results and bounds text reads', async () => {
    const h = await fixture();
    const run = vi.fn<Execute>(async () => JSON.stringify([{ filename: '.env', patch: 'secret' }, { filename: 'README.md', patch: 'source' }]));
    const reader = new WorkspaceReader(h.workspace, h.config, run);
    expect(await reader.call('github_read', { project: 'one', action: 'pull_files', number: 1 })).toEqual([{ filename: 'README.md', patch: 'source' }]);
    run.mockResolvedValueOnce(JSON.stringify({ type: 'file', path: 'README.md', encoding: 'base64', size: 30000, content: Buffer.from('a'.repeat(30000)).toString('base64') }));
    expect(await reader.call('github_read', { project: 'one', action: 'file', file: 'README.md' })).toMatchObject({ text: expect.stringContaining('Обрезано') });
  });
  it('has no implicit access, refreshes editable instructions, and fails closed on bad configuration', async () => {
    const h = await fixture();
    expect(loadClaudeWorkspace(h.dir)).toBeUndefined();
    await fs.writeFile(path.join(h.dir, 'claude-workspace.json'), JSON.stringify({ directory: h.workspace }));
    const first = loadClaudeWorkspace(h.dir)!;
    expect(first.args).toContain('--strict-mcp-config'); expect(first.args).toContain('--disable-slash-commands');
    expect(first.args.join(' ')).not.toContain('Bash');
    await fs.appendFile(path.join(h.workspace, 'MEMORY.md'), '\nNew decision');
    expect(loadClaudeWorkspace(h.dir)!.instructions).toContain('New decision');
    await fs.writeFile(path.join(h.workspace, 'access.json'), '{}');
    expect(() => loadClaudeWorkspace(h.dir)).toThrow();
  });
  it('serves the advertised tools over actual MCP stdio and denies unconfigured projects', async () => {
    const h = await fixture(); const workspace = claudeWorkspace(h.workspace);
    const config = JSON.parse(workspace.args[workspace.args.indexOf('--mcp-config') + 1]!).mcpServers.klava;
    // Test the real entry point, not an in-process dispatch mock.
    const client = new Client({ name: 'workspace-test', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: config.args, stderr: 'pipe' });
    let diagnostic = ''; transport.stderr?.on('data', b => { diagnostic += b.toString(); });
    expect(config.args.at(-1)).toBe(h.workspace);
    try {
      await client.connect(transport).catch(e => { throw new Error(`${e.message}\n${diagnostic}`); });
      expect((await client.listTools()).tools.map(t => t.name)).toEqual(workspaceTools);
      const read = await client.callTool({ name: 'project_read', arguments: { project: 'one', file: 'README.md' } });
      expect(JSON.stringify(read)).toContain('Current uncommitted source');
      const denied = await client.callTool({ name: 'github_read', arguments: { project: 'other', action: 'repository' } });
      expect(denied.isError).toBe(true);
    } finally { await client.close(); }
  });
});
