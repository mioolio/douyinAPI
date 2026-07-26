/**
 * IM SDK Bridge
 *
 * 通过 window.__VMOK_@pc-im/im:* 桥接抖音 PC 网页版的 IM SDK。
 * 所有调用均在浏览器 page.evaluate 中执行，由 SDK 处理
 * protobuf 编码 / 签名 / 加密 / HTTP 请求。
 *
 * 关键路径：
 *   window.__VMOK_@pc-im/im:1.0.0.696__
 *     .get('.') -> async () => mod
 *     mod.Context.instance
 *       .imSdkService
 *         .conversationListManager.getAllConversation()  // 同步返回 Map
 *         .conversationManager.getOrCreatePrivateConversationByUid(uid)
 *         .sendMessageManager.createMessageBuilder(opts)  // 链式 builder
 *       .store
 *         .conversationStore
 *           .conversationMap / setCurConversation / sortedConversationIdList
 *         .curMessageListStore
 *           .curMessageMapArray (_array / _map)
 *           .loadMessage / setCurMessageList
 *         .usersInfoStore
 *           .usersInfoMap / getUserBySecUid
 *
 * builder 链式 API（基于探查结果）：
 *   const b = smm.createMessageBuilder({messageType:700, from:'chat', enterMethod:'chat'});
 *   b.toUid(uid);
 *   b.content({aweType:700, type:0, text:'...', richTextInfos:[]});  // 自动 JSON.stringify
 *   b.callback({onSendSuccess, onSendFailed, onSendFinished});
 *   b.send();  // 触发实际发送，结果通过 callback 回调
 */

import type { Page } from 'playwright';
import { createLogger } from '../utils/logger.js';

const log = createLogger('im-bridge');

/** window.__getImInstance 由 browser.ts 的 addInitScript 注入 */
declare global {
  interface Window {
    __getImInstance: () => Promise<ImSdkInstance>;
  }
}

/** IM SDK 实例的最小类型占位（实际结构由 page.evaluate 内部消费） */
export interface ImSdkInstance {
  imSdkService: {
    conversationListManager: any;
    conversationManager: any;
    sendMessageManager: any;
    [k: string]: any;
  };
  store: {
    conversationStore: any;
    curMessageListStore: any;
    usersInfoStore: any;
    [k: string]: any;
  };
  [k: string]: any;
}

/** 联系人/会话条目 */
export interface ContactItem {
  conversationId: string;
  uid: string;
  secUid?: string;
  nickname: string;
  remark?: string;
  lastMessage: string;
  lastMessageTs?: number;
  unreadCount?: number;
  isPinned?: boolean;
  isStranger?: boolean;
  conversationType?: number;
  /** 会话 short_id（部分接口需要） */
  conversationShortId?: string;
}

/** 消息条目 */
export interface MessageItem {
  msgId: string;
  serverMsgId?: string;
  conversationId: string;
  senderId: string;
  isSelf: boolean;
  messageType: number;
  text: string;
  contentJson?: string;
  timestamp?: number;
  status?: string;
}

/** 发送结果 */
export interface SendResultData {
  success: boolean;
  msgId?: string;
  serverMsgId?: string;
  reason?: string;
}

/**
 * IM SDK Bridge
 */
export class ImBridge {
  constructor(private page: Page) {}

