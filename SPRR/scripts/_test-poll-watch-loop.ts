/**
 * 一次性冒烟脚本：runPollingWatch 循环机制（只读）
 *
 * 验证：init → 循环轮询 → 10s 后发 SIGINT → 优雅退出。
 * 运行：npx tsx scripts/_test-poll-watch-loop.ts [账号名]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadFromStorageState } from '../src/auth/session.js';
import { envFromSession } from '../src/api/operations.js';
import { runPollingWatch } from '../src/commands/poll-watch.js';

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

let pollCount = 0;
setTimeout(() => {
  console.log('\n>>> 10s 到，触发 SIGINT');
  // Windows 上 process.kill(self, SIGINT) 会被无条件强杀，须用 emit 触发监听器
  process.emit('SIGINT');
}, 10_000);

try {
  await runPollingWatch({
    env,
    myUid: '0',
    intervalMs: 2000,
    onMessage: (m) => {
      pollCount++;
      console.log(`收到消息 #${pollCount}:`, m.conversationId, m.message.text?.slice(0, 20));
    },
  });
  console.log('>>> 循环已优雅退出（SIGINT 生效）');
  process.exit(0);
} catch (e) {
  console.error('>>> 循环异常退出:', e);
  process.exit(1);
}
