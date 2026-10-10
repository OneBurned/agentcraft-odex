import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { sameDirectory } from './claude-planning.js';
const run = promisify(execFile);
const Row = z.object({ pid: z.number().int().positive().optional(), sessionId: z.string().optional(),
  cwd: z.string(), kind: z.string(), status: z.string().optional() });
export type ChannelSession = z.infer<typeof Row>;
export async function channelSessions(executable: string, workspace: string): Promise<ChannelSession[]> {
  const { stdout } = await run(executable, ['agents', '--json', '--cwd', workspace],
    { windowsHide: true, timeout: 8000, maxBuffer: 1000000 });
  return z.array(Row).parse(JSON.parse(stdout));
}
export async function channelSession(executable: string, workspace: string, sessionId: string): Promise<ChannelSession | undefined> {
  const rows = await channelSessions(executable, workspace);
  const matching = rows.filter(r => r.sessionId === sessionId);
  if (matching.length > 1) throw new Error('Несколько процессов используют один разговор Claude.');
  const row = matching[0];
  if (row && (!sameDirectory(row.cwd, workspace) || row.kind !== 'interactive'))
    throw new Error('Канал требует исходную интерактивную сессию Claude.');
  return row;
}