  /**
   * 列出所有会话（联系人）
   *
   * 流程：
   * 1. 等 conversationMap 填充（SDK 异步拉取）
   * 2. 遍历 conversationMap，从 cid 解析对方 uid
   * 3. 用 secUid 调 usersInfoStore.getUserBySecUid() 查 nickname（同步）
   * 4. 缺失的 secUid 批量调 doRequestUsersInfoIfNeeded 异步拉取，再查一次
   * 5. lastMessage 通过 conversation 的 getter 获取
   */
  async listConversations(waitMs = 15_000): Promise<ContactItem[]> {
    log.debug(`listConversations: 调用 SDK (waitMs=${waitMs})`);
    const items = await this.page.evaluate(
      async (waitMs: number) => {
        const instance = await window.__getImInstance();
        const svc = instance.imSdkService;
        const cs = instance.store.conversationStore;
        const us = instance.store.usersInfoStore;

        // 等待 conversationMap 和 usersInfoMap 都填充（SDK 异步拉取）
        const start = Date.now();
        while (Date.now() - start < waitMs) {
          const hasConv = cs.conversationMap && cs.conversationMap.size > 0;
          const hasUsers = us.usersInfoMap && us.usersInfoMap.size > 0;
          if (hasConv && hasUsers) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        if (!cs.conversationMap || cs.conversationMap.size === 0) return [];

        // 当前登录 uid（用于从 cid 解析对方 uid）
        const myUid = us.curLoginUserInfo
          ? String(us.curLoginUserInfo.uid || us.curLoginUserInfo.user_id || '')
          : '';

        // 第一遍：收集所有 conversation + 缺失的 secUid
        const convList: any[] = [];
        const missingSecUids: string[] = [];
        for (const [cid, conv] of cs.conversationMap.entries()) {
          const secUid = String(conv.toParticipantSecUserId || conv._toParticipantSecUserId || '');
          // 从 cid 解析对方 uid（cid 格式: "0:1:A:B"，A 或 B 之一是 myUid）
          let uid = '';
          const parts = String(cid).split(':');
          if (parts.length >= 4) {
            const a = parts[2];
            const b = parts[3];
            if (myUid && a === myUid) uid = b;
            else if (myUid && b === myUid) uid = a;
            else uid = b; // fallback
          }
          convList.push({ cid, conv, secUid, uid });
          // 检查 usersInfoMap 是否有该用户
          if (secUid) {
            const info = us.usersInfoMap && us.usersInfoMap.get ? us.usersInfoMap.get(uid) : null;
            if (!info) missingSecUids.push(secUid);
          }
        }

        // 批量拉取缺失的用户信息（异步）
        if (missingSecUids.length > 0 && typeof us.doRequestUsersInfoIfNeeded === 'function') {
          try {
            await us.doRequestUsersInfoIfNeeded(missingSecUids);
          } catch {}
        }

        // 第二遍：组装结果
        const items = [];
        for (const { cid, conv, secUid, uid } of convList) {
          // 查 nickname
          let nickname = '';
          let remark: string | undefined;
          let secUidOut = secUid;
          if (uid && us.usersInfoMap && us.usersInfoMap.get) {
            const info = us.usersInfoMap.get(uid);
            if (info) {
              nickname = String(info.nickname || '');
              secUidOut = String(info.sec_uid || secUid);
            }
          }
          if (!nickname && secUid && typeof us.getUserBySecUid === 'function') {
            try {
              const info = us.getUserBySecUid(secUid);
              if (info) {
                nickname = String(info.nickname || '');
                if (info.sec_uid) secUidOut = String(info.sec_uid);
              }
            } catch {}
          }

          // lastMessage（通过 getter，content 可能是 JSON 字符串或纯文本）
          let lastText = '';
          let ts: number | undefined;
          try {
            const lm = conv.lastMessage;
            if (lm) {
              const content = typeof lm.content === 'string' ? lm.content : '';
              const lmExt = (lm.ext || {}) as Record<string, string>;
              lastText = content || '';
              // JSON 解析尝试提取友好文本
              if (lastText.startsWith('{')) {
                try {
                  const j = JSON.parse(lastText);
                  if (j && typeof j === 'object') {
                    lastText =
                      j.text ||
                      j.content_title ||
                      j.aweme_title ||
                      j.msgHint ||
                      j.hint_content ||
                      j.tips ||
                      (j.display_name ? `[表情] ${j.display_name}` : '') ||
                      lastText;
                  }
                } catch {}
              }
              // 时间戳：优先 ext 中的 s:server_message_create_time，其次 createdAt
              const sct = lmExt['s:server_message_create_time'];
              if (sct) {
                const n = Number(sct);
                if (!Number.isNaN(n) && n > 0) ts = n > 1e12 ? n : n * 1000;
              }
              if (ts === undefined) {
                const ca = (lm as any).createdAt;
                if (typeof ca === 'number') {
                  ts = ca > 1e12 ? ca : ca * 1000;
                } else if (typeof ca === 'string') {
                  const n = Number(ca);
                  if (!Number.isNaN(n) && n > 0) ts = n > 1e12 ? n : n * 1000;
                }
              }
            }
          } catch {}

          items.push({
            conversationId: String(cid),
            uid,
            secUid: secUidOut || undefined,
            nickname: nickname || '(未知)',
            remark,
            lastMessage: lastText,
            lastMessageTs: ts,
            unreadCount:
              typeof conv.unreadCount === 'number' ? conv.unreadCount : undefined,
            isPinned: Boolean(conv.isPinned ?? conv.isStickOnTop ?? conv.pinTime),
            isStranger: Boolean(conv.isStranger),
            conversationType:
              typeof conv.conversationType === 'number' ? conv.conversationType : undefined,
            conversationShortId:
              conv.conversationShortId !== undefined
                ? String(conv.conversationShortId)
                : undefined,
          });
        }
        // 按 sortOrder 降序（最近在前）
        items.sort((a, b) => {
          const sa = cs.conversationMap.get(a.conversationId)?.sortOrder || 0;
          const sb = cs.conversationMap.get(b.conversationId)?.sortOrder || 0;
          return sb - sa;
        });
        return items;
      },
      waitMs,
    );
    log.info(`listConversations: 共 ${items.length} 个会话`);
    return items as ContactItem[];
  }

  /**
   * 根据 uid 获取或创建私聊会话
   */
  async getOrCreatePrivateConversationByUid(uid: string): Promise<string> {
    log.debug(`getOrCreatePrivateConversationByUid: uid=${uid}`);
    const cid = await this.page.evaluate(async (targetUid: string) => {
      const instance = await window.__getImInstance();
      const cm = instance.imSdkService.conversationManager;
      const conv = await cm.getOrCreatePrivateConversationByUid(targetUid);
      const id =
        (conv && (conv.conversationId || conv.id)) ||
        (conv && conv._raw && conv._raw.conversationId) ||
        '';
      if (!id) {
        return { error: 'no-cid', conv: JSON.stringify(conv).slice(0, 500) };
      }
      return { cid: String(id) };
    }, uid);
    if (typeof cid === 'object' && cid !== null && 'error' in cid) {
      throw new Error(`getOrCreatePrivateConversationByUid 失败: ${cid.error} conv=${cid.conv}`);
    }
    const cidStr = (cid as { cid: string }).cid;
    log.info(`getOrCreatePrivateConversationByUid: uid=${uid} -> cid=${cidStr}`);
    return cidStr;
  }

  /**
   * 发送文本消息（使用 builder 链式 API + sendMessage 直接调用）
   *
   * 关键点：
   * 1. 必须显式获取 conversation 并设置到 builder（否则 sendMessage 会静默失败）
   * 2. 用 smm.sendMessage(builder, {}) 直接调用，避免 builder.send() 内部黑盒
   * 3. 通过 callback 收集结果
   */
  async sendTextMessage(uid: string, text: string): Promise<SendResultData> {
    log.info(`sendTextMessage: uid=${uid} text=${JSON.stringify(text)}`);
    const result = await this.page.evaluate(
      async (args: { targetUid: string; msgText: string }) => {
        const diag: string[] = [];
        try {
          const instance = await window.__getImInstance();
          const smm = instance.imSdkService.sendMessageManager;
          const cm = instance.imSdkService.conversationManager;

          // 1. 显式获取/创建 conversation
          const conv = await cm.getOrCreatePrivateConversationByUid(args.targetUid);
          diag.push('conv:' + (conv ? 'ok' : 'null'));
          if (!conv) {
            return { success: false, reason: 'no-conv', diag: [...diag] } as SendResultData;
          }

          // 2. 创建 builder 并配置
          const builder = smm.createMessageBuilder({
            messageType: 700,
            from: 'chat',
            enterMethod: 'chat',
          });
          builder.toUid(args.targetUid);
          builder.conversation(conv); // 关键：必须设置 conversation
          builder.content({
            aweType: 700,
            type: 0,
            text: args.msgText,
            richTextInfos: [],
          });

          // 3. 用 Promise 包装回调
          const result = await new Promise<SendResultData>((resolve) => {
            let settled = false;
            const finish = (r: SendResultData) => {
              if (settled) return;
              settled = true;
              resolve(r);
            };

            builder.callback({
              onSendBefore: () => { diag.push('cb:before'); },
              onSendReady: () => { diag.push('cb:ready'); },
              onSendSuccess: (msg: any) => {
                diag.push('cb:success');
                const m = msg || {};
                const ext = m.ext || m.localExt || {};
                const clientId = ext['s:client_message_id'] || m.clientId || m.id || '';
                const serverId = m.serverId || m.serverMessageId || '';
                finish({
                  success: true,
                  msgId: String(clientId),
                  serverMsgId: String(serverId),
                });
              },
              onSendFailed: (msg: any, err: any) => {
                diag.push('cb:failed');
                const m = msg || {};
                const ext = m.ext || m.localExt || {};
                finish({
                  success: false,
                  msgId: String(ext['s:client_message_id'] || m.clientId || ''),
                  reason: err ? String(err && err.message ? err.message : err) : 'send-failed',
                });
              },
              onSendFinished: (msg: any) => {
                diag.push('cb:finished');
                const m = msg || {};
                const ext = m.ext || m.localExt || {};
                const clientId = ext['s:client_message_id'] || m.clientId || '';
                const serverId = m.serverId || '';
                setTimeout(() => {
                  finish({
                    success: Boolean(serverId),
                    msgId: String(clientId),
                    serverMsgId: String(serverId),
                    reason: serverId ? undefined : 'no-server-id',
                  });
                }, 100);
              },
            });

            // 4. 用 smm.sendMessage 直接调用（避开 builder.send() 黑盒）
            try {
              const sendPromise = smm.sendMessage(builder, {});
              diag.push('sendMessage:returned:' + typeof sendPromise);
              if (sendPromise && typeof sendPromise.then === 'function') {
                sendPromise.then(
                  (v: any) => { diag.push('sendMessage:resolved:' + (v === undefined ? 'undefined' : JSON.stringify(v).slice(0, 100))); },
                  (e: any) => {
                    diag.push('sendMessage:rejected:' + String(e && e.message ? e.message : e));
                    finish({ success: false, reason: 'sendMessage-rejected: ' + String(e && e.message ? e.message : e) });
                  },
                );
              }
            } catch (e: any) {
              diag.push('sendMessage:throws:' + String(e && e.message ? e.message : e));
              finish({ success: false, reason: 'sendMessage-throws: ' + String(e && e.message ? e.message : e) });
            }

            // 总体超时兜底
            setTimeout(() => {
              finish({ success: false, reason: 'timeout-15s', diag: [...diag] } as SendResultData);
            }, 15000);
          });
          return { ...result, diag: [...diag] } as SendResultData;
        } catch (e: any) {
          return {
            success: false,
            reason: 'evaluate-error: ' + String(e && e.message ? e.message : e),
            stack: e && e.stack ? String(e.stack).slice(0, 1000) : undefined,
            diag: [...diag],
          } as SendResultData;
        }
      },
      { targetUid: uid, msgText: text },
    );
    log.info(
      `sendTextMessage: success=${result.success} msgId=${result.msgId} serverMsgId=${result.serverMsgId} reason=${result.reason || ''}`,
    );
    if ((result as any).diag) log.info(`sendTextMessage diag: ${(result as any).diag.join(' | ')}`);
    if (result.reason && result.reason.startsWith('evaluate-error')) {
      log.error(`sendTextMessage evaluate 异常: ${result.reason}`);
      if ((result as any).stack) log.error(`stack: ${(result as any).stack}`);
    }
    return result as SendResultData;
  }

  /**
   * 获取会话历史消息
   *
   * 流程：getConversationById -> setCurConversation -> 等 curMessageListStore 更新 -> 读取
   */
  async getHistory(
    conversationId: string,
    opts: { limit?: number; waitMs?: number } = {},
  ): Promise<MessageItem[]> {
    const waitMs = opts.waitMs ?? 5000;
    log.info(`getHistory: cid=${conversationId} waitMs=${waitMs}`);
    const items = await this.page.evaluate(
      async (args: { cid: string; waitMs: number }) => {
        const instance = await window.__getImInstance();
        const cs = instance.store.conversationStore;
        const cms = instance.store.curMessageListStore;
        const us = instance.store.usersInfoStore;

        // 当前登录 uid（用于判断 isSelf）
        const myUid = us.curLoginUserInfo
          ? String(us.curLoginUserInfo.uid || us.curLoginUserInfo.user_id || '')
          : '';

        // 1. 拿到 conversation 对象
        let conv = null;
        if (cs.conversationMap && cs.conversationMap.get) {
          conv = cs.conversationMap.get(args.cid);
        }
        if (!conv) {
          // 尝试用 conversationManager.getConversationById
          try {
            conv = instance.imSdkService.conversationManager.getConversationById(args.cid);
          } catch {}
        }
        if (!conv) {
          return { error: 'conversation-not-found', cid: args.cid };
        }

        // 2. 切到该会话（触发消息拉取）
        try {
          cs.setCurConversation(conv);
        } catch (e) {
          return { error: 'set-cur-failed', err: String(e) };
        }

        // 3. 等 curMessageListStore 更新
        const start = Date.now();
        let arr = null;
        while (Date.now() - start < args.waitMs) {
          arr =
            (cms.curMessageMapArray && cms.curMessageMapArray._array) ||
            null;
          if (arr && arr.length > 0) break;
          await new Promise((r) => setTimeout(r, 300));
        }
        if (!arr) {
          return { error: 'no-messages', cid: args.cid };
        }

        // 4. 映射消息
        const out = [];
        for (const mRaw of arr) {
          const m = mRaw as Record<string, unknown>;
          // ext 是普通对象，键形如 "s:client_message_id" / "s:server_message_create_time"
          const ext = (m.ext || {}) as Record<string, string>;
          const contentStr = typeof m.content === 'string' ? m.content : '';
          // text 在 content JSON 的 text 字段
          let text = '';
          try {
            const j = JSON.parse(contentStr);
            if (j && typeof j === 'object') {
              text = String(j.text || j.content_title || j.aweme_title || j.msgHint || '');
            }
          } catch {
            text = contentStr;
          }
          // 时间戳：优先 ext 中的 s:server_message_create_time，其次 createdAt
          let ts: number | undefined;
          const sct = ext['s:server_message_create_time'];
          if (sct) {
            const n = Number(sct);
            if (!Number.isNaN(n) && n > 0) ts = n > 1e12 ? n : n * 1000;
          }
          if (ts === undefined) {
            const ca = m.createdAt as number | string | undefined;
            if (typeof ca === 'number') {
              ts = ca > 1e12 ? ca : ca * 1000;
            } else if (typeof ca === 'string') {
              const n = Number(ca);
              if (!Number.isNaN(n) && n > 0) ts = n > 1e12 ? n : n * 1000;
            }
          }
          // isSelf 用 sender 对比 myUid（isMyMessage 字段对 AI 消息不可靠）
          const senderStr = String(m.sender || m.secSender || '');
          const isSelf = myUid !== '' && senderStr === myUid;
          out.push({
            msgId: String(ext['s:client_message_id'] || ''),
            serverMsgId: m.serverId !== undefined && m.serverId !== null ? String(m.serverId) : undefined,
            conversationId: String(m.conversationId || ''),
            senderId: senderStr,
            isSelf,
            messageType: typeof m.type === 'number' ? m.type : 700,
            text,
            contentJson: contentStr || undefined,
            timestamp: ts,
            status: typeof m.serverStatus === 'number' ? String(m.serverStatus) : undefined,
          });
        }
        // 按时间升序排列
        out.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        return { items: out };
      },
      { cid: conversationId, waitMs },
    );
    if (typeof items === 'object' && items !== null && 'error' in items) {
      log.warn(`getHistory: ${items.error} (cid=${items.cid || conversationId})`);
      return [];
    }
    const list = (items as { items: MessageItem[] }).items || [];
    log.info(`getHistory: 共 ${list.length} 条`);
    return list;
  }

  /**
   * 通过 uid 拉取历史（先 getOrCreate 再 getHistory）
   */
  async getHistoryByUid(
    uid: string,
    opts: { limit?: number; waitMs?: number } = {},
  ): Promise<{ conversationId: string; messages: MessageItem[] }> {
    const cid = await this.getOrCreatePrivateConversationByUid(uid);
    const messages = await this.getHistory(cid, opts);
    return { conversationId: cid, messages };
  }
}
