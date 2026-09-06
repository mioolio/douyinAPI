/**
 * 一次性实测脚本：轮询同步真实链路（只读，不发送任何消息）
 *
 * 1. 从 storageState 加载账号 cookie
 * 2. cmd2043 init 同步 → 打印初始游标
 * 3. cmd2048 轮询 5 次（间隔 3s）→ 打印消息/事件/游标推进
 *
 * 运行：npx tsx scripts/_test-poll-live.ts [账号名]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadFromStorageState } from '../src/auth/session.js';
import { envFromSession } from '../src/api/operations.js';
import { initMessageSync, pollUserMessage } from '../src/api/polling.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const account = process.argv[2] || '1';
const statePath = path.resolve(__dirname, '..', 'data', 'accounts', `${account}.json`);

const session = await loadFromStorageState(statePath);
if (!session) {
  console.error(`无法从 ${statePath} 加载会话`);
  process.exit(1);
}
const env = envFromSession(session);
console.log(`账号 ${account} cookie 加载成功（${session.cookie.length} 字符）`);

console.log('\n── cmd2043 init ──');
const cursors = await initMessageSync(env);
console.log('初始游标:', {
  messageCursorUs: cursors.messageCursorUs.toString(),
  inboxSeq: cursors.inboxSeq.toString(),
  auxTsUs: cursors.auxTsUs.toString(),
});

console.log('\n── cmd2048 轮询 5 次 ──');
let cur = cursors;
for (let i = 1; i <= 5; i++) {
  try {
    const r = await pollUserMessage(env, cur);
    cur = r.next;
    console.log(
      `#${i}: msgs=${r.messages.length} events=${r.events.length} next(seq=${cur.inboxSeq}, cursor=${cur.messageCursorUs})`,
    );
    for (const m of r.messages) {
      console.log(
        `   [消息] cid=${m.conversationId} sender=${m.message.senderId} isSelf=${m.message.isSelf} type=${m.message.messageType} text=${(m.message.text || '').slice(0, 30)}`,
      );
    }
    for (const ev of r.events) {
      console.log(
        `   [事件] cid=${ev.conversationId} type=${ev.eventType} ts=${ev.tsMs} payload=${(ev.payloadJson || '').slice(0, 60)}`,
      );
    }
  } catch (e) {
    console.log(`#${i}: 失败 ${e}`);
  }
  if (i < 5) await new Promise((r) => setTimeout(r, 3000));
}
console.log('\n实测完成');
