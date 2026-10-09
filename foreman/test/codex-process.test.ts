import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { CodexProcessTree } from '../src/codex-process.js';
import type { ProcEntry } from '../src/util/proc.js';
type MutableChild = { -readonly [K in keyof ChildProcess]: ChildProcess[K] };

function fixture() {
  const started = Date.now();
  const entry = (pid: number, ppid: number, offset = 0): ProcEntry => ({ pid, ppid, created: String(started + offset), createdMs: started + offset });
  const child = { pid: 101, exitCode: null, signalCode: null } as unknown as MutableChild;
  let rows: ProcEntry[] | undefined = [entry(101, 1)];
  const table = vi.fn(async () => rows?.map(p => ({ ...p })));
  const kill = vi.fn(async (targets: ProcEntry[]) => {
    rows = rows?.filter(p => !targets.some(t => t.pid === p.pid && t.created === p.created));
    return targets.map(p => p.pid);
  });
  const root = vi.fn(async () => { child.exitCode = 1; rows = rows?.filter(p => p.pid !== 101); });
  const tree = new CodexProcessTree(table, kill, async () => {}); tree.attach(child);
  return { tree, table, kill, root, child, entry, set: (value: ProcEntry[] | undefined) => { rows = value; } };
}

it('reaps a late Windows child after its root exited but inherited stdout remains open', async () => {
  const f = fixture();
  f.root.mockImplementation(async () => {
    f.child.exitCode = 1;
    f.set([f.entry(102, 101, 10), f.entry(201, 1)]);
  });
  await f.tree.stop(f.child, f.root);
  expect(f.kill.mock.calls[0]![0].map(p => p.pid)).toEqual([102]);
  expect(f.root).toHaveBeenCalledTimes(1);
});

it('still reaps a known orphan when the root exited before Stop was requested', async () => {
  const f = fixture(); f.child.exitCode = 0; f.set([f.entry(102, 101, 10)]);
  await f.tree.stop(f.child, f.root);
  expect(f.root).not.toHaveBeenCalled(); expect(f.kill).toHaveBeenCalledTimes(1);
});

it('does not kill a reused root PID or claim the new roots children', async () => {
  const f = fixture(); f.child.exitCode = 0;
  f.set([f.entry(101, 1, 10000), f.entry(102, 101, 10001)]);
  await f.tree.stop(f.child, f.root);
  expect(f.root).not.toHaveBeenCalled(); expect(f.kill).not.toHaveBeenCalled();
});

it('does not adopt a reused descendant PID from the first snapshot', async () => {
  const f = fixture(); f.set([f.entry(101, 1), f.entry(102, 101, 10)]);
  f.root.mockImplementation(async () => { f.child.exitCode = 1; f.set([f.entry(102, 101, 10000)]); });
  await f.tree.stop(f.child, f.root);
  expect(f.kill).not.toHaveBeenCalled();
});

it('keeps the receipt for retry when an owned child survives the first stop', async () => {
  const f = fixture(); f.child.exitCode = 1; f.set([f.entry(102, 101, 10)]);
  f.kill.mockImplementation(async () => []);
  await expect(f.tree.stop(f.child, f.root)).rejects.toThrow('ещё работают');
  f.kill.mockImplementation(async targets => { f.set([]); return targets.map(p => p.pid); });
  await f.tree.stop(f.child, f.root);
  expect(f.kill.mock.calls.at(-1)![0][0]!.pid).toBe(102);
});

it('refuses to claim stopped or kill anything when the process table is unavailable', async () => {
  const f = fixture(); f.set(undefined);
  await expect(f.tree.stop(f.child, f.root)).rejects.toThrow('проверить процессы');
  expect(f.root).not.toHaveBeenCalled(); expect(f.kill).not.toHaveBeenCalled();
});

it('refuses to ignore a descendant with an unknown creation time', async () => {
  const f = fixture(); f.set([f.entry(101, 1), { pid: 102, ppid: 101, created: '0', createdMs: 0 }]);
  await expect(f.tree.stop(f.child, f.root)).rejects.toThrow('время запуска дочернего');
  expect(f.root).not.toHaveBeenCalled(); expect(f.kill).not.toHaveBeenCalled();
});

it.skipIf(process.platform !== 'win32')('closes a real inherited Windows pipe after the parent has already exited', async () => {
  const code = `const {spawn}=require('node:child_process');
    const helper=spawn(process.execPath,['-e','setTimeout(()=>{},15000)'],{windowsHide:true,stdio:['ignore',1,2]});
    helper.unref();`;
  const child = spawn(process.execPath, ['-e', code], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const tree = new CodexProcessTree(); tree.attach(child);
  let closed = false; const closing = once(child, 'close').then(() => { closed = true; });
  child.stdout.resume(); child.stderr.resume();
  await once(child, 'exit');
  expect(closed).toBe(false); // the helper still owns the pipe; reproduces the live failure
  const root = vi.fn(async () => {});
  try {
    await tree.stop(child, root);
    await closing;
    expect(root).not.toHaveBeenCalled();
    expect(closed).toBe(true);
  } finally {
    // The fixture helper exits by itself after 15s even if a process-table check fails.
    child.stdout.destroy(); child.stderr.destroy();
  }
}, 20000);
