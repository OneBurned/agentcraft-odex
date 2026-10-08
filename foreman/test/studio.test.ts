import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Studio } from '../src/studio.js';
import { ClaudeReviewer, cleanHead, gitText, type ReviewResult, type Reviewer } from '../src/studio-review.js';
import { demoRepo, makeForeman, rmrf, tempDir, until } from './helpers.js';
import type { DialogRunner } from '../src/claude-dialog.js';
import { ReviewProgress, parseServerMessage } from '../src/protocol.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(reviewMode: 'auto' | 'manual' | 'off' = 'off') {
  const home = tempDir('ac-studio-'); const repo = await demoRepo();
  const h = makeForeman(home, ['--backend', 'observer']); await h.fm.repos.add(repo);
  const send = vi.fn(async (_text: string, _purpose?: 'message' | 'task') => ({})); const control = vi.fn(async () => ({}));
  const run = vi.fn<Reviewer['run']>(async () => ({ verdict: 'pass', summary: 'Проверено' }));
  const stop = vi.fn(async () => {});
  const dialogRun = vi.fn<DialogRunner['run']>(async () => 'Ответ Клавы');
  const dialogStop = vi.fn(async () => {});
  const dialog: DialogRunner = { run: dialogRun, stop: dialogStop };
  const studio = new Studio(h.fm, { send, control }, { run, stop }, dialog);
  studio.data.reviewMode = reviewMode; studio.data.profiles[1]!.enabled = true;
  // Executable discovery is independent of the injected fake reviewer; no model runs in tests.
  studio.data.claudePath = process.execPath;
  studio.onActivity({ key: 'bound/turn-1', phase: 'completed' });
  cleanups.push(async () => { studio.stop(); await h.fm.close(); rmrf(home); rmrf(path.dirname(repo)); });
  const create = async (title = 'Задача', deps: string[] = []) => {
    await studio.action('create', { title, description: 'Изменить поведение', expected: 'Проверенный результат', deps });
    return studio.data.items.at(-1)!;
  };
  const start = async () => { const i = await create(); await studio.action('approve', { id: i.id }); await studio.action('start', {}); return i; };
  return { ...h, repo, studio, send, control, run, stop, dialog, dialogRun, dialogStop, create, start };
}

