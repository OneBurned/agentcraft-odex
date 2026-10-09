import type { ChildProcess } from 'node:child_process';
import { descendantsOf, killSnapshot, orphansOf, processTable, type ProcEntry } from './util/proc.js';

type Receipt = { pid: number; started: number; descendants: Map<number, ProcEntry> };

/** Track our child's identity before it can exit; an inherited pipe can outlive its parent. */
export class CodexProcessTree {
  private receipts = new WeakMap<ChildProcess, Receipt>();
  constructor(private table = processTable, private kill = killSnapshot,
    private delay = () => new Promise<void>(resolve => setTimeout(resolve, 100))) {}

  attach(child: ChildProcess) {
    if (child.pid) this.receipts.set(child, { pid: child.pid, started: Date.now(), descendants: new Map() });
  }

  async stop(child: ChildProcess, stopRoot: (child: ChildProcess) => Promise<void>) {
    const receipt = this.receipts.get(child);
    if (!receipt) {
      if (!child.pid) return; // spawn failed; no process to terminate
      throw new Error('Нет подтверждённого владельца процесса Codex CLI.');
    }
    const collect = (table: ProcEntry[]) => {
      const root = table.find(p => p.pid === receipt.pid);
      if (root && !root.createdMs) throw new Error('Не удалось проверить время запуска Codex CLI. Повтори Стоп.');
      // A reused PID is not our root, nor an authority to claim its descendants.
      const sameRoot = !root || Math.abs(root.createdMs - receipt.started) <= 2000;
      if (sameRoot && descendantsOf(table, receipt.pid).some(p => !p.createdMs))
        throw new Error('Не удалось проверить время запуска дочернего процесса Codex CLI. Повтори Стоп.');
      if (sameRoot) for (const p of orphansOf(table, receipt.pid, receipt.started)) {
        const saved = receipt.descendants.get(p.pid);
        // Keep the first observed identity: never adopt a reused descendant PID.
        if (!saved) receipt.descendants.set(p.pid, p);
      }
      return { root, sameRoot };
    };
    const before = await this.table();
    if (!before) throw new Error('Не удалось проверить процессы Codex CLI. Повтори Стоп.');
    const { root, sameRoot } = collect(before);
    if (root && sameRoot && child.exitCode === null && child.signalCode === null) await stopRoot(child);
    // Windows retains the exited parent's PID. Scan again to catch children created during taskkill.
    for (let attempt = 0; attempt < 4; attempt++) {
      const now = await this.table();
      if (!now) throw new Error('Не удалось подтвердить остановку процессов Codex CLI. Повтори Стоп.');
      const current = collect(now);
      const live = [...receipt.descendants.values()].filter(p => now.some(n => n.pid === p.pid && n.created === p.created));
      const rootAlive = current.root && current.sameRoot;
      if (!live.length && !rootAlive && (child.exitCode !== null || child.signalCode !== null)) return;
      if (live.length && await this.kill(live, now) === undefined)
        throw new Error('Не удалось проверить дочерние процессы Codex CLI. Повтори Стоп.');
      await this.delay();
    }
    throw new Error('Codex CLI или его дочерние процессы ещё работают. Повтори Стоп.');
  }
}
