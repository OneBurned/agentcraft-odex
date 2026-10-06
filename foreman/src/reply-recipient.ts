import type { FeedItem } from './protocol.js';

export type ReplyAgent = 'marlow' | 'wren';
export function replyAuthor(item: FeedItem): ReplyAgent | undefined {
  return item.to === 'user' && (item.kind === 'message' || item.kind === 'decision')
    && (item.agentId === 'marlow' || item.agentId === 'wren') && item.text.trim()
    ? item.agentId : undefined;
}
