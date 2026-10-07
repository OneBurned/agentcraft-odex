import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { auditPortable } from '../audit-portable.mjs';
import { readZip, writeZip } from '../lib/zip.mjs';

async function fixture(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-audit-test-'));
  t.after(async () => {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('ac-audit-test-')) throw Error('Unsafe cleanup path');
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const [name, data] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), data);
  }
  return root;
}
test('clean neutral templates and ordinary binary data pass', async t => {
  const root = await fixture(t, { 'README.txt': 'AgentCraft: configure your own account.', 'assets/image.bin': Buffer.from([0, 255, 20, 1]), 'NOTES.example.md': 'Empty starter.' });
  assert.equal((await auditPortable(root)).ok, true);
});
for (const [rule, value] of [
  ['user-path', 'C:\\Users\\PrivateUser\\Documents\\work'],
  ['user-path', '/home/private/project'],
  ['private-project', 'OneBurned/TITracker'],
  ['private-project', 'TradeRecord'],
  ['private-persona', 'Клава: моя личность'],
  ['private-persona', 'Кадеин'],
  ['email', 'owner@private.invalid'],
  ['session-id', '12345678-1234-1234-1234-123456789abc'],
]) test(`detects ${rule}: ${value.length} chars`, async t => {
  const root = await fixture(t, { 'hidden.dat': value });
  const audit = await auditPortable(root);
  assert.ok(audit.issues.some(i => i.rule === rule));
  assert.ok(!JSON.stringify(audit).includes(value), 'diagnostics must not expose secret contents');
});
test('escaped JSON and UTF-16 contents are inspected', async t => {
  const root = await fixture(t, { 'a.json': '"\\u0054radeRecord"', 'b.bin': Buffer.from('C:\\Users\\PrivateUser\\work', 'utf16le') });
  assert.deepEqual((await auditPortable(root)).issues.map(i => i.rule).sort(), ['private-project', 'user-path']);
});
for (const name of ['profile/state.json', 'data/portable/state.json', 'conversation.json', 'codex-chat.json', 'MEMORY.md', '.env', 'data/history.jsonl']) {
  test(`rejects private state filename ${name}`, async t => {
    const root = await fixture(t, { [name]: '{}' });
    assert.ok((await auditPortable(root)).issues.some(i => i.rule === 'private-state-file'));
  });
}
test('compressed and nested JAR members are inspected', async t => {
  const nested = writeZip([{ name: 'x.txt', data: Buffer.from('TradeRecord') }]);
  const jar = writeZip([{ name: 'META-INF/jars/nested.jar', data: nested }]);
  assert.equal(readZip(jar)[0].name, 'META-INF/jars/nested.jar');
  const root = await fixture(t, { 'mod.jar': jar });
  const audit = await auditPortable(root);
  assert.ok(audit.issues.some(i => i.file.endsWith('nested.jar!x.txt') && i.rule === 'private-project'));
});
test('schematics need explicit opt-in, which does not bypass other leak rules', async t => {
  const root = await fixture(t, { 'buildings/test.schem': 'test' });
  assert.equal((await auditPortable(root)).ok, false);
  assert.equal((await auditPortable(root, { allowSchematics: true })).ok, true);
  await fs.writeFile(path.join(root, 'buildings/test.schem'), 'OneBurned');
  assert.equal((await auditPortable(root, { allowSchematics: true })).ok, false);
});
test('corrupt, traversing and duplicate ZIP entries fail closed', async t => {
  const root = await fixture(t, {
    'broken.jar': 'not a ZIP',
    'traversal.jar': writeZip([{ name: '../secret', data: Buffer.from('safe') }]),
    'duplicate.jar': writeZip([{ name: 'a', data: Buffer.from('a') }, { name: 'A', data: Buffer.from('b') }]),
  });
  assert.equal((await auditPortable(root)).issues.filter(i => i.rule === 'uninspectable-archive').length, 3);
});
test('CLI exits nonzero for an injected leak and succeeds after removal', async t => {
  const root = await fixture(t, { 'leak.txt': 'OneBurned' });
  const run = () => spawnSync(process.execPath, ['tools/audit-portable.mjs', root], { cwd: new URL('../..', import.meta.url), encoding: 'utf8', windowsHide: true });
  assert.equal(run().status, 1);
  await fs.unlink(path.join(root, 'leak.txt'));
  assert.equal(run().status, 0);
});
test('public protocol GUID does not hide a private session ID in the same file', async t => {
  const root = await fixture(t, { 'protocol.txt': '258EAFA5-E914-47DA-95CA-C5AB0DC85B11' });
  assert.equal((await auditPortable(root)).ok, true);
  await fs.appendFile(path.join(root, 'protocol.txt'), '\n12345678-1234-1234-1234-123456789abc');
  assert.ok((await auditPortable(root)).issues.some(i => i.rule === 'session-id'));
});
test('third-party notice exception expires on any changed byte', async t => {
  const original = await fs.readFile(new URL('../../foreman/node_modules/ws/LICENSE', import.meta.url));
  const root = await fixture(t, { 'licenses/ws-MIT.txt': original });
  assert.equal((await auditPortable(root)).ok, true);
  await fs.appendFile(path.join(root, 'licenses/ws-MIT.txt'), '\nowner@private.invalid');
  assert.ok((await auditPortable(root)).issues.some(i => i.rule === 'email'));
});
test('ZIP comments cannot conceal project data', async t => {
  const zip = writeZip([{ name: 'ok.txt', data: Buffer.from('safe') }]);
  const comment = Buffer.from('TradeRecord'); zip.writeUInt16LE(comment.length, zip.length - 2);
  const root = await fixture(t, { 'archive.jar': Buffer.concat([zip, comment]) });
  assert.ok((await auditPortable(root)).issues.some(i => i.rule === 'private-project'));
});
