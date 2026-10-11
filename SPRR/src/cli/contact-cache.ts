/** 联系人来源和昵称分别缓存；不把失败结果当作成功的空列表。 */
import type { RequestEnv } from '../api/imapi.js';
import type {
  ContactItem,
  ContactListBranchResult,
  ContactListOptions,
  ContactListResult,
} from '../api/operations.js';
import { detectMyUid } from '../api/operations.js';

export interface ContactCacheFailure {
  source: 'regular' | 'stranger';
  error: string;
  statusCode?: number;
  rateLimited: boolean;
}

export interface ContactCacheResult {
  contacts: ContactItem[];
  myUid: string;
  identityError?: string;
  complete: boolean;
  stale: boolean;
  failures: ContactCacheFailure[];
}

export interface ContactCacheDependencies {
  fetchContacts: (env: RequestEnv, options: ContactListOptions) => Promise<ContactListResult>;
  fetchNames: (env: RequestEnv, secUids: string[]) => Promise<Map<string, { nickname: string }>>;
  /** 仅在私聊列表无法唯一确认身份时使用真实个人资料 UID。 */
  fetchSelfUid?: (env: RequestEnv) => Promise<string | undefined>;
  now?: () => number;
}

export interface ContactCacheOptions {
  regularTtlMs?: number;
  strangerTtlMs?: number;
  nicknameTtlMs?: number;
  retryMs?: number;
  rateLimitBaseMs?: number;
  rateLimitMaxMs?: number;
  maxAccounts?: number;
  maxNicknames?: number;
}

interface SourceCache {
  contacts: ContactItem[];
  complete: boolean;
  initialized: boolean;
  nextRefreshAt: number;
  blockedUntil: number;
  rateLimitCount: number;
  failure?: ContactCacheFailure;
}

interface NameCacheEntry {
  nickname?: string;
  expiresAt: number;
  retryAt: number;
}

interface AccountCache {
  regular: SourceCache;
  stranger: SourceCache;
  names: Map<string, NameCacheEntry>;
  myUid: string;
  identityRetryAt: number;
  identityError?: string;
  inFlight?: Promise<ContactCacheResult>;
}

function emptySource(): SourceCache {
  return {
    contacts: [], complete: false, initialized: false,
    nextRefreshAt: 0, blockedUntil: 0, rateLimitCount: 0,
  };
}

function copyContact(contact: ContactItem): ContactItem {
  const copy = { ...contact };
  if (contact._participants) copy._participants = contact._participants.map((item) => ({ ...item }));
  return copy;
}

function mergeContacts(previous: ContactItem[], received: ContactItem[]): ContactItem[] {
  const merged = new Map(previous.map((contact) => [contact.conversationId, copyContact(contact)]));
  for (const contact of received) merged.set(contact.conversationId, copyContact(contact));
  return [...merged.values()];
}

export class ContactCache {
  private readonly accounts = new Map<string, AccountCache>();
  private readonly now: () => number;
  private readonly options: Required<ContactCacheOptions>;

  constructor(
    private readonly dependencies: ContactCacheDependencies,
    options: ContactCacheOptions = {},
  ) {
    this.now = dependencies.now ?? Date.now;
    this.options = {
      regularTtlMs: 30_000,
      strangerTtlMs: 60_000,
      nicknameTtlMs: 30 * 60_000,
      retryMs: 30_000,
      rateLimitBaseMs: 60_000,
      rateLimitMaxMs: 15 * 60_000,
      maxAccounts: 8,
      maxNicknames: 2_000,
      ...options,
    };
    this.options.maxAccounts = Math.max(1, Math.floor(this.options.maxAccounts));
    this.options.maxNicknames = Math.max(1, Math.floor(this.options.maxNicknames));
  }

  /** key 应由调用方按有效登录态生成，不应包含原始 Cookie。 */
  async get(
    accountKey: string,
    env: RequestEnv,
    options: { refreshRegular?: boolean; refreshStrangers?: boolean } = {},
  ): Promise<ContactCacheResult> {
    let account = this.accounts.get(accountKey);
    if (!account) {
      account = {
        regular: emptySource(), stranger: emptySource(), names: new Map(),
        myUid: '', identityRetryAt: 0,
      };
    }
    // 按最近访问淘汰账号，账号内昵称也有独立容量限制。
    this.accounts.delete(accountKey);
    this.accounts.set(accountKey, account);
    while (this.accounts.size > this.options.maxAccounts) {
      this.accounts.delete(this.accounts.keys().next().value!);
    }
    if (account.inFlight) {
      const result = await account.inFlight;
      return { ...result, contacts: result.contacts.map(copyContact), failures: result.failures.map((failure) => ({ ...failure })) };
    }
    const pending = this.refresh(account, env, options);
    account.inFlight = pending;
    try {
      return await pending;
    } finally {
      if (account.inFlight === pending) account.inFlight = undefined;
    }
  }

