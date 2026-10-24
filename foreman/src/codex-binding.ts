import { z } from 'zod';

export const CodexHostId = z.union([z.literal('local'), z.string().regex(/^remote-ssh-codex-managed:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)]);
export const desktopFields = {
  threadId: z.string().uuid(), hostId: CodexHostId, title: z.string().max(1000),
  pipePath: z.string().regex(/^\\\\\.\\pipe\\codex-(?:browser-use|app-tools)-[A-Za-z0-9_-]+$/),
  // The Windows caller owns the pipe; the target may live on another host.
  callerThreadId: z.string().uuid().optional(),
};
export function requireDesktopCaller(value: { hostId: string; callerThreadId?: string }, ctx: z.RefinementCtx) {
  if (value.hostId !== 'local' && !value.callerThreadId)
    ctx.addIssue({ code: 'custom', path: ['callerThreadId'], message: 'Remote connections require a local Windows caller thread.' });
}
export const ChatBindingSchema = z.object(desktopFields).strict().superRefine(requireDesktopCaller);
export type ChatBinding = z.infer<typeof ChatBindingSchema>;

export function connectorBinding(options: { thread?: string; host?: string }, env: { CODEX_THREAD_ID?: string; CODEX_APP_TOOLS_PIPE_PATH?: string }): ChatBinding {
  if (!env.CODEX_THREAD_ID || !env.CODEX_APP_TOOLS_PIPE_PATH)
    throw new Error('Run this connector from a local Windows Codex chat.');
  if (!!options.thread !== !!options.host) throw new Error('Specify both --thread <UUID> and --host <hostId>.');
  return ChatBindingSchema.parse({ threadId: options.thread ?? env.CODEX_THREAD_ID,
    hostId: options.host ?? 'local', callerThreadId: env.CODEX_THREAD_ID,
    pipePath: env.CODEX_APP_TOOLS_PIPE_PATH, title: 'Codex' });
}

export function appToolRequest(binding: ChatBinding, tool: 'read_thread' | 'send_message_to_thread', args: Record<string, unknown>) {
  const { threadId, hostId, title, pipePath, callerThreadId } = binding;
  ChatBindingSchema.parse({ threadId, hostId, title, pipePath, callerThreadId });
  return { namespace: 'codex_app', tool,
    arguments: { ...args, threadId: binding.threadId, hostId: binding.hostId },
    callerSource: 'codex', threadId: binding.callerThreadId ?? binding.threadId, hostId: 'local' };
}
