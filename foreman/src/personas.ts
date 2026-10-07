import fs from 'node:fs';
import { z } from 'zod';
import type { Outbound } from './protocol.js';

export const PERSONA_EVENTS = ['task_started', 'task_finished', 'error', 'review_started', 'review_pass',
  'review_changes', 'question', 'pause', 'stop', 'rest', 'dance', 'peer'] as const;
export type PersonaEvent = typeof PERSONA_EVENTS[number];
export type PersonaRole = 'marlow' | 'wren';
const phrases = z.array(z.string().trim().min(1).max(160)).min(2).max(20)
  .refine(values => new Set(values).size === values.length, 'phrases must be distinct');
const role = z.object({ description: z.string().trim().min(1).max(2500), events: z.record(z.enum(PERSONA_EVENTS), phrases) }).strict();
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

/** Presentation only. Never writes to conversation history, agent logs, memory or model prompts. */
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

  say(agentId: string, event: PersonaEvent): boolean {
    if (agentId !== 'marlow' && agentId !== 'wren') return false;
    this.reload();
    const now = this.options.now(), last = this.last.get(agentId);
    if (last && now - last.at < this.config.minIntervalSeconds * 1000) return false;
    const choices = this.config.roles[agentId].events[event].filter(text => text !== last?.text);
    const sample = (this.options.random ?? Math.random)();
    const index = Number.isFinite(sample) ? Math.max(0, Math.min(choices.length - 1, Math.floor(sample * choices.length))) : 0;
    const text = choices[index]!;
    this.last.set(agentId, { at: now, text });
    this.options.emit({ type: 'agent.say', agentId, text, ts: now, to: event === 'peer' ? agentId === 'marlow' ? 'wren' : 'marlow' : 'user' });
    return true;
  }
}
