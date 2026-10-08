import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Outbound } from './protocol.js';
import { writeFileAtomic } from './util/fsx.js';

export const PERSONA_EVENTS = ['task_started', 'task_finished', 'error', 'review_started', 'review_pass',
  'review_changes', 'question', 'pause', 'stop', 'rest', 'dance', 'peer'] as const;
export type PersonaEvent = typeof PERSONA_EVENTS[number];
export type PersonaRole = 'marlow' | 'wren';
const eventTitles: Record<PersonaEvent, string> = { task_started: 'Начало задачи', task_finished: 'Задача завершена', error: 'Ошибка',
  review_started: 'Начало ревью', review_pass: 'Ревью принято', review_changes: 'Нужны исправления', question: 'Вопрос игроку',
  pause: 'Пауза', stop: 'Остановка', rest: 'Отдых', dance: 'Танец', peer: 'Встреча с коллегой' };
const phrases = z.array(z.string().trim().min(1, 'Фраза не должна быть пустой.').max(160, 'В одной фразе не больше 160 символов.'))
  .min(2, 'Нужно минимум 2 фразы.').max(20, 'Можно сохранить не больше 20 фраз.')
  .refine(values => new Set(values).size === values.length, 'Фразы не должны повторяться.');
const role = z.object({ description: z.string().trim().min(1, 'Описание характера не должно быть пустым.').max(2500, 'В описании не больше 2500 символов.'), events: z.record(z.enum(PERSONA_EVENTS), phrases) }).strict();
const roleId = z.enum(['marlow', 'wren']);
const update = role.extend({ agentId: roleId, revision: z.string().min(1).max(64) }).strict();
export const PersonasFile = z.object({ version: z.literal(1), minIntervalSeconds: z.number().int().min(1).max(600),
  roles: z.object({ marlow: role, wren: role }).strict() }).strict();

const neutral: Record<PersonaEvent, string[]> = {
  task_started: ['Приступаю к задаче.', 'Начинаю работу.'],
  task_finished: ['Моя работа завершена.', 'Результат готов к проверке.'],
  error: ['Возникла ошибка. Нужна проверка.', 'Есть проблема; успешного результата пока нет.'],
  review_started: ['Начинаю ревью.', 'Проверяю изменения.'],
  review_pass: ['Ревью пройдено.', 'Изменения прошли проверку.'],
  review_changes: ['Нужны исправления.', 'Передаю замечания по изменениям.'],
  question: ['Нужен твой ответ.', 'Есть вопрос к тебе.'],
  pause: ['Работа приостановлена.', 'Пауза подтверждена.'],
  stop: ['Работа остановлена.', 'Остановка подтверждена.'],
  rest: ['Сейчас отдыхаю.', 'Небольшой перерыв.'],
  dance: ['Танцую под музыку.', 'Музыка зовёт двигаться.'],
  peer: ['Рад видеть коллегу рядом.', 'Отдыхаем вместе.'],
};
const fallback = { version: 1 as const, minIntervalSeconds: 20, roles: {
  marlow: { description: 'Разработчик.', events: neutral }, wren: { description: 'Ревьюер.', events: neutral },
} };

/** Bubble phrases stay transient; the configured description is exposed separately for game replies. */
export class PersonaSpeech {
  private config = fallback;
  private loaded?: string;
  private warning?: string;
  private last = new Map<PersonaRole, { at: number; text: string }>();
  constructor(private options: { file: string; now: () => number; emit: (message: Outbound) => void;
    warn: (message: string) => void; random?: () => number }) { this.reload(); }

  private reload() {
    try {
      if (fs.statSync(this.options.file).size > 128_000) throw new Error('size');
      const contents = fs.readFileSync(this.options.file, 'utf8').replace(/^\uFEFF/, '');
      if (contents === this.loaded) return;
      this.config = PersonasFile.parse(JSON.parse(contents));
      this.loaded = contents; this.warning = undefined;
    } catch (error) {
      this.config = fallback; this.loaded = undefined;
      const reason = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'отсутствует' : 'некорректен или недоступен';
      if (this.warning !== reason) this.options.warn(`personas.json ${reason}. Используются нейтральные реплики; проверь файл в профиле моста.`);
      this.warning = reason;
    }
  }

