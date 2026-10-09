import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { WorkspaceConfig, type WorkspaceAccess } from './claude-workspace.js';
import { githubError } from './workspace-command-error.js';
import { planningCall } from './claude-planning.js';
import { agentMessageCall } from './agent-message-call.js';

const exec = promisify(execFile);
const repoArg = z.object({ project: z.string() });
const fileArg = repoArg.extend({ file: z.string().min(1).max(500), start: z.number().int().min(1).default(1), lines: z.number().int().min(1).max(250).default(120) });
const revision = z.string().regex(/^(HEAD|[a-fA-F0-9]{7,40})$/);
const githubArg = repoArg.extend({ action: z.enum(['repository', 'files', 'file', 'commits', 'commit', 'pulls', 'pull', 'pull_files', 'issues', 'issue']),
  file: z.string().max(500).optional(), ref: z.string().regex(/^[A-Za-z0-9_./-]{1,150}$/).optional(), number: z.number().int().positive().optional(), sha: revision.optional(), page: z.number().int().min(1).max(100).default(1) });
export type Execute = (command: string, args: string[], cwd?: string) => Promise<string>;
const execute: Execute = async (command, args, cwd) => {
  try { return (await exec(command, args, { cwd, windowsHide: true, shell: false, timeout: 20000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } })).stdout; }
  catch (error) { throw command === 'gh' ? githubError(error) : new Error('Не удалось прочитать Git выбранного проекта.'); }
};
/** These files are outside a source review even when accidentally tracked. */
export function sourceFile(file: string): boolean {
  return !!file && !file.includes('\\') && !file.includes(':') && !file.startsWith('/') && !file.split('/').some(p => !p || p === '.' || p === '..'
    || /^(\.git|\.env.*|\.agentcraft-home|\.claude|node_modules|artifacts|backups?|data|secrets?|credentials?|logs?|bin|obj|dist|build|\.runtime)$/i.test(p))
    && !/(^|\/)(messaging\.json|appsettings\.(?!example\.)[^/]+|[^/]*(?:credentials|private[-_.]?key|token[-_.]?cache|secrets?)[^/]*)$/i.test(file)
    && !/\.(pem|key|pfx|p12|db|sqlite3?|log|zip|jar|exe|dll|png|jpe?g|gif|webp|pdf|mp[34]|woff2?|ttf)$/i.test(file);
}
export const clip = (text: string, limit = 28000) => text.length > limit ? text.slice(0, limit) + '\n[Обрезано; сузь запрос или выбери следующую страницу.]' : text;

