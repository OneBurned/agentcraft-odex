#!/usr/bin/env node
import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { ForemanClient } from './lib/foremanclient.mjs';
let client, output, outputPath;
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    file: { type: 'string' }, port: { type: 'string' }, permit: { type: 'string' }, out: { type: 'string' }, to: { type: 'string' },
  } });
  const action = positionals[0] === 'message' ? 'message.send' : positionals[0] === 'messages' ? 'message.list' : positionals[0] === 'draft' ? `draft.${positionals[1]}` : positionals[0] ?? 'get';
  if (positionals.length > (positionals[0] === 'draft' ? 2 : 1)) throw new Error('Unexpected command arguments.');
  const messenger = ['message.send', 'message.list'].includes(action);
  const scoped = messenger || ['draft.list', 'draft.create'].includes(action);
  if (action.startsWith('draft.') && ![ 'draft.list', 'draft.create', 'draft.grant' ].includes(action)) throw new Error('Use draft list, create or grant.');
  if (values.permit && !scoped || scoped && !values.permit) throw new Error('Scoped commands require --permit <file>; credentials cannot be used for operator commands.');
  if (values.to && action !== 'message.send') throw new Error('--to is only for message.');
  if (action === 'draft.grant' && !values.out || values.out && action !== 'draft.grant') throw new Error('draft grant requires --out <new private JSON file>.');
  let payload = values.file ? JSON.parse(await fs.readFile(values.file, 'utf8')) : {};
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Expected a JSON object.');
  if (values.to) { if ('to' in payload && payload.to !== values.to) throw new Error('Recipient differs from --to.'); payload.to = values.to; }
  if ('token' in payload) throw new Error('Pass planner credentials using --permit, not --file.');
  let permit;
  if (scoped) {
    permit = JSON.parse(await fs.readFile(values.permit, 'utf8'));
    if (![1, 2].includes(permit.version) || typeof permit.agentId !== 'string' || typeof permit.token !== 'string' || !Number.isInteger(permit.port) || permit.port < 1 || permit.port > 65535)
      throw new Error('Invalid planner permit file.');
    if (messenger && (permit.version !== 1 || typeof permit.connection !== 'string')) throw new Error('Use the agent messaging.json permit, not a planning permit.');
    if (values.port && Number(values.port) !== permit.port) throw new Error('Port differs from the planner permit.');
    if ('agentId' in payload) throw new Error('Agent identity comes only from --permit.');
    payload = { ...payload, agentId: permit.agentId, token: permit.token };
  }
  const port = Number(values.port ?? permit?.port ?? '7878');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port.');
  // Refuse overwrite before granting anything; credentials never go to stdout.
  if (values.out) { output = await fs.open(values.out, 'wx', 0o600); outputPath = values.out; }
  client = await ForemanClient.connect({ port, timeoutMs: 10000, client: messenger ? 'studio-messenger' : scoped ? 'studio-planner' : 'studio-control', ...(scoped ? { pathname: messenger ? '/messenger' : '/planner' } : {}) });
  const ack = await client.send('studio.action', { action, payload });
  if (output) { await output.writeFile(JSON.stringify({ ...ack.result, port }, null, 2) + '\n'); await output.close(); output = undefined; outputPath = undefined; }
  // Reports don't expose the whole roster, local paths or notes in the developer's command output.
  console.log(JSON.stringify(scoped || action.startsWith('message.') || ['get', 'team.get', 'connection.get'].includes(action) ? ack.result : { ok: ack.ok, action }));
} catch (error) { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
finally { client?.close(); if (output) await output.close(); if (outputPath) await fs.unlink(outputPath); }
