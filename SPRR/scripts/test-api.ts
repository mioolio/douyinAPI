/**
 * 测试脚本：验证纯 API list/history 是否工作
 *
 * 步骤：
 *   1. 从 ../ccc/data/storageState.json 加载 cookie
 *   2. 调用 listContacts() - 验证会话列表接口
 *   3. 调用 getConversationInfo() - 验证 conversation_info 接口
 *   4. 调用 getHistory() - 验证历史消息接口（使用已知 cid）
 */
import path from 'node:path';
import { loadFromStorageState } from '../src/auth/session.js';
import {
  envFromSession,
  listContacts,
  getHistory,
  getConversationInfo,
  buildPrivateCid,
  extractUidFromCid,
} from '../src/api/operations.js';

const STORAGE_STATE = path.resolve(
  import.meta.dirname ?? __dirname,
  '..',
  '..',
  'ccc',
  'data',
  'storageState.json',
);

async function main() {
  console.log('=== 1. 加载 cookie ===');
  const session = await loadFromStorageState(STORAGE_STATE);
  const env = envFromSession(session);
  console.log(`uid_tt=${session.uid || '?'}`);

  // 已知数据（来自抓包）：
  // - myUid (从 session uid_tt 提取): 需要从 cookie 解析
  // - peerUid (TwT): 1196717705541576
  // - conversation_id: 0:1:517231230585881:1196717705541576
  // - conversation_short_id: 1742317111
  const myUid = session.cookies['uid_tt'] || '';
  console.log(`myUid (from uid_tt cookie)=${myUid || '(空)'}`);

  // 注意: uid_tt 是加密的 ID，不是真实 uid。真实 uid 需要从其他地方获取
  // 从抓包响应看，response.field 13 = 517231230585881 是真实 device_id
  // cid 中 517231230585881 是 myUid（设备 ID 而非用户 ID）
  // 让我们直接用抓包样本中的 cid 和 short_id 测试 history

  console.log('\n=== 2. listContacts ===');
  try {
    const items = await listContacts(env);
    console.log(`listContacts 返回 ${items.length} 个会话`);
    for (const c of items.slice(0, 5)) {
      console.log(`  - cid=${c.conversationId} uid=${c.uid} nick=${c.nickname}`);
    }
  } catch (e) {
    console.error('listContacts 失败:', e instanceof Error ? e.message : e);
  }

  console.log('\n=== 3. getConversationInfo (已知 cid) ===');
  const knownCid = '0:1:517231230585881:1196717705541576';
  try {
    const info = await getConversationInfo(env, [knownCid]);
    console.log(`getConversationInfo 返回 ${info.length} 条`);
    for (const c of info) {
      console.log(
        `  - cid=${c.conversationId} shortId=${c.conversationShortId} type=${c.conversationType}`,
      );
    }
  } catch (e) {
    console.error('getConversationInfo 失败:', e instanceof Error ? e.message : e);
  }

  console.log('\n=== 4. getHistory (已知 cid + short_id) ===');
  try {
    const messages = await getHistory(env, knownCid, {
      conversationShortId: 1742317111,
      limit: 20,
    });
    console.log(`getHistory 返回 ${messages.length} 条消息`);
    for (const m of messages.slice(0, 5)) {
      const ts = m.timestamp
        ? new Date(m.timestamp).toLocaleString('zh-CN', { hour12: false })
        : '?';
      console.log(
        `  [${ts}] ${m.isSelf ? '我' : m.senderId}: ${m.text || '(非文本)'} msgId=${m.msgId} serverId=${m.serverMsgId || '?'}`,
      );
    }
  } catch (e) {
    console.error('getHistory 失败:', e instanceof Error ? e.message : e);
  }

  console.log('\n=== 完成 ===');
}

main().catch((e) => {
  console.error('未捕获异常:', e);
  process.exit(1);
});