  clear(accountKey?: string): void {
    if (accountKey === undefined) this.accounts.clear();
    else this.accounts.delete(accountKey);
  }

  getMyUid(accountKey: string): string {
    return this.accounts.get(accountKey)?.myUid ?? '';
  }

  private updateSource(
    cached: SourceCache,
    received: ContactListBranchResult,
    source: 'regular' | 'stranger',
    at: number,
  ): void {
    cached.initialized = true;
    if (received.complete) {
      // 成功空结果必须清除旧会话；只有失败/部分结果才合并旧数据。
      cached.contacts = received.contacts.map(copyContact);
      cached.complete = true;
      cached.failure = undefined;
      cached.blockedUntil = 0;
      cached.rateLimitCount = 0;
      cached.nextRefreshAt = at + (source === 'regular' ? this.options.regularTtlMs : this.options.strangerTtlMs);
      return;
    }
    cached.contacts = mergeContacts(cached.contacts, received.contacts);
    cached.complete = false;
    cached.failure = {
      source, error: received.error || '会话列表未完整加载',
      statusCode: received.statusCode, rateLimited: received.rateLimited,
    };
    let waitMs = this.options.retryMs;
    if (received.rateLimited) {
      cached.rateLimitCount++;
      waitMs = Math.min(this.options.rateLimitMaxMs,
        this.options.rateLimitBaseMs * 2 ** Math.min(cached.rateLimitCount - 1, 20));
      cached.blockedUntil = at + waitMs;
    } else {
      cached.rateLimitCount = 0;
      cached.blockedUntil = 0;
    }
    cached.nextRefreshAt = at + waitMs;
  }

  private async refresh(
    account: AccountCache,
    env: RequestEnv,
    options: { refreshRegular?: boolean; refreshStrangers?: boolean },
  ): Promise<ContactCacheResult> {
    const at = this.now();
    const includeRegular = Boolean(options.refreshRegular) || !account.regular.initialized || at >= account.regular.nextRefreshAt;
    // 显式刷新陌生人也遵守限流冷却，避免连续 list 重试同一限流接口。
    const includeStrangers = at >= account.stranger.blockedUntil &&
      (Boolean(options.refreshStrangers) || !account.stranger.initialized || at >= account.stranger.nextRefreshAt);
    if (includeRegular || includeStrangers) {
      let result: ContactListResult;
      try {
        result = await this.dependencies.fetchContacts(env, { includeRegular, includeStrangers });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failed = (): ContactListBranchResult => ({
          contacts: [], complete: false, pages: 0, error: message,
          rateLimited: /too many requests|rate.?limit|HTTP (409|429)/i.test(message),
        });
        result = {
          contacts: [], complete: false,
          regular: includeRegular ? failed() : null,
          stranger: includeStrangers ? failed() : null,
        };
      }
      const completedAt = this.now();
      if (includeRegular && result.regular) this.updateSource(account.regular, result.regular, 'regular', completedAt);
      if (includeStrangers && result.stranger) this.updateSource(account.stranger, result.stranger, 'stranger', completedAt);
    }

    // 普通会话优先，防止重复 conversationId 被陌生人占位名覆盖。
    const contacts = mergeContacts(account.stranger.contacts, account.regular.contacts);
    const myUid = await this.resolveMyUid(account, env, contacts);
    this.correctPeers(contacts, myUid);
    const namesStale = await this.fillNames(account, env, contacts);
    // 内部参与者数据只用于身份确认后的 peer 校正，不给命令/JSON 输出暴露。
    for (const contact of contacts) delete contact._participants;
    const failures = [account.regular.failure, account.stranger.failure]
      .filter((failure): failure is ContactCacheFailure => failure !== undefined)
      .map((failure) => ({ ...failure }));
    const complete = account.regular.complete && account.stranger.complete;
    return {
      contacts, myUid, identityError: account.identityError,
      complete, stale: !complete || namesStale || Boolean(account.identityError), failures,
    };
  }

