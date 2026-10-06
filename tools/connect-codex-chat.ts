// Run from the chosen Codex chat after the user authorizes in-game messages to that chat.
import { appCall, chatConfigPath, type ChatBinding } from '../foreman/src/codex-desktop.js';
import { writeJsonAtomic } from '../foreman/src/util/fsx.js';
const threadId = process.env.CODEX_THREAD_ID;
const pipePath = process.env.CODEX_APP_TOOLS_PIPE_PATH;
if (!threadId || !pipePath) throw new Error('Run this connector from the chosen Codex desktop chat.');
const binding: ChatBinding = { threadId, pipePath, hostId: 'local', title: 'Codex' };
const data = await appCall(binding, 'read_thread', { turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 0 });
if (data.thread?.id !== threadId) throw new Error('Thread identity was not confirmed.');
binding.title = data.thread.title || 'Codex';
writeJsonAtomic(chatConfigPath(), binding);
console.log(JSON.stringify({ connected: true, threadId, title: binding.title, config: chatConfigPath() }));
