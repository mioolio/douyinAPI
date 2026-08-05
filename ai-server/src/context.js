'use strict';

/**
 * 历史上下文管理
 *
 * 通过 /inject-context 接口注入的历史聊天记录。
 * 以结构化消息数组（{role, content}）持久化到用户专用目录，
 * chat.js 在构造请求时，把这些消息作为对话上下文插入到 messages 数组中
 * （system 之后、近期 session 之前），而非塞入 system prompt。
 *
 * 这样做的好处：
 *   - 避免污染 system prompt（防止提示词注入攻击）
 *   - AI 以"之前聊过这些"的对话历史形式理解，而非系统指令
 *   - 持久化到文件，ai-server 重启后仍可加载
 *
 * 文件位置：data/users/<uid>/context.json
 * 文件结构：{ messages: [{role, content, ts}], injectedAt, msgCount }
 */

const fs = require('fs');
const path = require('path');

const { userDir } = require('./config');

// 内存缓存：uid -> { messages, injectedAt, msgCount }
const _contextCache = new Map();

function contextFile(uid) {
  return path.join(userDir(uid), 'context.json');
}

/**
 * 注入历史上下文（覆盖式）
 * @param {string} uid 用户 ID
 * @param {Array<{role: string, content: string, ts?: string}>} messages 结构化消息数组
 * @param {number} msgCount 消息条数
 */
function injectContext(uid, messages, msgCount) {
  const data = {
    messages,
    injectedAt: new Date().toISOString(),
    msgCount: msgCount || messages.length,
  };
  // 持久化到文件
  const file = contextFile(uid);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
  // 更新内存缓存
  _contextCache.set(uid, data);
}

/**
 * 获取注入的上下文消息数组
 * @param {string} uid 用户 ID
 * @returns {Array<{role: string, content: string}>|null} 消息数组，未注入返回 null
 */
function getInjectedContextMessages(uid) {
  // 优先读内存缓存
  if (_contextCache.has(uid)) {
    return _contextCache.get(uid).messages;
  }
  // 回退到文件
  const file = contextFile(uid);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!Array.isArray(data.messages)) return null;
    _contextCache.set(uid, data);
    return data.messages;
  } catch (e) {
    return null;
  }
}

/**
 * 清除注入的上下文
 * @param {string} uid 用户 ID
 */
function clearInjectedContext(uid) {
  _contextCache.delete(uid);
  const file = contextFile(uid);
  try { fs.unlinkSync(file); } catch {}
}

/**
 * 获取所有注入上下文的状态（用于调试）
 */
function getInjectedContextStats() {
  const result = [];
  for (const [uid, data] of _contextCache) {
    result.push({
      uid,
      injectedAt: data.injectedAt,
      msgCount: data.msgCount,
      messageCount: data.messages.length,
    });
  }
  return result;
}

module.exports = {
  injectContext,
  getInjectedContextMessages,
  clearInjectedContext,
  getInjectedContextStats,
  contextFile,
};
