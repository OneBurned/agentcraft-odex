export interface QueueSummaryItem {
  id: string; title: string; stage: string; head?: string; commits: string[]; verdict: string; reason?: string;
}
export interface QueueSummary {
  id: string; startedAt: number; finishedAt: number;
  done: QueueSummaryItem[]; waiting: QueueSummaryItem[]; blocked: QueueSummaryItem[]; cancelled: QueueSummaryItem[]; text: string;
}

/** Stored results only: no model call and no inferred success from an idle provider. */
export function queueSummary(id: string, startedAt: number, finishedAt: number, items: QueueSummaryItem[]): QueueSummary {
  const done = items.filter(i => i.stage === 'done');
  const waiting = items.filter(i => i.stage === 'question');
  const cancelled = items.filter(i => i.stage === 'cancelled');
  const blocked = items.filter(i => !['done', 'question', 'cancelled'].includes(i.stage));
  const rows = (values: QueueSummaryItem[], details: (i: QueueSummaryItem) => string) =>
    values.length ? values.map(i => `${i.id} · ${i.title}\n${details(i)}`).join('\n\n') : 'Нет';
  const text = `Сводка очереди · ${new Date(finishedAt).toLocaleString('ru-RU')}\n\nГотово (${done.length})\n` +
    rows(done, i => `Коммиты: ${i.commits.join(', ') || i.head || 'не записаны'}\nВердикт: ${i.verdict}`) +
    `\n\nЖдёт пользователя (${waiting.length})\n` + rows(waiting, i => i.reason || 'Нужен ответ в карточке задачи.') +
    `\n\nЗаблокировано (${blocked.length})\n` + rows(blocked, i => i.reason || 'Нет подходящего исполнителя или назначения.') +
    `\n\nОтменено (${cancelled.length})\n` + rows(cancelled, () => 'Отменено пользователем.') +
    '\n\nПроход завершён. Ответь на вопросы и нажми «Запуск очереди», чтобы продолжить. Новые задачи и дополнительные права не согласованы.';
  return { id, startedAt, finishedAt, done, waiting, blocked, cancelled, text };
}