describe('personal agent controls and dialog', () => {
  it('routes persona reads/saves through studio.action without dispatching tasks or modifying the roster', async () => {
    const h = await setup(); const before = JSON.stringify(h.studio.data.profiles);
    const loaded = await h.studio.action('persona.get', { agentId: 'wren' });
    const { notice, ...payload } = loaded;
    const result = await h.studio.action('persona.save', { ...payload, description: 'Новый характер ревьюера' });
    expect(result.description).toBe('Новый характер ревьюера');
    expect(h.fm.personas?.description('wren')).toBe('Новый характер ревьюера');
    await expect(h.studio.action('persona.save', { ...payload, description: '' })).rejects.toThrow('пустым');
    expect((await h.studio.action('persona.get', { agentId: 'wren' })).description).toBe('Новый характер ревьюера');
    expect(JSON.stringify(h.studio.data.profiles)).toBe(before); expect(h.send).not.toHaveBeenCalled(); expect(h.run).not.toHaveBeenCalled();
  });
  it('puts the reviewer description in game dialog and shared request, with neutral artifacts in dispatched tasks', async () => {
    const h = await setup();
    const config = JSON.parse(fs.readFileSync(new URL('../../tools/templates/personas.json', import.meta.url), 'utf8'));
    config.roles.wren.description = 'Unique reviewer manner'; config.roles.marlow.description = 'Unique developer manner';
    fs.writeFileSync(path.join(h.fm.config.dataDir, 'personas.json'), JSON.stringify(config));
    await h.studio.messageClaude('Обсудим план');
    await until(() => h.studio.data.dialog!.history.length === 2);
    const [prompt, , request] = h.dialogRun.mock.calls[0]!;
    expect(prompt).toContain('Unique reviewer manner'); expect(prompt).not.toContain('Unique developer manner');
    expect(request?.style).toContain('Unique reviewer manner'); expect(request?.text).toBe('Обсудим план');
    expect(request?.style).toContain('откровенных сексуальных сцен нет');
    expect(prompt).not.toContain(config.roles.wren.events.rest[0]);
    await h.start();
    const [task, purpose] = h.send.mock.calls[0]!;
    expect(purpose).toBe('task'); expect(task).toContain('Не переноси характер в артефакты');
    for (const word of ['код', 'комментарии', 'коммиты', 'документация', 'report', 'release notes', 'JSON verdict/summary', 'нейтральными и деловыми'])
      expect(task).toContain(word);
    expect(task).not.toContain('Unique reviewer manner'); expect(task).not.toContain('Unique developer manner');
  });
  it('keeps legacy dialog without a persona profile', async () => {
    const h = await setup(); await h.studio.messageClaude('Привет');
    expect(h.dialogRun.mock.calls[0]![0]).not.toContain('Описание характера');
    expect(h.dialogRun.mock.calls[0]![2]?.style).toBe('');
  });
  it('shows the actual message restriction and re-enables the Claude card after it clears', async () => {
    const h = await setup();
    h.dialog.externalStatus = () => 'Общий разговор открыт в терминале';
    h.studio.publishControls();
    expect(h.fm.requireAgent('wren').controls).toMatchObject({ message: false, hint: 'Общий разговор открыт в терминале' });
    await expect(h.studio.messageClaude('Привет')).rejects.toThrow('терминале');
    h.dialog.externalStatus = () => undefined;
    h.fm.setAgent('wren', { paused: true }); h.studio.publishControls();
    expect(h.fm.requireAgent('wren').controls).toMatchObject({ message: false, hint: expect.stringContaining('на паузе') });
    h.fm.setAgent('wren', { paused: false });
    h.dialogRun.mockImplementation(() => new Promise(() => {}));
    await h.studio.messageClaude('Привет'); h.studio.publishControls();
    expect(h.fm.requireAgent('wren').controls).toMatchObject({ message: false, hint: expect.stringContaining('занята') });
    await h.studio.controlAgent('wren', 'stop'); h.studio.publishControls();
    expect(h.fm.requireAgent('wren').controls?.message).toBe(true);
  });
  it('continues a non-head agent question with the supplied text without creating another question', async () => {
    const h = await setup();
    const older = h.fm.createDecision({ agentId: 'wren', kind: 'question', question: 'Первый вопрос', options: ['Да'] });
    const i = await h.start();
    await h.studio.action('report', { id: i.id, run: i.run, status: 'question', summary: 'Как исправить?' });
    const d = h.fm.decisions.open().find(q => q.taskId === i.id)!;
    expect(h.fm.decisions.open()[0]!.id).toBe(older.id);
    const answer = h.fm.decisions.answer(d.id, 'Продолжить с ответом', 'Добавь поле для текста');
    h.studio.onDecision(answer); await h.studio.action('get', {});
    expect(i.stage).toBe('queued'); expect(i.review).toContain('Добавь поле для текста');
    expect(h.fm.decisions.open().map(q => q.id)).toEqual([older.id]);
    await h.studio.pump();
    expect(h.send.mock.calls.at(-1)![0]).toContain('Добавь поле для текста');
  });
  it('never emits completion for a failed check or a stale successful report', async () => {
    const h = await setup(); const i = await h.start();
    const speech = vi.spyOn(h.fm.personas!, 'say');
    await expect(h.studio.action('report', { id: i.id, run: i.run, status: 'done', summary: 'Not ready', checks: 'failed', ci: 'fail' })).rejects.toThrow();
    expect(speech.mock.calls).toEqual([['marlow', 'error']]);
    await expect(h.studio.action('report', { id: i.id, run: 'obsolete', status: 'done', summary: 'Old result', checks: 'passed', ci: 'pass' })).rejects.toThrow();
    expect(speech.mock.calls).toEqual([['marlow', 'error']]);
    expect(i.stage).toBe('coding');
  });
  it('emits failure instead of a successful verdict when review execution rejects', async () => {
    const h = await setup('auto'); h.run.mockRejectedValue(new Error('Review failed'));
    const i = await h.start();
    await h.studio.action('report', { id: i.id, run: i.run, status: 'done', summary: 'ready', checks: 'tests', ci: 'pass' });
    const speech = vi.spyOn(h.fm.personas!, 'say');
    await h.studio.pump(); await until(() => i.stage === 'question');
    expect(speech.mock.calls).toEqual([['wren', 'review_started'], ['wren', 'error'], ['wren', 'question']]);
    expect(i.review).toBeUndefined();
  });
  it('rejects automatic replies to unavailable Codex without sending, but accepts when ready', async () => {
    const h = await setup();
    h.studio.data.profiles[0]!.enabled = false;
    await expect(h.studio.replyCodex('Текст')).rejects.toThrow('выключен');
    h.studio.data.profiles[0]!.enabled = true;
    h.fm.setAgent('marlow', { paused: true });
    await expect(h.studio.replyCodex('Текст')).rejects.toThrow('паузе');
    h.fm.setAgent('marlow', { paused: false });
    for (const phase of ['working', 'waiting', 'unavailable', 'paused'] as const) {
      h.studio.onActivity({ key: 'bound/turn-1', phase });
      await expect(h.studio.replyCodex('Текст')).rejects.toThrow();
    }
    expect(h.send).not.toHaveBeenCalled(); expect(h.dialogRun).not.toHaveBeenCalled();
    h.studio.onActivity({ key: 'bound/turn-1', phase: 'completed' });
    await h.studio.replyCodex('Ответ\nцеликом');
    expect(h.send).toHaveBeenCalledExactlyOnceWith('Ответ\nцеликом');
  });
  it('refuses unavailable Claude without sending the reply to Codex', async () => {
    const h = await setup();
    h.studio.data.profiles[1]!.enabled = false;
    await expect(h.studio.messageClaude('Текст')).rejects.toThrow('Включи');
    h.studio.data.profiles[1]!.enabled = true;
    h.fm.setAgent('wren', { paused: true });
    await expect(h.studio.messageClaude('Текст')).rejects.toThrow('паузу');
    h.fm.setAgent('wren', { paused: false });
    h.studio.data.dialog!.pending = 'Предыдущий вопрос';
    await expect(h.studio.messageClaude('Текст')).rejects.toThrow('занята');
    expect(h.send).not.toHaveBeenCalled(); expect(h.dialogRun).not.toHaveBeenCalled();
    expect(h.studio.data.dialog!.pending).toBe('Предыдущий вопрос');
  });
  it('does not mistake an old partial reply for completion when a paused conversation returns from the terminal', async () => {
    const h = await setup(); let external: string | undefined;
    const history = [{ id: '1', role: 'user' as const, text: 'Вопрос' }, { id: '2', role: 'assistant' as const, text: 'Незаконченный ответ' }];
    h.dialog.shared = () => 'session'; h.dialog.history = async () => history; h.dialog.externalStatus = () => external;
    await h.studio.pump(); h.studio.data.dialog!.pending = 'Вопрос'; h.studio.data.personalPaused = ['wren'];
    external = 'Клава в терминале'; await h.studio.pump(); external = undefined;
    (h.studio as unknown as { historyChecked: number }).historyChecked = 0; await h.studio.pump();
    expect(h.studio.data.dialog!.pending).toBe('Вопрос'); expect(h.studio.data.personalPaused).toContain('wren');
    external = 'Клава в терминале'; await h.studio.pump(); history.push({ id: '3', role: 'assistant', text: 'Завершено в терминале' }); external = undefined;
    (h.studio as unknown as { historyChecked: number }).historyChecked = 0; await h.studio.pump();
    expect(h.studio.data.dialog!.pending).toBeUndefined(); expect(h.studio.data.personalPaused).not.toContain('wren');
  });
  it('blocks game messages and real controls while the shared conversation belongs to the terminal', async () => {
    const h = await setup(); h.dialog.externalStatus = () => 'Клава в терминале';
    h.studio.publishControls(); expect(h.fm.requireAgent('wren').controls).toMatchObject({ message: false, pause: false, resume: false, stop: false, hint: 'Клава в терминале' });
    await expect(h.studio.messageClaude('Привет')).rejects.toThrow('терминале');
    await expect(h.studio.controlAgent('wren', 'stop')).rejects.toThrow('терминале');
    expect(h.dialogRun).not.toHaveBeenCalled(); expect(h.dialogStop).not.toHaveBeenCalled();
    expect(h.studio.data.dialog!.pending).toBeUndefined();
  });
  it('projects terminal history once and resumes the same session after a bridge restart', async () => {
    const h = await setup(); const history = [{ id: '1', role: 'user' as const, text: 'Старое' }, { id: '2', role: 'assistant' as const, text: 'Старый ответ' }];
    h.dialog.shared = () => 'session'; h.dialog.history = async () => history;
    await h.studio.pump(); expect(h.studio.data.dialog!.sessionCursor).toBe('2');
    const feed = vi.spyOn(h.fm.bus, 'feed');
    history.push({ id: '3', role: 'user', text: 'В терминале' }, { id: '4', role: 'assistant', text: 'Из терминала' });
    // Force the regular projection interval without a wall-clock delay.
    (h.studio as unknown as { historyChecked: number }).historyChecked = 0;
    await h.studio.pump();
    expect(feed.mock.calls.filter(c => c[1] === 'Из терминала')).toHaveLength(1);
    expect(h.studio.data.dialog!.sessionCursor).toBe('4');
    const next = new Studio(h.fm, { send: h.send, control: h.control }, { run: h.run }, h.dialog);
    await next.pump(); next.stop();
    expect(feed.mock.calls.filter(c => c[1] === 'Из терминала')).toHaveLength(1);
  });
  it('clears an idle legacy pause without sending work or starting the queue', async () => {
    const h = await setup(); const draft = await h.create();
    h.fm.setAgent('wren', { paused: true }); h.fm.setAgent('marlow', { paused: true });
    await h.studio.controlAgent('wren', 'resume'); await h.studio.controlAgent('marlow', 'resume');
    expect(h.fm.requireAgent('wren').paused).toBe(false); expect(h.fm.requireAgent('marlow').paused).toBe(false);
    expect(h.studio.data.mode).toBe('planning'); expect(draft.stage).toBe('plan');
    expect(h.send).not.toHaveBeenCalled(); expect(h.control).not.toHaveBeenCalled(); expect(h.run).not.toHaveBeenCalled();
  });
  it('never interrupts Codex from an idle Claude card', async () => {
    const h = await setup(); const i = await h.start();
    for (const action of ['pause', 'resume', 'stop'] as const) await h.studio.controlAgent('wren', action);
    expect(h.studio.data.active).toBe(i.id); expect(i.stage).toBe('coding');
    expect(h.control).not.toHaveBeenCalled(); expect(h.send).toHaveBeenCalledTimes(1);
  });
  it('resumes exactly the paused coding task, not a higher-priority queued task', async () => {
    const h = await setup(); const first = await h.start(); const originalRun = first.run;
    await h.studio.controlAgent('marlow', 'pause');
    const second = await h.create('Другая задача'); await h.studio.action('approve', { id: second.id });
    h.fm.tasks.update(second.id, { priority: 100 });
    await h.studio.controlAgent('marlow', 'resume');
    expect(h.studio.data.active).toBe(first.id); expect(first.run).not.toBe(originalRun);
    expect(second.stage).toBe('queued'); expect(h.studio.data.mode).toBe('paused');
    expect(h.send.mock.calls[1]![0]).toContain(`задачу ${first.id}`);
  });
  it('resumes only the suspended review and does not launch other queue tasks', async () => {
    const h = await setup('auto'); let finish!: (r: ReviewResult) => void;
    h.run.mockImplementation(() => new Promise(r => { finish = r; })); const i = await h.start();
    await h.studio.action('report', { id: i.id, run: i.run, status: 'done', summary: 'ready', checks: 'tests', ci: 'pass' });
    await h.studio.pump();
    await h.studio.controlAgent('marlow', 'stop');
    expect(h.studio.data.active).toBe(i.id); expect(h.stop).not.toHaveBeenCalled();
    await h.studio.controlAgent('wren', 'pause'); expect(h.stop).toHaveBeenCalledOnce();
    finish({ verdict: 'pass', summary: 'Old result' }); await h.studio.action('get', {});
    expect(i.stage).toBe('review');
    await h.studio.controlAgent('wren', 'resume'); expect(h.run).toHaveBeenCalledTimes(2);
    finish({ verdict: 'pass', summary: 'Reviewed again' }); await until(() => i.stage === 'done');
    expect(h.control).not.toHaveBeenCalled(); expect(h.studio.data.mode).toBe('paused');
  });
  it('keeps the owned review active when real process stop is unconfirmed', async () => {
    const h = await setup('auto'); h.run.mockImplementation(() => new Promise(() => {}));
    const i = await h.start(); await h.studio.action('report', { id: i.id, run: i.run, status: 'done', summary: 'ready', checks: 'tests', ci: 'pass' });
    await h.studio.pump(); h.stop.mockRejectedValueOnce(new Error('Still running'));
    await expect(h.studio.controlAgent('wren', 'pause')).rejects.toThrow('Still running');
    expect(h.studio.data.active).toBe(i.id); expect(h.fm.requireAgent('wren').paused).toBe(false);
  });
  it('sends Claude a separate contextual conversation and publishes her own reply', async () => {
    const h = await setup(); await h.create('Планируемая задача');
    await h.studio.messageClaude('Привет, обсудим план');
    await until(() => h.studio.data.dialog!.history.length === 2);
    expect(h.dialogRun.mock.calls[0]![0]).toContain('Планируемая задача');
    expect(h.dialogRun.mock.calls[0]![0]).toContain('Привет, обсудим план');
    expect(h.studio.data.dialog!.history[1]).toEqual({ role: 'assistant', text: 'Ответ Клавы' });
    expect(h.fm.requireAgent('wren')).toMatchObject({ state: 'done', paused: false });
    expect(h.events.some(e => e.type === 'feed.add' && JSON.stringify(e).includes('Ответ Клавы'))).toBe(true);
    expect(h.send).not.toHaveBeenCalled(); expect(h.run).not.toHaveBeenCalled();
  });
  it('keeps paused dialog context, ignores late output and resumes only that reply', async () => {
    const h = await setup(); let finish!: (s: string) => void;
    h.dialogRun.mockImplementation(() => new Promise(r => { finish = r; }));
    await h.studio.messageClaude('Вопрос');
    await expect(h.studio.messageClaude('Ещё вопрос')).rejects.toThrow('занята');
    await h.studio.controlAgent('wren', 'pause');
    expect(h.dialogStop).toHaveBeenCalledOnce(); expect(h.fm.requireAgent('wren').paused).toBe(true);
    finish('Поздний ответ'); await h.studio.action('get', {});
    expect(h.studio.data.dialog!.history).toHaveLength(1);
    await h.studio.controlAgent('wren', 'resume');
    expect(h.dialogRun).toHaveBeenCalledTimes(2); expect(h.send).not.toHaveBeenCalled();
    finish('Новый ответ'); await until(() => h.studio.data.dialog!.history.length === 2);
    expect(h.studio.data.dialog!.history[1]!.text).toBe('Новый ответ');
    expect(h.studio.data.mode).toBe('planning');
  });
  it('does not claim a conversation pause when process exit is not confirmed', async () => {
    const h = await setup(); h.dialogRun.mockImplementation(() => new Promise(() => {}));
    await h.studio.messageClaude('Вопрос'); h.dialogStop.mockRejectedValueOnce(new Error('Still running'));
    await expect(h.studio.controlAgent('wren', 'pause')).rejects.toThrow('Still running');
    expect(h.fm.requireAgent('wren').paused).toBe(false);
    expect(h.fm.requireAgent('wren').controls?.pause).toBe(true);
  });
  it('stop clears pending reply but preserves history; idle resume does not resend', async () => {
    const h = await setup(); h.dialogRun.mockImplementation(() => new Promise(() => {}));
    await h.studio.messageClaude('Вопрос'); await h.studio.controlAgent('wren', 'stop');
    expect(h.studio.data.dialog!.pending).toBeUndefined(); expect(h.studio.data.dialog!.history).toHaveLength(1);
    await h.studio.controlAgent('wren', 'resume'); expect(h.dialogRun).toHaveBeenCalledOnce();
    expect(h.fm.requireAgent('wren').controls).toMatchObject({ message: true, pause: false, stop: false });
  });
  it('planning without active work never puts the idle reviewer on a phantom pause', async () => {
    const h = await setup(); await h.studio.action('plan', {});
    expect(h.fm.requireAgent('wren').paused).toBe(false);
    expect(h.fm.requireAgent('wren').controls).toMatchObject({ pause: false, resume: false, stop: false });
  });
  it('disables resume for owned queued work while another desktop turn is busy', async () => {
    const h = await setup(); await h.start(); await h.studio.controlAgent('marlow', 'pause');
    h.studio.onActivity({ key: 'bound/other', phase: 'working' });
    expect(h.fm.requireAgent('marlow').controls?.resume).toBe(false);
    h.studio.onActivity({ key: 'bound/other', phase: 'completed' });
    expect(h.fm.requireAgent('marlow').controls?.resume).toBe(true);
  });
  it('restores an interrupted conversation paused and never replays it automatically', async () => {
    const h = await setup(); h.dialogRun.mockImplementation(() => new Promise(() => {}));
    await h.studio.messageClaude('Запомни вопрос'); h.studio.stop();
    const next = new Studio(h.fm, { send: h.send, control: h.control }, { run: h.run }, { run: h.dialogRun, stop: h.dialogStop });
    cleanups.push(async () => next.stop()); next.start(); await next.pump();
    expect(h.fm.requireAgent('wren').paused).toBe(true); expect(h.dialogRun).toHaveBeenCalledOnce();
    expect(next.data.dialog!.pending).toBe('Запомни вопрос');
  });
});
describe('command desk queue', () => {
  it('keeps drafts on the board without sending work, then starts only approved tasks', async () => {
    const h = await setup(); const i = await h.create();
    expect(h.fm.tasks.require(i.id).queueStage).toBe('plan');
    await h.studio.action('start', {}); expect(h.send).not.toHaveBeenCalled();
    await h.studio.action('approve', { id: i.id }); await h.studio.pump();
    expect(h.send).toHaveBeenCalledTimes(1); expect(h.send.mock.calls[0]![0]).toContain(i.run);
    await h.studio.pump(); expect(h.send).toHaveBeenCalledTimes(1);
  });
  it('validates dependencies before creating and waits for them before starting', async () => {
    const h = await setup(); const a = await h.create('A'); const b = await h.create('B', [a.id]);
    await h.studio.action('approve', { id: b.id }); await h.studio.action('start', {});
    expect(h.send).not.toHaveBeenCalled();
    await expect(h.create('C', ['missing'])).rejects.toThrow();
    expect(h.studio.data.items).toHaveLength(2);
  });
  it('does not start into a busy/unavailable chat or dirty repository', async () => {
    const h = await setup(); const i = await h.create(); await h.studio.action('approve', { id: i.id });
    h.studio.onActivity({ key: 'bound/turn', phase: 'working' }); await expect(h.studio.action('start', {})).rejects.toThrow();
    h.studio.onActivity({ key: 'bound/turn', phase: 'completed' }); fs.writeFileSync(path.join(h.repo, 'uncommitted.txt'), 'dirty');
    await expect(h.studio.action('start', {})).rejects.toThrow('Git'); expect(h.send).not.toHaveBeenCalled();
  });
  it('requires run correlation and successful checks, not merely a completed chat', async () => {
    const h = await setup(); const i = await h.start();
    h.studio.onActivity({ key: 'bound/new', phase: 'completed' }); await h.studio.pump(); expect(i.stage).toBe('coding');
    await expect(h.studio.action('report', { id: i.id, run: 'old', status: 'done', summary: 'done', checks: 'tests', ci: 'pass' })).rejects.toThrow('активен');
    await expect(h.studio.action('report', { id: i.id, run: i.run, status: 'done', summary: 'done', ci: 'fail' })).rejects.toThrow('проверки');
    await h.studio.action('report', { id: i.id, run: i.run, status: 'done', summary: 'done', checks: 'unit tests', ci: 'pass' });
    expect(i.stage).toBe('done');
  });
  it('asks a real question and lets independent approved work proceed', async () => {
    const h = await setup(); const i = await h.start(); const b = await h.create('B'); await h.studio.action('approve', { id: b.id });
    await h.studio.action('report', { id: i.id, run: i.run, status: 'question', summary: 'Какой цвет?' });
    expect(h.fm.decisions.open()).toHaveLength(1); expect(h.fm.requireAgent('marlow').station).toBe('user');
    await h.studio.pump(); expect(h.studio.data.active).toBe(b.id);
    const d = h.fm.decisions.open()[0]!;
    h.studio.onDecision({ ...d, status: 'answered', answer: { text: 'Синий', ts: Date.now() } });
    await h.studio.action('get', {}); expect(i.stage).toBe('queued'); expect(h.studio.data.active).toBe(b.id);
  });
  it('pauses real work, rejects late completion, resumes without erasing edits', async () => {
    const h = await setup(); const i = await h.start(); const oldRun = i.run;
    h.studio.onActivity({ key: 'bound/new', phase: 'working' });
    fs.writeFileSync(path.join(h.repo, 'ongoing.txt'), 'unfinished');
    await h.studio.action('pause', {}); expect(h.control).toHaveBeenCalledWith('pause'); expect(i.stage).toBe('queued');
    await expect(h.studio.action('report', { id: i.id, run: oldRun, status: 'done', summary: 'late', checks: 'tests', ci: 'pass' })).rejects.toThrow();
    h.studio.onActivity({ key: 'bound/new', phase: 'paused' }); await h.studio.action('start', {});
    expect(i.run).not.toBe(oldRun); expect(fs.readFileSync(path.join(h.repo, 'ongoing.txt'), 'utf8')).toBe('unfinished');
  });
  it('preserves active task on failed real interruption instead of claiming success', async () => {
    const h = await setup(); const i = await h.start(); h.studio.onActivity({ key: 'bound/new', phase: 'working' });
    h.control.mockRejectedValueOnce(new Error('Not stopped'));
    await expect(h.studio.action('pause', {})).rejects.toThrow('Not stopped'); expect(h.studio.data.active).toBe(i.id);
  });
  it.each(['pause', 'plan'])('keeps A review ranges separate when %s lets higher-priority B run first', async action => {
    const h = await setup('auto'); const a = await h.start(); const base = await cleanHead(h.repo);
    const commit = async (name: string) => {
      fs.writeFileSync(path.join(h.repo, name), name); await gitText(h.repo, ['add', name]);
      await gitText(h.repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', name]);
      return cleanHead(h.repo);
    };
    const a1 = await commit('A1.txt'); await h.studio.action(action, {});
    expect(a.ranges).toEqual([{ base, head: a1 }]); expect(a.base).toBeUndefined();
    const b = await h.create('B'); h.fm.tasks.update(b.id, { priority: 100 });
    await h.studio.action('approve', { id: b.id }); await h.studio.action('start', {});
    expect(h.studio.data.active).toBe(b.id);
    const b1 = await commit('B.txt');
    await h.studio.action('report', { id: b.id, run: b.run, status: 'done', summary: 'B', checks: 'tests', ci: 'pass' });
    await h.studio.pump(); await until(() => b.stage === 'done'); await h.studio.pump();
    expect(h.studio.data.active).toBe(a.id); expect(a.base).toBe(b1);
    const a2 = await commit('A2.txt');
    await h.studio.action('report', { id: a.id, run: a.run, status: 'done', summary: 'A', checks: 'tests', ci: 'pass' });
    await h.studio.pump(); await until(() => a.stage === 'done');
    const review = h.run.mock.calls[1]![0];
    expect(review.ranges).toEqual([{ base, head: a1 }, { base: b1, head: a2 }]);
    const commits = await Promise.all(review.ranges!.map(r => gitText(h.repo, ['rev-list', `${r.base}..${r.head}`])));
    expect(commits).toEqual([a1, a2]); expect(commits).not.toContain(b1);
  });
  it('Start resumes dirty suspended A before higher-priority B, with no cleanHead retry loop', async () => {
    const h = await setup(); const a = await h.start(); const oldRun = a.run;
    fs.writeFileSync(path.join(h.repo, 'A.txt'), 'unfinished A');
    await h.studio.controlAgent('marlow', 'pause');
    const b = await h.create('B'); h.fm.tasks.update(b.id, { priority: 100 });
    await h.studio.action('approve', { id: b.id }); await h.studio.action('start', {});
    expect(h.studio.data.active).toBe(a.id); expect(a.run).not.toBe(oldRun);
    expect(h.studio.data.suspended!.marlow).toBeUndefined(); expect(b.stage).toBe('queued');
    expect(h.studio.data.notice).toContain(a.id);
    expect(fs.readFileSync(path.join(h.repo, 'A.txt'), 'utf8')).toBe('unfinished A');
    await h.studio.pump(); await h.studio.pump(); expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.send.mock.calls[1]![0]).toContain(`задачу ${a.id}`);
    await gitText(h.repo, ['add', 'A.txt']);
    await gitText(h.repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'A']);
    await h.studio.action('report', { id: a.id, run: a.run, status: 'done', summary: 'A', checks: 'tests', ci: 'pass' });
    await h.studio.pump(); expect(h.studio.data.active).toBe(b.id);
  });
  it('captures A edits committed during pause before allowing B to run', async () => {
    const h = await setup(); const a = await h.start(); const base = a.base;
    fs.writeFileSync(path.join(h.repo, 'A.txt'), 'A'); await h.studio.action('pause', {});
    await gitText(h.repo, ['add', 'A.txt']);
    await gitText(h.repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'A']);
    const a1 = await cleanHead(h.repo);
    const b = await h.create('B'); h.fm.tasks.update(b.id, { priority: 100 }); await h.studio.action('approve', { id: b.id });
    await h.studio.action('start', {});
    expect(h.studio.data.active).toBe(b.id); expect(a.base).toBeUndefined();
    expect(a.ranges).toEqual([{ base, head: a1 }]); expect(b.base).toBe(a1);
  });
  it('interrupts even before polling has observed the newly dispatched turn', async () => {
    const h = await setup(); const i = await h.start();
    await h.studio.action('pause', {});
    expect(h.control).toHaveBeenCalledWith('pause'); expect(i.stage).toBe('queued');
  });
  it('does not claim a stop when chat connectivity is lost', async () => {
    const h = await setup(); const i = await h.start();
    const speech = vi.spyOn(h.fm.personas!, 'say');
    h.studio.onActivity({ key: '', phase: 'unavailable' });
    await expect(h.studio.action('stop', {})).rejects.toThrow('не подтверждена');
    expect(h.studio.data.active).toBe(i.id); expect(h.control).not.toHaveBeenCalled();
    expect(speech).not.toHaveBeenCalled();
  });
  it('pauses on a binding change without sending or stopping the unrelated chat', async () => {
    const h = await setup(); const i = await h.start(); const oldRun = i.run;
    h.studio.onActivity({ key: 'different/turn', phase: 'working' }); await h.studio.action('get', {});
    expect(i.stage).toBe('question'); expect(h.studio.data.mode).toBe('paused');
    expect(h.send).toHaveBeenCalledTimes(1); expect(h.control).not.toHaveBeenCalled();
    await expect(h.studio.action('report', { id: i.id, run: oldRun, status: 'done', summary: 'late', checks: 'tests', ci: 'pass' })).rejects.toThrow();
  });
  it('cancels obsolete questions before a retry', async () => {
    const h = await setup(); const i = await h.start();
    await h.studio.action('report', { id: i.id, run: i.run, status: 'question', summary: 'Вопрос' });
    await h.studio.action('retry', { id: i.id }); expect(h.fm.decisions.open()).toHaveLength(0);
  });
  it('bounds task text before creating an undeliverable card', async () => {
    const h = await setup();
    await expect(h.studio.action('create', { title: 'Too long', description: 'x'.repeat(3001), expected: 'ok' })).rejects.toThrow();
    expect(h.studio.data.items).toHaveLength(0);
  });
  it('does not retry unknown delivery automatically', async () => {
    const h = await setup(); h.send.mockRejectedValueOnce(new Error('timeout')); const i = await h.start();
    expect(i.stage).toBe('question'); expect(h.studio.data.mode).toBe('paused'); await h.studio.pump(); expect(h.send).toHaveBeenCalledTimes(1);
  });
  it('reviews the exact commit, saves findings as knowledge, and completes only after pass', async () => {
    const h = await setup('auto'); const i = await h.start(); const head = await cleanHead(h.repo);
    await h.studio.action('report', { id: i.id, run: i.run, status: 'done', summary: 'implemented', checks: 'tests passed', ci: 'pass' });
    expect(i.stage).toBe('review'); await h.studio.pump(); await until(() => i.stage === 'done');
    expect(h.run.mock.calls[0]?.[0]).toMatchObject({ head, base: head }); expect(h.fm.memory.list()).toHaveLength(1);
  });
  it('turns Git buffer overflow into a readable review question without relaunching', async () => {
    const h = await setup('auto'); const i = await h.start();
    fs.writeFileSync(path.join(h.repo, 'large.txt'), 'я'.repeat(1_100_000));
    await gitText(h.repo, ['add', 'large.txt']);
    await gitText(h.repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'Large diff']);
    const reviewer = new ClaudeReviewer(() => process.execPath);
    h.run.mockImplementation((input, signal) => reviewer.run(input, signal));
    await h.studio.action('report', { id: i.id, run: i.run, status: 'done', summary: 'Fixture', checks: 'fixture checks', ci: 'pass' });
    await h.studio.pump(); await until(() => i.stage === 'question');
    expect(h.fm.decisions.open()).toHaveLength(1);
    expect(h.fm.decisions.open()[0]).toMatchObject({ taskId: i.id, question: 'Изменения слишком велики для одного ревью. Раздели задачу.' });
    expect(h.fm.tasks.require(i.id).studioReview).toMatchObject({ phase: 'error', waitingForUser: true, head: i.head });
    expect(h.fm.tasks.require(i.id).studioReview?.verdict).toBeUndefined();
    await h.studio.pump(); expect(h.run).toHaveBeenCalledTimes(1);
    await h.studio.action('cancel', { id: i.id });
    expect(h.fm.tasks.require(i.id).studioReview?.waitingForUser).toBe(false);
  });
  it('manual mode waits for the explicit review button', async () => {
    const h = await setup('manual'); const i = await h.start();
    await h.studio.action('report', { id: i.id, run: i.run, status: 'done', summary: 'implemented', checks: 'tests', ci: 'pass' });
    await h.studio.pump(); expect(h.run).not.toHaveBeenCalled();
    expect(h.fm.tasks.require(i.id).studioReview).toBeUndefined();
    await h.studio.action('review', { id: i.id }); await until(() => i.stage === 'done');
    expect(h.fm.tasks.require(i.id).studioReview).toMatchObject({ phase: 'finished', verdict: 'pass', waitingForUser: false });
  });
  it.each([
    ['pass', 'Принято'], ['changes', 'Нужны исправления'], ['question', 'Нужен ответ'],
  ] as const)('publishes safe review steps and the complete %s verdict in the shared feed', async (verdict, label) => {
    const h = await setup('auto'); const i = await h.start(); const summary = 'Подробное замечание. '.repeat(220) + 'Конец сводки';
    const speech = vi.spyOn(h.fm.personas!, 'say');
    const feed = vi.spyOn(h.fm.bus, 'feed');
    const log = vi.spyOn(h.fm, 'agentLog');
    h.run.mockImplementation(async (_input, _signal, onStep) => {
      const initial = h.fm.tasks.require(i.id).studioReview;
      expect(initial).toMatchObject({ head: _input.head, phase: 'running', step: 'Начинаю проверку', waitingForUser: false });
      expect(initial?.verdict).toBeUndefined();
      onStep?.('Читаю foreman/src/studio.ts (agentcraft)');
      expect(h.fm.tasks.require(i.id).studioReview?.step).toBe('Читаю foreman/src/studio.ts (agentcraft)');
      return { verdict, summary };
    });
    await h.studio.action('report', { id: i.id, run: i.run, status: 'done', summary: 'ready', checks: 'tests', ci: 'pass' });
    await h.studio.pump(); await until(() => i.rounds === 1);
    expect(speech.mock.calls).toEqual([['marlow', 'task_finished'], ['wren', 'review_started'],
      ['wren', verdict === 'question' ? 'question' : verdict === 'pass' ? 'review_pass' : 'review_changes']]);
    const messages = feed.mock.calls.filter(c => c[0] === 'message' && c[2]?.agentId === 'wren').map(c => c[1]);
    expect(messages[0]).toContain(`Ревью ${i.id}: начинаю проверку`);
    expect(messages[1]).toContain('Читаю foreman/src/studio.ts');
    expect(messages[2]).toContain(`Ревью ${i.id}: ${label}`);
    expect(messages.at(-1)).toContain('Конец сводки');
    expect(messages.slice(2).every(m => m.length <= 1900)).toBe(true);
    expect(messages.slice(2).join(' ').split('Подробное замечание.').length - 1).toBe(220);
    expect(log.mock.calls.filter(c => c[0] === 'wren').map(c => c[2])).toEqual(messages);
    const review = h.fm.tasks.require(i.id).studioReview!;
    expect(review).toMatchObject({ head: i.head, phase: 'finished', verdict, waitingForUser: verdict === 'question' });
    expect(review.summary!.length).toBeLessThanOrEqual(600);
    expect(ReviewProgress.safeParse(review).success).toBe(true);
    const snapshot = h.fm.snapshot();
    expect(snapshot.type === 'snapshot' && snapshot.tasks.find(t => t.id === i.id)?.studioReview).toEqual(review);
    expect(parseServerMessage({ v: 2, ...snapshot }).ok).toBe(true);
    const updates = h.events.filter(e => e.type === 'task.upsert' && e.task.id === i.id);
    expect(updates.some(e => e.type === 'task.upsert' && e.task.studioReview?.phase === 'running' && e.task.studioReview?.step.startsWith('Читаю'))).toBe(true);
    expect(updates.at(-1)).toMatchObject({ task: { studioReview: review } });
    if (verdict === 'question') {
      const d = h.fm.decisions.open()[0]!;
      h.studio.onDecision({ ...d, status: 'answered', answer: { text: 'Проверь крайний случай', ts: Date.now() } });
      await h.studio.action('get', {});
      expect(h.fm.tasks.require(i.id).studioReview).toMatchObject({ verdict: 'question', waitingForUser: false });
    }
  });
  it('returns changes to Codex and asks the user after two unsuccessful reviews', async () => {
    const h = await setup('auto'); h.run.mockResolvedValue({ verdict: 'changes', summary: 'Исправить обработку ошибок' }); const i = await h.start();
    for (let n = 0; n < 2; n++) {
      await h.studio.action('report', { id: i.id, run: i.run, status: 'done', summary: 'implemented', checks: 'tests', ci: 'pass' });
      await h.studio.pump(); await until(() => i.stage === (n === 0 ? 'queued' : 'question'));
      expect(h.fm.tasks.require(i.id).studioReview).toMatchObject({ verdict: 'changes', waitingForUser: n === 1 });
      if (n === 0) await h.studio.pump();
    }
    expect(h.fm.decisions.open()).toHaveLength(1); expect(h.send).toHaveBeenCalledTimes(2);
  });
  it.each(['pause', 'stop'])('aborts reviewer on %s and ignores its late verdict', async action => {
    const h = await setup('auto'); let resolve!: (r: ReviewResult) => void; let step: ((s: string) => void) | undefined;
    const speech = vi.spyOn(h.fm.personas!, 'say');
    const feed = vi.spyOn(h.fm.bus, 'feed');
    h.run.mockImplementation((_input, _signal, onStep) => new Promise(r => { resolve = r; step = onStep; })); const i = await h.start();
    await h.studio.action('report', { id: i.id, run: i.run, status: 'done', summary: 'implemented', checks: 'tests', ci: 'pass' });
    await h.studio.pump(); await h.studio.action(action, {}); step?.('late step'); resolve({ verdict: 'pass', summary: 'late' });
    await new Promise(r => setTimeout(r, 15)); expect(i.stage).toBe(action === 'pause' ? 'review' : 'question'); expect(h.studio.data.mode).toBe('paused');
    expect(feed.mock.calls.filter(c => c[2]?.agentId === 'wren').some(c => c[1].includes('late'))).toBe(false);
    expect(speech.mock.calls).toContainEqual(['wren', action]);
    expect(speech.mock.calls).not.toContainEqual(['wren', 'review_pass']);
    expect(h.fm.tasks.require(i.id).studioReview).toMatchObject({ phase: 'paused', waitingForUser: action === 'stop' });
    expect(h.fm.tasks.require(i.id).studioReview?.verdict).toBeUndefined();
    expect(h.fm.tasks.require(i.id).studioReview?.step).not.toContain('late');
  });
  it('publishes manual review steps and marks a persisted running review paused after restart', async () => {
    const h = await setup('manual'); const i = await h.start();
    let step: ((s: string) => void) | undefined;
    h.run.mockImplementation((_input, _signal, onStep) => { step = onStep; return new Promise(() => {}); });
    await h.studio.action('report', { id: i.id, run: i.run, status: 'done', summary: 'ready', checks: 'tests', ci: 'pass' });
    await h.studio.action('review', { id: i.id }); step?.('Проверка Git');
    expect(h.fm.tasks.require(i.id).studioReview).toMatchObject({ phase: 'running', head: i.head, step: 'Проверка Git' });
    h.fm.store.flush();
    const saved = JSON.parse(fs.readFileSync(path.join(h.fm.config.dataDir, 'state.json'), 'utf8'));
    expect(saved.tasks.find((t: { id: string }) => t.id === i.id).studioReview.phase).toBe('running');
    h.studio.stop();
    const restarted = new Studio(h.fm, { send: h.send, control: h.control }, { run: h.run });
    expect(h.fm.tasks.require(i.id).studioReview).toMatchObject({ phase: 'paused', head: i.head, step: 'Проверка Git' });
    step?.('Поздний шаг'); expect(h.fm.tasks.require(i.id).studioReview?.step).toBe('Проверка Git');
    expect(h.run).toHaveBeenCalledTimes(1); restarted.stop();
  });
  it('restores queue paused without replaying a send or accepting old reports', async () => {
    const h = await setup(); const i = await h.start(); const run = i.run;
    const other = new Studio(h.fm, { send: h.send, control: h.control }); other.stop();
    expect(other.data.mode).toBe('paused'); expect(other.data.items[0]!.stage).toBe('question');
    await expect(other.action('report', { id: i.id, run, status: 'done', summary: 'late', checks: 'tests', ci: 'pass' })).rejects.toThrow();
    expect(h.send).toHaveBeenCalledTimes(1);
  });
  it('separates visibility from executor enablement and persists selected appearance', async () => {
    const h = await setup(); const i = await h.start();
    await h.studio.action('agent', { ...h.studio.data.profiles[0], visible: false, name: 'Разработчик', skin: 'wren' });
    expect(h.studio.data.active).toBe(i.id); expect(h.studio.data.profiles[0]!.enabled).toBe(true); expect(h.fm.requireAgent('marlow')).toMatchObject({ active: false, name: 'Разработчик', skin: 'wren' });
  });
  it('keeps separate review ranges when another task runs while awaiting an answer', async () => {
    const h = await setup(); const i = await h.start(); const first = await cleanHead(h.repo);
    await h.studio.action('report', { id: i.id, run: i.run, status: 'question', summary: 'Выбор?' });
    fs.writeFileSync(path.join(h.repo, 'independent.txt'), 'Other task');
    await gitText(h.repo, ['add', 'independent.txt']); await gitText(h.repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'Independent']);
    const independent = await cleanHead(h.repo); expect(independent).not.toBe(first);
    await h.studio.action('retry', { id: i.id }); await h.studio.pump();
    fs.writeFileSync(path.join(h.repo, 'own.txt'), 'Own task'); await gitText(h.repo, ['add', 'own.txt']);
    await gitText(h.repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'Own task']);
    await h.studio.action('report', { id: i.id, run: i.run, status: 'done', summary: 'ready', checks: 'tests', ci: 'pass' });
    expect(i.ranges).toEqual([{ base: independent, head: await cleanHead(h.repo) }]);
  });
});