  description(agentId: PersonaRole): string | undefined {
    this.reload();
    // A missing/broken profile keeps the legacy conversational prompt, not a fallback persona.
    return this.loaded === undefined ? undefined : this.config.roles[agentId].description;
  }

  /** Read separately from the neutral runtime fallback: a damaged file must never be overwritten. */
  private editable() {
    let raw: string;
    try {
      if (fs.statSync(this.options.file).size > 128_000) throw new Error('size');
      raw = fs.readFileSync(this.options.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { config: structuredClone(fallback), revision: 'missing' };
      throw new Error('Не удалось прочитать personas.json. Проверь доступ и размер файла (до 128 КБ).');
    }
    try {
      return { config: PersonasFile.parse(JSON.parse(raw.replace(/^\uFEFF/, ''))), revision: createHash('sha256').update(raw).digest('hex') };
    } catch { throw new Error('personas.json повреждён. Исправь файл в профиле моста; редактор не будет его заменять.'); }
  }

  edit(agentId: unknown) {
    const id = roleId.safeParse(agentId);
    if (!id.success) throw new Error('Выбери агента Codex или Claude.');
    const { config, revision } = this.editable();
    return { agentId: id.data, revision, ...config.roles[id.data],
      notice: revision === 'missing' ? 'Файла пока нет. Сохранение создаст профиль с нейтральными фразами.' : '' };
  }

  saveEdit(payload: unknown) {
    const parsed = update.safeParse(payload);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      const field = issue.path[0] === 'description' ? 'Характер'
        : issue.path[0] === 'events' ? eventTitles[issue.path[1] as PersonaEvent] ?? 'Фразы'
        : issue.path[0] === 'agentId' ? 'Агент' : 'Профиль';
      const detail = ['description', 'events'].includes(String(issue.path[0])) && ['too_small', 'too_big', 'custom'].includes(issue.code)
        ? issue.message : 'Проверь описание, список событий и формат фраз.';
      throw new Error(`${field ? field + ': ' : ''}${detail}`);
    }
    const { agentId, revision, description, events } = parsed.data;
    const current = this.editable();
    if (revision !== current.revision) throw new Error('Профиль изменился. Скопируй черновик и нажми «Перечитать», затем повтори правки.');
    current.config.roles[agentId] = { description, events };
    const contents = JSON.stringify(current.config, null, 2) + '\n';
    if (Buffer.byteLength(contents, 'utf8') > 128_000) throw new Error('Профиль больше 128 КБ. Сократи описание или списки фраз.');
    try { writeFileAtomic(this.options.file, contents); }
    catch { throw new Error('Не удалось сохранить personas.json. Проверь доступ к папке; черновик можно отправить повторно.'); }
    this.reload(); // Keep cooldowns; the next eligible real event uses the new pool.
    return this.edit(agentId);
  }

  say(agentId: string, event: PersonaEvent, peerAgentId?: string): boolean {
    if (agentId !== 'marlow' && agentId !== 'wren') return false;
    if (event === 'peer' && (!peerAgentId || peerAgentId === agentId)) return false;
    this.reload();
    const now = this.options.now(), last = this.last.get(agentId);
    if (last && now - last.at < this.config.minIntervalSeconds * 1000) return false;
    const choices = this.config.roles[agentId].events[event].filter(text => text !== last?.text);
    const sample = (this.options.random ?? Math.random)();
    const index = Number.isFinite(sample) ? Math.max(0, Math.min(choices.length - 1, Math.floor(sample * choices.length))) : 0;
    const text = choices[index]!;
    this.last.set(agentId, { at: now, text });
    this.options.emit({ type: 'agent.say', agentId, text, ts: now, to: event === 'peer' ? peerAgentId! : 'user' });
    return true;
  }
}
