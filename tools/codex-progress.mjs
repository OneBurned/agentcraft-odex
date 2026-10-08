#!/usr/bin/env node
// Explicit summaries only: never reads chat history, source files, credentials or command output.
import { parseArgs } from 'node:util';
import { ForemanClient } from './lib/foremanclient.mjs';

let fm;
try {
  const { values } = parseArgs({ options: {
    key: { type: 'string' }, title: { type: 'string' }, state: { type: 'string' },
    activity: { type: 'string' }, log: { type: 'string' }, summary: { type: 'string' },
    ci: { type: 'string' }, 'repo-id': { type: 'string' }, port: { type: 'string', default: '7878' },
    agent: { type: 'string' },
    optional: { type: 'boolean', default: false }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('codex-progress --key <stable-task-key> --title <title> --state <reading|editing|testing|review|done|...> --activity <text> [--log <text>] [--summary <text>] [--ci pass|fail|running|unknown] [--optional]');
  } else {
    for (const key of ['key', 'title', 'state', 'activity']) if (!values[key]?.trim()) throw new Error(`--${key} is required`);
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid --port');
    try {
      fm = await ForemanClient.connect({ port, timeoutMs: values.optional ? 500 : 5000, client: 'codex-progress' });
    } catch (error) {
      if (!values.optional) throw error;
      console.log(JSON.stringify({ ok: true, skipped: true, reason: 'Observer is offline; no update was published.' }));
      process.exit(0);
    }
    if (fm.state.foreman?.backend !== 'observer') throw new Error('Connected Foreman is not in observer mode');
    const { key, title, state, activity, log, summary, ci } = values;
    const ack = await fm.send('observer.update', { key, title, state, activity, log, summary, ci, repoId: values['repo-id'], agentId: values.agent });
    console.log(JSON.stringify({ ok: true, ...ack.result }));
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
} finally { fm?.close(); }
