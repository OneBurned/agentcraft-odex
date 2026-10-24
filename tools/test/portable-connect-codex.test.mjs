import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('portable connector keeps legacy mode and requires an explicit recipient for a team', { skip: process.platform !== 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentcraft-connector-test-'));
  try {
    await fs.mkdir(path.join(root, 'runtime'));
    await fs.copyFile(process.execPath, path.join(root, 'runtime/node.exe'));
    await fs.copyFile(new URL('../portable/Connect-Codex.ps1', import.meta.url), path.join(root, 'Connect-Codex.ps1'));
    // Stub only the final connector. No IPC, network request, real chat or profile is used.
    await fs.writeFile(path.join(root, 'connect-codex-chat.mjs'), 'console.log(JSON.stringify({args:process.argv.slice(2),binding:process.env.AGENTCRAFT_CHAT_CONFIG}));');
    const run = (...args) => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'Connect-Codex.ps1'), ...args], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    const legacy = run();
    assert.deepEqual(legacy.args, []);
    assert.equal(legacy.binding, path.join(root, 'data/portable/codex-chat.json'));
    await fs.writeFile(path.join(root, 'data/portable/team.json'), '{}');
    assert.throws(() => run(), /Specify -Agent/);
    assert.deepEqual(run('-Agent', 'agent_example', '-Port', '17878').args, ['--agent', 'agent_example', '--port', '17878']);
    assert.deepEqual(run('-ThreadId', 'chosen', '-HostId', 'remote', '-Check').args, ['--thread', 'chosen', '--host', 'remote', '--check']);
    assert.throws(() => run('-ThreadId', 'chosen'), /both/);
  } finally {
    assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