  private async resolveMyUid(account: AccountCache, env: RequestEnv, contacts: ContactItem[]): Promise<string> {
    const containsUid = (uid: string): boolean => contacts.every((contact) => {
      const match = contact.conversationId.match(/^0:1:([1-9]\d*):([1-9]\d*)$/);
      return !match || match[1] === uid || match[2] === uid;
    });
    if (account.myUid && !containsUid(account.myUid)) {
      account.myUid = '';
      account.identityError = '当前用户 UID 与会话参与者不一致，不能继续目标操作';
      account.identityRetryAt = this.now() + this.options.retryMs;
      return '';
    }
    const inferred = account.myUid || detectMyUid(contacts);
    if (inferred) {
      account.myUid = inferred;
      account.identityError = undefined;
      return inferred;
    }
    if (this.dependencies.fetchSelfUid && this.now() >= account.identityRetryAt) {
      try {
        const uid = await this.dependencies.fetchSelfUid(env);
        if (!uid || !/^[1-9]\d*$/.test(uid)) throw new Error('个人资料没有返回有效的数字 UID');
        if (!containsUid(uid)) throw new Error('个人资料 UID 不在当前会话参与者中');
        account.myUid = uid;
        account.identityError = undefined;
        return uid;
      } catch (error) {
        account.identityError = error instanceof Error ? error.message : String(error);
        account.identityRetryAt = this.now() + this.options.retryMs;
      }
    }
    account.identityError ??= '无法从会话唯一确认当前用户 UID';
    return '';
  }

  /** 用已确认身份校正所有私聊 UID/secUid；身份不明时不暴露猜测的对方信息。 */
  private correctPeers(contacts: ContactItem[], myUid: string): void {
    for (const contact of contacts) {
      const match = contact.conversationId.match(/^0:1:([1-9]\d*):([1-9]\d*)$/);
      if (!match) continue;
      if (!myUid || (match[1] !== myUid && match[2] !== myUid)) {
        contact.uid = '';
        contact.secUid = undefined;
        contact.nickname = '(身份未确认)';
        continue;
      }
      const peerUid = match[1] === myUid ? match[2] : match[1];
      const participant = contact._participants?.find((item) => item.uid === peerUid);
      if (participant) contact.secUid = participant.secUid || undefined;
      else if (contact.uid !== peerUid) contact.secUid = undefined;
      contact.uid = peerUid;
      if (contact.nickname.startsWith('(uid:')) contact.nickname = `(uid:${peerUid.slice(-6)})`;
    }
  }

  private async fillNames(account: AccountCache, env: RequestEnv, contacts: ContactItem[]): Promise<boolean> {
    const at = this.now();
    const secUids = [...new Set(contacts.map((contact) => contact.secUid).filter((uid): uid is string => Boolean(uid)))];
    const due = secUids.filter((uid) => {
      const cached = account.names.get(uid);
      return !cached || (at >= cached.expiresAt && at >= cached.retryAt);
    });
    if (due.length > 0) {
      let received: Map<string, { nickname: string }>;
      try {
        received = await this.dependencies.fetchNames(env, due);
      } catch {
        received = new Map();
      }
      const completedAt = this.now();
      for (const uid of due) {
        const previous = account.names.get(uid);
        const nickname = received.get(uid)?.nickname;
        const next = nickname ? {
          nickname, expiresAt: completedAt + this.options.nicknameTtlMs, retryAt: 0,
        } : {
          nickname: previous?.nickname, expiresAt: previous?.expiresAt ?? 0,
          retryAt: completedAt + this.options.retryMs,
        };
        account.names.delete(uid);
        account.names.set(uid, next);
      }
    }
    let stale = false;
    for (const contact of contacts) {
      if (!contact.secUid) continue;
      const cached = account.names.get(contact.secUid);
      if (cached?.nickname) contact.nickname = cached.nickname;
      else if (!contact.nickname || contact.nickname === '(pending)') contact.nickname = `(uid:${contact.uid.slice(-6)})`;
      if (!cached?.nickname || this.now() >= cached.expiresAt) stale = true;
      if (cached) {
        account.names.delete(contact.secUid);
        account.names.set(contact.secUid, cached);
      }
    }
    while (account.names.size > this.options.maxNicknames) {
      account.names.delete(account.names.keys().next().value!);
    }
    return stale;
  }
}
