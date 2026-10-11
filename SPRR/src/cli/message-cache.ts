import { createHash } from 'node:crypto';
import type { RequestEnv } from '../api/imapi.js';
import type { MessageItem } from '../api/operations.js';

export function accountCacheKey(env: RequestEnv): string {
  return createHash('sha256').update(env.cookie).digest('hex');
}

interface Entry {
  account: string;
  cid: string;
  id: string;
  message?: MessageItem;
  recalled: boolean;
  expiresAt: number;
}

/** Bounded, account-scoped cache of references already loaded by the user. */
export class MessageCache {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly options: {
    now?: () => number;
    ttlMs?: number;
    recallTtlMs?: number;
    maxEntries?: number;
  } = {}) {}

  private now(): number { return (this.options.now ?? Date.now)(); }
  private key(account: string, cid: string, id: string): string {
    return JSON.stringify([account, cid, id]);
  }

  private prune(): void {
    const now = this.now();
    for (const [key, value] of this.entries) {
      if (value.expiresAt <= now) this.entries.delete(key);
    }
    while (this.entries.size > (this.options.maxEntries ?? 2000)) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }

  put(account: string, cid: string, messages: MessageItem[]): void {
    this.prune();
    for (const message of messages) {
      const id = message.serverMsgId;
      if (!id || (message.conversationId && message.conversationId !== cid)) continue;
      const key = this.key(account, cid, id);
      if (this.entries.get(key)?.recalled) continue;
      if (message.category === 'recall') {
        this.markRecalled(account, cid, id);
        continue;
      }
      this.entries.delete(key);
      this.entries.set(key, {
        account, cid, id, message: { ...message }, recalled: false,
        expiresAt: this.now() + (this.options.ttlMs ?? 5 * 60_000),
      });
    }
    this.prune();
  }

  get(account: string, id: string, cid?: string): { cid: string; message: MessageItem } | null {
    this.prune();
    const candidates = [...this.entries.entries()].filter(([, entry]) =>
      entry.account === account && entry.id === id && (!cid || entry.cid === cid));
    if (candidates.length !== 1) return null;
    const [key, entry] = candidates[0];
    if (entry.recalled || !entry.message) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { cid: entry.cid, message: { ...entry.message } };
  }

  markRecalled(account: string, cid: string, id: string): void {
    const key = this.key(account, cid, id);
    this.entries.delete(key);
    this.entries.set(key, {
      account, cid, id, recalled: true,
      expiresAt: this.now() + (this.options.recallTtlMs ?? 30 * 60_000),
    });
    this.prune();
  }

  isRecalled(account: string, cid: string, id: string): boolean {
    this.prune();
    return this.entries.get(this.key(account, cid, id))?.recalled ?? false;
  }

  clear(): void { this.entries.clear(); }
}

const messages = new MessageCache();
export function cacheMessages(env: RequestEnv, cid: string, items: MessageItem[]): void {
  messages.put(accountCacheKey(env), cid, items);
}
export function getCachedMessage(env: RequestEnv, id: string, cid?: string) {
  return messages.get(accountCacheKey(env), id, cid);
}
export function markMessageRecalled(env: RequestEnv, cid: string, id: string): void {
  messages.markRecalled(accountCacheKey(env), cid, id);
}
export function isMessageRecalled(env: RequestEnv, cid: string, id: string): boolean {
  return messages.isRecalled(accountCacheKey(env), cid, id);
}
export function clearMessageCache(): void { messages.clear(); }