export class WorkspaceReader {
  private memorySerial: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string, readonly config: WorkspaceAccess, private run: Execute = execute) {}
  static async open(directory: string) {
    return new WorkspaceReader(directory, WorkspaceConfig.parse(JSON.parse(await fs.readFile(path.join(directory, 'access.json'), 'utf8'))));
  }
  private repo(id: string) {
    const repo = this.config.repositories.find(r => r.id === id);
    if (!repo) throw new Error('Проект не разрешён. Вызови projects.');
    return repo;
  }
  private git(id: string, args: string[]) { return this.run('git', ['--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false', ...args], this.repo(id).path); }
  private async files(id: string) { return (await this.git(id, ['ls-files', '-z', '--cached'])).split('\0').filter(sourceFile); }
  private async commit(id: string, ref: string) {
    return (await this.git(id, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
  }
  private async range(id: string, base?: string, head = 'HEAD') {
    const right = await this.commit(id, head);
    const left = base ? await this.commit(id, base)
      : (await this.git(id, ['rev-list', '--parents', '-n', '1', right])).trim().split(/\s+/)[1];
    return { base: left ?? null, head: right };
  }
  private async treeFile(id: string, head: string, file: string) {
    const entries = (await this.git(id, ['ls-tree', '-z', head, '--', file])).split('\0').filter(Boolean);
    return entries.some(entry => /^100(?:644|755) blob [a-f0-9]+\t/.test(entry) && entry.slice(entry.indexOf('\t') + 1) === file);
  }
  private async localFile(id: string, file: string, knownFiles?: string[]) {
    if (!sourceFile(file) || !(knownFiles ?? await this.files(id)).includes(file)) throw new Error('Доступны только разрешённые файлы, добавленные в Git.');
    const root = await fs.realpath(this.repo(id).path);
    const target = path.resolve(root, file);
    const actual = await fs.realpath(target);
    const rel = path.relative(root, actual).split(path.sep).join('/');
    if (!sourceFile(rel) || actual.toLowerCase() !== target.toLowerCase() || (await fs.lstat(target)).isSymbolicLink()) throw new Error('Ссылки за пределы разрешённого файла не читаются.');
    const info = await fs.stat(actual);
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Нужен текстовый файл до 1 МБ.');
    const text = await fs.readFile(actual, 'utf8');
    if (text.includes('\0')) throw new Error('Двоичный файл не читается.');
    return text;
  }
  private async skill(args: unknown) {
    const p = z.object({ file: z.string().max(500).optional(), start: z.number().int().min(1).default(1), lines: z.number().int().min(1).max(250).default(200) }).parse(args);
    if (!this.config.skillsRoot) throw new Error('Общая папка навыков не подключена в access.json.');
    const root = await fs.realpath(this.config.skillsRoot);
    const allowed = (file: string) => sourceFile(file) && /\.md$/i.test(file)
      && (file === 'AGENTS.md' || file.startsWith('common/') || file.startsWith('projects/trackrecord/'));
    const inside = async (file: string) => {
      const target = path.resolve(root, file); const real = await fs.realpath(target);
      if (real.toLowerCase() !== target.toLowerCase() || (await fs.lstat(target)).isSymbolicLink()) throw new Error('Ссылки из папки навыков не читаются.');
      return real;
    };
    if (!p.file) {
      const files: string[] = []; let depthLimited = false;
      const walk = async (dir: string, depth: number) => {
        if (files.length > 500) return;
        if (depth > 6) { depthLimited = true; return; }
        let entries; try { entries = await fs.readdir(await inside(dir), { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (files.length > 500) break;
          const file = `${dir}/${entry.name}`;
          if (entry.isSymbolicLink() || !sourceFile(file)) continue;
          if (entry.isDirectory()) await walk(file, depth + 1);
          else if (entry.isFile() && allowed(file)) files.push(file);
        }
      };
      for (const dir of ['common', 'projects/trackrecord']) await walk(dir, 0);
      try { await inside('AGENTS.md'); files.unshift('AGENTS.md'); } catch {}
      return { files: files.slice(0, 500), limited: depthLimited || files.length > 500 };
    }
    if (!allowed(p.file)) throw new Error('Доступны Markdown-правила common и projects/trackrecord.');
    const target = await inside(p.file); const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > 128000) throw new Error('Нужен Markdown-файл до 128 КБ.');
    const content = await fs.readFile(target, 'utf8');
    if (content.includes('\0')) throw new Error('Двоичный файл не читается.');
    const lines = content.split(/\r?\n/);
    return { file: p.file, totalLines: lines.length, text: clip(lines.slice(p.start - 1, p.start - 1 + p.lines).map((line, n) => `${p.start + n}: ${line}`).join('\n')) };
  }
  async call(name: string, args: unknown): Promise<unknown> {
    if (name === 'projects') return this.config.repositories.map(r => ({ id: r.id, name: r.name, github: r.github, access: r.github ? 'read-only local source and GitHub' : 'read-only local source' }));
    if (name === 'project_files') {
      const p = repoArg.extend({ contains: z.string().max(150).default(''), offset: z.number().int().min(0).default(0) }).parse(args);
      const files = (await this.files(p.project)).filter(f => f.toLowerCase().includes(p.contains.toLowerCase()));
      return { total: files.length, offset: p.offset, files: files.slice(p.offset, p.offset + 250) };
    }
    if (name === 'project_read') {
      const p = fileArg.parse(args); const all = (await this.localFile(p.project, p.file)).split(/\r?\n/);
      return { file: p.file, totalLines: all.length, text: clip(all.slice(p.start - 1, p.start - 1 + p.lines).map((line, i) => `${p.start + i}: ${line}`).join('\n')) };
    }
    if (name === 'project_search') {
      const p = repoArg.extend({ text: z.string().min(2).max(150), contains: z.string().max(150).default(''), offset: z.number().int().min(0).default(0) }).parse(args);
      const all = (await this.files(p.project)).filter(f => f.toLowerCase().includes(p.contains.toLowerCase()));
      const files = all.slice(p.offset, p.offset + 200); const matches: { file: string; line: number; text: string }[] = []; let scanned = 0;
      for (const file of files) {
        scanned++;
        let text; try { text = await this.localFile(p.project, file, files); } catch { continue; }
        text.split(/\r?\n/).forEach((line, i) => { if (matches.length < 80 && line.toLowerCase().includes(p.text.toLowerCase())) matches.push({ file, line: i + 1, text: line.slice(0, 400) }); });
        if (matches.length >= 80) break;
      }
      return { totalFiles: all.length, scannedPage: { offset: p.offset, count: scanned }, matches, limited: matches.length >= 80 || p.offset + scanned < all.length };
    }
    if (name === 'project_git') {
      const p = repoArg.extend({ action: z.enum(['status', 'log', 'diff', 'changed_files', 'show']), base: revision.optional(), head: revision.optional(), file: z.string().max(4096).optional(),
        offset: z.number().int().min(0).default(0), start: z.number().int().min(1).default(1), lines: z.number().int().min(1).max(250).default(120) }).parse(args);
      if (p.action === 'status') return clip(await this.git(p.project, ['status', '--short', '--branch']));
      if (p.action === 'log') return clip(await this.git(p.project, ['log', '-15', '--format=%h %ad %s', '--date=iso-strict']));
      if (p.action === 'changed_files') {
        const range = await this.range(p.project, p.base, p.head);
        const fields = (await this.git(p.project, range.base
          ? ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', range.base, range.head, '--']
          : ['diff-tree', '--root', '--no-commit-id', '--no-renames', '--name-status', '-z', '-r', range.head, '--'])).split('\0');
        const files: { status: string; file: string; readable: boolean }[] = [];
        for (let i = 0; i + 1 < fields.length; i += 2) files.push({ status: fields[i]!, file: fields[i + 1]!, readable: sourceFile(fields[i + 1]!) });
        // Include every path in the inventory, flagging paths whose contents cannot be read.
        // Renames deliberately appear as deletion + addition, avoiding hidden old paths.
        const page: typeof files = []; let bytes = 0;
        for (const file of files.slice(p.offset, p.offset + 100)) {
          const length = JSON.stringify(file).length;
          if (bytes + length > 20000 && page.length) break;
          page.push(file); bytes += length;
        }
        return { ...range, total: files.length, offset: p.offset, files: page, nextOffset: p.offset + page.length < files.length ? p.offset + page.length : null };
      }
      if (!p.file || !sourceFile(p.file)) throw new Error('Укажи разрешённый путь исходного файла.');
      if (p.action === 'show') {
        const head = await this.commit(p.project, p.head ?? 'HEAD');
        if (!await this.treeFile(p.project, head, p.file)) throw new Error('Обычного файла нет в выбранном коммите. Для удалённого файла выбери base из changed_files.');
        const content = await this.git(p.project, ['show', `${head}:${p.file}`]);
        if (Buffer.byteLength(content) > 1024 * 1024 || content.includes('\0')) throw new Error('Нужен текстовый файл до 1 МБ.');
        const lines = content.split(/\r?\n/);
        return { head, file: p.file, totalLines: lines.length, text: clip(lines.slice(p.start - 1, p.start - 1 + p.lines).map((line, n) => `${p.start + n}: ${line}`).join('\n')) };
      }
      if (p.head) {
        const range = await this.range(p.project, p.base, p.head);
        if (!await this.treeFile(p.project, range.head, p.file) && !(range.base && await this.treeFile(p.project, range.base, p.file))) throw new Error('Файла нет в выбранных коммитах.');
        return clip(await this.git(p.project, range.base
          ? ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=12', range.base, range.head, '--', p.file]
          : ['show', '--format=', '--root', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=12', range.head, '--', p.file]));
      }
      const base = await this.commit(p.project, p.base ?? 'HEAD');
      if (!(await this.files(p.project)).includes(p.file) && !await this.treeFile(p.project, base, p.file)) throw new Error('Файл не отслеживается в выбранном проекте.');
      return clip(await this.git(p.project, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=12', base, '--', p.file]));
    }
    if (name === 'planning_list' || name === 'planning_create') return planningCall(this.directory, name, args);
    if (name === 'agent_message' || name === 'agent_messages') return agentMessageCall(this.directory, name, args);
    if (name === 'github_read') return this.github(githubArg.parse(args));
    if (name === 'skill_read') return this.skill(args);
    if (name === 'memory_read') return clip(await fs.readFile(path.join(this.directory, 'MEMORY.md'), 'utf8'), 40000);
    if (name === 'remember') {
      const p = z.object({ note: z.string().trim().min(1).max(1500) }).parse(args);
      const work = this.memorySerial.then(async () => {
        const file = path.join(this.directory, 'MEMORY.md');
        if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('Файл памяти не должен быть ссылкой.');
        const old = await fs.readFile(file, 'utf8');
        if (old.includes(p.note)) return 'Уже запомнила.';
        const entry = `\n- ${new Date().toISOString().slice(0, 10)}: ${p.note}\n`;
        if (Buffer.byteLength(old + entry, 'utf8') > 60000) throw new Error('Память заполнена. Пользователю нужно сократить MEMORY.md.');
        await fs.appendFile(file, entry, 'utf8');
        return 'Сохранено в личную память Claude.';
      }); this.memorySerial = work.catch(() => {}); return work;
    }
    throw new Error('Неизвестный инструмент.');
  }
  private async github(p: z.infer<typeof githubArg>) {
    const repository = this.repo(p.project).github;
    if (!repository) throw new Error('GitHub для этого проекта не настроен. Локальные файлы доступны.');
    const root = `repos/${repository}`;
    let endpoint: string = root;
    if (['pull', 'pull_files', 'issue'].includes(p.action) && !p.number) throw new Error('Укажи номер PR или issue.');
    const page = `per_page=20&page=${p.page}`;
    if (p.action === 'pulls') endpoint += `/pulls?state=all&${page}`;
    if (p.action === 'pull') endpoint += `/pulls/${p.number}`;
    if (p.action === 'pull_files') endpoint += `/pulls/${p.number}/files?${page}`;
    if (p.action === 'issues') endpoint += `/issues?state=all&${page}`;
    if (p.action === 'issue') endpoint += `/issues/${p.number}`;
    if (p.action === 'commits') endpoint += `/commits?${page}`;
    if (p.action === 'commit') { if (!p.sha) throw new Error('Укажи SHA коммита.'); endpoint += `/commits/${p.sha}`; }
    if (p.action === 'files' || p.action === 'file') {
      const file = p.file ?? '';
      if ((file && !sourceFile(file)) || (p.action === 'file' && !file)) throw new Error('Недопустимый путь файла.');
      endpoint += `/contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(p.ref ?? 'HEAD')}`;
    }
    const data = JSON.parse(await this.run('gh', ['api', '--hostname', 'github.com', '--method', 'GET', endpoint]));
    if (p.action === 'file') {
      if (data.type !== 'file' || data.encoding !== 'base64' || data.size > 1024 * 1024 || !sourceFile(data.path)) throw new Error('GitHub вернул не текстовый файл до 1 МБ.');
      const content = Buffer.from(data.content, 'base64').toString('utf8');
      if (content.includes('\0')) throw new Error('Двоичный файл не читается.');
      return { path: data.path, sha: data.sha, text: clip(content) };
    }
    if (p.action === 'files') {
      if (!Array.isArray(data)) throw new Error('Укажи каталог для списка файлов.');
      return data.filter(d => sourceFile(d.path)).slice(0, 250).map(d => ({ path: d.path, type: d.type, sha: d.sha }));
    }
    if (p.action === 'repository') return { full_name: data.full_name, private: data.private, default_branch: data.default_branch, description: data.description, html_url: data.html_url };
    if (p.action === 'pull_files') return data.filter((d: { filename: string }) => sourceFile(d.filename));
    if (p.action === 'commit' && Array.isArray(data.files)) data.files = data.files.filter((d: { filename: string }) => sourceFile(d.filename));
    return data;
  }
}
