import { StringDecoder } from 'node:string_decoder';

const invalidStream = 'Не удалось прочитать поток ревью Claude.';
const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const fileLabel = (v: unknown) => typeof v === 'string' && v.length <= 200
  && /^[\p{L}\p{N}_./ ()-]+$/u.test(v) && !v.startsWith('/') && !v.split('/').includes('..') ? v : undefined;
const projectLabel = (v: unknown) => typeof v === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(v) ? v : undefined;
const gitActions = new Map([['status', 'Статус Git'], ['log', 'История Git'], ['diff', 'Diff'],
  ['changed_files', 'Изменённые файлы'], ['show', 'Файл из коммита']]);

/** Only explicit tool names and path/project fields may enter the public feed. */
export function reviewStep(name: unknown, value: unknown): string | undefined {
  const input = record(value) ?? {};
  const file = fileLabel(input.file), project = projectLabel(input.project);
  const where = project ? ` (${project})` : '';
  switch (name) {
    case 'mcp__klava__projects': return 'Список проектов';
    case 'mcp__klava__project_files': return `Список файлов${where}`;
    case 'mcp__klava__project_read': return `Читаю ${file ?? 'файл'}${where}`;
    case 'mcp__klava__project_search': return `Поиск по файлам${where}`;
    case 'mcp__klava__project_git': {
      const action = typeof input.action === 'string' ? gitActions.get(input.action) : undefined;
      return action ? `${action}${file ? ` ${file}` : ''}${where}` : `Проверка Git${where}`;
    }
    case 'mcp__klava__skill_read': return `Правила: ${file ?? 'список навыков'}`;
    case 'mcp__klava__github_read': return `GitHub${file ? `: ${file}` : ''}${where}`;
    case 'mcp__klava__memory_read': return 'Читаю память';
    case 'mcp__klava__remember': return 'Записываю заметку';
    case 'mcp__klava__planning_list': return 'Список задач';
    case 'mcp__klava__planning_create': return 'Создание черновика задачи';
    default: return undefined;
  }
}

/** NDJSON reader: no assistant prose, reasoning, tool results or diagnostics are exposed. */
export class ReviewStream {
  private decoder = new StringDecoder('utf8');
  private pending = '';
  private length = 0;
  private result?: Record<string, unknown>;
  private seen = new Set<string>();
  private lastStep = -Infinity;
  constructor(private onStep: (step: string) => void = () => {}, private now: () => number = Date.now) {}

  push(chunk: Buffer | string) {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    this.length += text.length;
    if (this.length > 2_000_000) throw new Error('Ответ Claude слишком большой.');
    this.pending += text;
    let newline: number;
    while ((newline = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, newline); this.pending = this.pending.slice(newline + 1);
      this.line(line);
    }
  }
  finish(): Record<string, unknown> {
    this.push(this.decoder.end());
    if (this.pending.trim()) this.line(this.pending);
    this.pending = '';
    if (!this.result) throw new Error(invalidStream);
    return this.result;
  }
  private line(line: string) {
    if (!line.trim()) return;
    let event: Record<string, unknown> | undefined;
    try { event = record(JSON.parse(line)); } catch { throw new Error(invalidStream); }
    if (!event) throw new Error(invalidStream);
    if (this.result) return;
    if (event.type === 'result') { this.result = event; return; }
    if (event.type !== 'assistant') return;
    const content = record(event.message)?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      const tool = record(block);
      if (tool?.type !== 'tool_use') continue;
      const step = reviewStep(tool.name, tool.input);
      if (!step || this.seen.has(step)) continue;
      const now = this.now();
      if (now - this.lastStep < 2500) continue;
      this.seen.add(step); this.lastStep = now;
      this.onStep(step);
    }
  }
}
