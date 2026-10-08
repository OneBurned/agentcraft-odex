import type { FeedItem } from './protocol.js';

export type ReplyAgent = string;
export function replyAuthor(item: FeedItem): ReplyAgent | undefined {
  return item.to === 'user' && (item.kind === 'message' || item.kind === 'decision')
    && !!item.agentId && /^[a-z0-9_-]{1,64}$/.test(item.agentId) && item.text.trim()
    ? item.agentId : undefined;
}
