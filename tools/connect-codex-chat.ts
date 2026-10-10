// Run from the chosen Codex chat after the user authorizes in-game messages to that chat.
import { appCall, chatConfigPath, type ChatBinding } from '../foreman/src/codex-desktop.js';
import { writeJsonAtomic } from '../foreman/src/util/fsx.js';
import { parseArgs } from 'node:util';
import { ForemanClient } from './lib/foremanclient.mjs';
const { values } = parseArgs({ options: { agent: { type: 'string' }, port: { type: 'string', default: '7878' } } });
const threadId = process.env.CODEX_THREAD_ID;
const pipePath = process.env.CODEX_APP_TOOLS_PIPE_PATH;
if (!threadId || !pipePath) throw new Error('Run this connector from the chosen Codex desktop chat.');
const binding: ChatBinding = { threadId, pipePath, hostId: 'local', title: 'Codex' };
const data = await appCall(binding, 'read_thread', { turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 0 });
if (data.thread?.id !== threadId) throw new Error('Thread identity was not confirmed.');
binding.title = data.thread.title || 'Codex';
if (values.agent) {
  const client = await ForemanClient.connect({ port: Number(values.port), timeoutMs: 5000, client: 'connect-agent' });
  try {
    const { result: team } = await client.send('studio.action', { action: 'team.get', payload: {} });
    const { result: current } = await client.send('studio.action', { action: 'connection.get', payload: { id: values.agent } });
    if (current.connection?.transport === 'codex-desktop' && current.connection.threadId === threadId && current.connection.hostId === binding.hostId)
      await client.send('studio.action', { action: 'connection.refreshCodex', payload: { id: values.agent, revision: team.revision, threadId, hostId: binding.hostId, pipePath } });
    else await client.send('studio.action', { action: 'connection.bind', payload: { id: values.agent, revision: team.revision,
      connection: { ...binding, provider: 'codex', transport: 'codex-desktop' } } });
    console.log(JSON.stringify({ connected: true, agentId: values.agent, threadId, title: binding.title }));
  } finally { client.close(); }
} else {
  // Compatibility only for a pre-team profile. New profiles always use --agent.
  writeJsonAtomic(chatConfigPath(), binding);
  console.log(JSON.stringify({ connected: true, threadId, title: binding.title, config: chatConfigPath(), legacy: true }));
}
