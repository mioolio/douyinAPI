/**
 * 测试脚本：验证关闭浏览器后 access_key 是否有效
 *
 * 流程：
 *   1. 启动浏览器，提取 access_key
 *   2. 关闭浏览器
 *   3. 用 Node.js WebSocket 直连
 *   4. 等 5 秒后发送消息
 *   5. 等待 40 秒看是否收到推送
 *   6. 报告结果
 */

import path from 'node:path';
import { createLogger } from '../src/utils/logger.js';
import { extractWsAccessKey } from '../src/commands/extract-ws-key.js';
import { connectFrontier, parseFrontierFrame, type FrontierFrame } from '../src/api/frontier.js';
import { envFromSession, listContacts, sendMessage, buildPrivateCid, detectMyUid } from '../src/api/operations.js';
import { loadFromStorageState } from '../src/auth/session.js';
import { resolveStorageState } from '../src/auth/accounts.js';

const log = createLogger('test-ws');

async function main() {
  const { path: statePath } = await resolveStorageState();
  log.info(`storageState: ${statePath}`);

  // 1. 提取 access_key（会关闭浏览器）
  log.info('步骤1: 提取 access_key（启动浏览器，提取后关闭）...');
  const extracted = await extractWsAccessKey(statePath);
  log.info(`access_key=${extracted.accessKey.slice(0, 8)}... device_id=${extracted.deviceId}`);

  // 2. 加载 session 用于发消息
  const session = await loadFromStorageState(statePath);
  const env = envFromSession(session);

  // 3. Node.js 直连
  log.info('步骤2: Node.js WebSocket 直连（带 Cookie）...');
  const receivedFrames: FrontierFrame[] = [];
  let connected = false;

  const conn = connectFrontier({
    accessKey: extracted.accessKey,
    deviceId: extracted.deviceId,
    cookie: session.cookie,
    onOpen: () => {
      connected = true;
      log.info('[WS] 已连接');
    },
    onFrame: (frame) => {
      receivedFrames.push(frame);
      log.info(`[WS] 收到帧! msgId=${frame.msgId} payloadKeys=${frame.payload ? Object.keys(frame.payload).join(',') : 'none'}`);
      if (frame.payloadRaw) {
        // 尝试提取消息内容
        const textMatch = frame.payloadRaw.match(/"text":"([^"]+)"/);
        if (textMatch) log.info(`[WS] 消息内容: ${textMatch[1]}`);
      }
    },
    onClose: (code, reason) => {
      log.info(`[WS] 关闭 code=${code} reason=${reason}`);
    },
    onError: (err) => {
      log.error('[WS] 错误', err);
    },
  });

  // 4. 等待连接建立
  await new Promise((r) => setTimeout(r, 3000));
  if (!connected) {
    log.error('WS 连接失败');
    conn.close();
    process.exit(1);
  }

  // 5. 发送消息触发推送
  log.info('步骤3: 发送消息触发推送...');
  const contacts = await listContacts(env);
  const myUid = detectMyUid(contacts);
  const target = contacts.find((c) => c.nickname === 'TwT' || c.uid === '1196717705541576');
  if (!target) {
    log.error('找不到 TwT');
    conn.close();
    process.exit(1);
  }
  const cid = buildPrivateCid(myUid, target.uid);
  const result = await sendMessage(env, cid, 'ws-direct-test', {
    conversationShortId: target.conversationShortId!,
    conversationType: 1,
    ticket: target.remark || '',
  });
  log.info(`发送结果: success=${result.success} serverMsgId=${result.serverMsgId}`);

  // 6. 等待 30 秒看是否收到推送
  log.info('步骤4: 等待 30 秒看是否收到推送...');
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (receivedFrames.length > 0) {
      log.info(`已收到 ${receivedFrames.length} 帧，提前结束等待`);
      break;
    }
  }

  // 7. 报告结果
  log.info('-'.repeat(80));
  log.info(`测试结果: ${receivedFrames.length > 0 ? '成功 - 收到推送' : '失败 - 未收到推送'}`);
  log.info(`共收到 ${receivedFrames.length} 帧`);
  conn.close();
  process.exit(receivedFrames.length > 0 ? 0 : 1);
}

main().catch((e) => {
  log.error('测试失败', e);
  process.exit(1);
});
