import type { ChildProcess } from 'node:child_process';
import { z } from 'zod';
import { readJson, writeJsonAtomic } from '../../util/fsx.js';
import { killTree, killSnapshot, orphansOf, processTable, type ProcEntry } from '../../util/proc.js';

const entry = z.object({ pid: z.number(), ppid: z.number(), created: z.string(), createdMs: z.number() });
const record = z.object({ pid: z.number().int().positive(), spawnedAt: z.number(), tree: z.array(entry) });
type Record = z.infer<typeof record>;
const alive = (c: ChildProcess) => c.exitCode === null && c.signalCode === null;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A durable receipt of our own CLI tree. Unknown process state never means stopped. */
export class ClaudeProcess {
  private child?: ChildProcess;
  private state?: Record;
  private stopping?: Promise<void>;
  constructor(private file: string, private table = processTable, private kill = killSnapshot) {
    const saved = readJson(file);
    if (saved != null) this.state = record.parse(saved);
  }
  busy() { return !!this.state; }
  attach(child: ChildProcess) {
    if (this.state) throw new Error('Остановка предыдущего процесса Claude не подтверждена.');
    if (!child.pid) throw new Error('Claude не запустился.');
    this.child = child;
    this.state = { pid: child.pid, spawnedAt: Date.now(), tree: [] };
    writeJsonAtomic(this.file, this.state);
  }
  stop(close: () => void = () => {}): Promise<void> {
    if (!this.stopping) this.stopping = this.reap(close).finally(() => { this.stopping = undefined; });
    return this.stopping;
  }
  private async reap(close: () => void) {
    const s = this.state;
    if (!s) { close(); return; }
    // Snapshot before SDK close/abort: POSIX may reparent children after their parent exits.
    const before = await this.table();
    if (before) {
      const entries = new Map(s.tree.map(e => [e.pid, e]));
      for (const e of orphansOf(before, s.pid, s.spawnedAt)) entries.set(e.pid, e);
      s.tree = [...entries.values()]; writeJsonAtomic(this.file, s);
    }
    if (!before) throw new Error('Не удалось проверить процессы Claude. Повтори Стоп.');
    close();
    if (this.child && alive(this.child)) killTree(this.child);
    for (let attempt = 0; attempt < 4; attempt++) {
      const now = await this.table();
      if (!now) throw new Error('Не удалось подтвердить остановку процессов Claude.');
      const targets = new Map(s.tree.map(e => [e.pid, e]));
      for (const e of orphansOf(now, s.pid, s.spawnedAt)) targets.set(e.pid, e);
      const root = now.find(e => e.pid === s.pid && Math.abs(e.createdMs - s.spawnedAt) <= 2000);
      if (now.some(e => e.pid === s.pid && !e.createdMs)) throw new Error('Не удалось определить время создания процесса Claude.');
      if (root) targets.set(root.pid, root);
      const live = [...targets.values()].filter(e => now.some(n => n.pid === e.pid && n.created === e.created));
      if (!live.length && (!this.child || !alive(this.child))) {
        writeJsonAtomic(this.file, null); this.state = undefined; this.child = undefined; return;
      }
      s.tree = [...targets.values()]; writeJsonAtomic(this.file, s);
      await this.kill(live, now);
      await sleep(100);
    }
    throw new Error('Claude или его дочерние процессы ещё работают. Повтори Стоп.');
  }
}
