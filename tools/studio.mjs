#!/usr/bin/env node
import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { ForemanClient } from './lib/foremanclient.mjs';
let client;
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { file: { type: 'string' }, port: { type: 'string', default: '7878' } } });
  const action = positionals[0] ?? 'get';
  const payload = values.file ? JSON.parse(await fs.readFile(values.file, 'utf8')) : {};
  client = await ForemanClient.connect({ port: Number(values.port), timeoutMs: 10000, client: 'studio-control' });
  const ack = await client.send('studio.action', { action, payload });
  // Reports don't expose the whole roster, local paths or notes in the developer's command output.
  console.log(JSON.stringify(action === 'get' ? ack.result : { ok: ack.ok, action }));
} catch (error) { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
finally { client?.close(); }
