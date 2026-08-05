/**
 * 测试 v7：验证 direction=3 (FROM_LATEST) 修复 getHistory "conversation not found" 问题
 */
import path from 'node:path';
import { loadFromStorageState } from '../src/auth/session.js';
import {
  envFromSession,
  listContacts,
  getHistory,
} from '../src/api/operations.js';

const STORAGE_STATE = path.resolve(
  import.meta.dirname ?? __dirname,
  '..',
  '..',
  'ccc',
  'data',
  'storageState.json',
);

const MY_UID = '517231230585881';

async function main() {
  const session = await loadFromStorageState(STORAGE_STATE);
  const env = envFromSession(session);

  console.log('=== 1. listContacts ===');
  const contacts = await listContacts(env);
  console.log(`共 ${contacts.length} 个会话`);

  console.log('\n=== 2. getHistory - TwT (使用 direction=3 FROM_LATEST) ===');
  const twt = contacts.find((c) => c.uid === '1196717705541576');
  if (!twt) {
    console.error('未找到 TwT 会话');
    return;
  }
  console.log(`TwT: cid=${twt.conversationId} shortId=${twt.conversationShortId}`);

  const messages = await getHistory(env, twt.conversationId, {
    conversationShortId: twt.conversationShortId!,
    limit: 30,
    myUid: MY_UID,
  });
  console.log(`\n获取到 ${messages.length} 条消息:`);
  for (const m of messages.slice(0, 10)) {
    const time = m.timestamp ? new Date(m.timestamp).toLocaleString('zh-CN') : '?';
    const sender = m.isSelf ? '我' : 'TwT';
    console.log(`  [${time}] ${sender}: ${m.text.slice(0, 80)}`);
  }

  console.log('\n=== 3. 测试另一个会话 ===');
  const other = contacts.find((c) => c.unreadCount && c.unreadCount > 0 && c.uid !== '1196717705541576');
  if (other) {
    console.log(`测试会话: cid=${other.conversationId} shortId=${other.conversationShortId} unread=${other.unreadCount}`);
    const m2 = await getHistory(env, other.conversationId, {
      conversationShortId: other.conversationShortId!,
      limit: 5,
      myUid: MY_UID,
    });
    console.log(`  消息数: ${m2.length}`);
    for (const m of m2.slice(0, 3)) {
      const time = m.timestamp ? new Date(m.timestamp).toLocaleString('zh-CN') : '?';
      const sender = m.isSelf ? '我' : '对方';
      console.log(`    [${time}] ${sender}: ${m.text.slice(0, 60)}`);
    }
  }
}

main().catch((e) => {
  console.error('异常:', e);
  process.exit(1);
});
