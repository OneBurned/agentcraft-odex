import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Studio } from '../src/studio.js';
import { cleanHead, gitText, type ReviewResult, type Reviewer } from '../src/studio-review.js';
import { demoRepo, makeForeman, rmrf, tempDir, until } from './helpers.js';
import type { DialogRunner } from '../src/claude-dialog.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(reviewMode: 'auto' | 'manual' | 'off' = 'off') {
  const home = tempDir('ac-studio-'); const repo = await demoRepo();
  const h = makeForeman(home, ['--backend', 'observer']); await h.fm.repos.add(repo);
  const send = vi.fn(async (_text: string) => ({})); const control = vi.fn(async () => ({}));
  const run = vi.fn<Reviewer['run']>(async () => ({ verdict: 'pass', summary: 'Проверено' }));
  const stop = vi.fn(async () => {});
  const dialogRun = vi.fn(async (_prompt: string, _signal: AbortSignal) => 'Ответ Клавы');
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
  it('interrupts even before polling has observed the newly dispatched turn', async () => {
    const h = await setup(); const i = await h.start();
    await h.studio.action('pause', {});
    expect(h.control).toHaveBeenCalledWith('pause'); expect(i.stage).toBe('queued');
  });
  it('does not claim a stop when chat connectivity is lost', async () => {
    const h = await setup(); const i = await h.start();
    h.studio.onActivity({ key: '', phase: 'unavailable' });
    await expect(h.studio.action('stop', {})).rejects.toThrow('не подтверждена');
    expect(h.studio.data.active).toBe(i.id); expect(h.control).not.toHaveBeenCalled();
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
  it('manual mode waits for the explicit review button', async () => {
    const h = await setup('manual'); const i = await h.start();
    await h.studio.action('report', { id: i.id, run: i.run, status: 'done', summary: 'implemented', checks: 'tests', ci: 'pass' });
    await h.studio.pump(); expect(h.run).not.toHaveBeenCalled(); await h.studio.action('review', { id: i.id }); await until(() => i.stage === 'done');
  });
  it('returns changes to Codex and asks the user after two unsuccessful reviews', async () => {
    const h = await setup('auto'); h.run.mockResolvedValue({ verdict: 'changes', summary: 'Исправить обработку ошибок' }); const i = await h.start();
    for (let n = 0; n < 2; n++) {
      await h.studio.action('report', { id: i.id, run: i.run, status: 'done', summary: 'implemented', checks: 'tests', ci: 'pass' });
      await h.studio.pump(); await until(() => i.stage === (n === 0 ? 'queued' : 'question'));
      if (n === 0) await h.studio.pump();
    }
    expect(h.fm.decisions.open()).toHaveLength(1); expect(h.send).toHaveBeenCalledTimes(2);
  });
  it('aborts reviewer on pause and ignores its late verdict', async () => {
    const h = await setup('auto'); let resolve!: (r: ReviewResult) => void;
    h.run.mockImplementation(() => new Promise(r => { resolve = r; })); const i = await h.start();
    await h.studio.action('report', { id: i.id, run: i.run, status: 'done', summary: 'implemented', checks: 'tests', ci: 'pass' });
    await h.studio.pump(); await h.studio.action('pause', {}); resolve({ verdict: 'pass', summary: 'late' });
    await new Promise(r => setTimeout(r, 15)); expect(i.stage).toBe('review'); expect(h.studio.data.mode).toBe('paused');
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
