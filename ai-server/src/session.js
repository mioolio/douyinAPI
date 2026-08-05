'use strict';

/**
 * 会话管理
 *
 * 加载会话历史 (messages 数组，不含 system)
 * 返回结构: { messages, savedAt, uid }
 */

const fs = require('fs');
const path = require('path');

const { MAX_HISTORY, userDir } = require('./config');
const { log, ts } = require('./logger');

// 内存缓存：会话
const sessionCache = new Map(); // uid -> messages[]

function sessionFile(uid) {
  return path.join(userDir(uid), 'session.json');
}

/**
 * 加载会话历史 (messages 数组，不含 system)
 * 返回结构: { messages, savedAt, uid }
 */
function loadSession(uid) {
  if (sessionCache.has(uid)) return sessionCache.get(uid);
  const file = sessionFile(uid);
  let data = { uid, messages: [], savedAt: null };
  if (fs.existsSync(file)) {
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (!Array.isArray(data.messages)) data.messages = [];
    } catch (e) {
      log(`[会话加载失败] uid=${uid} err=${e.message}`);
    }
  }
  sessionCache.set(uid, data);
  return data;
}

function saveSession(uid, data) {
  const file = sessionFile(uid);
  data.savedAt = ts();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
  sessionCache.set(uid, data);
}

/**
 * 追加一条消息到会话，并截断超过 MAX_HISTORY 的历史 (保留最近的)
 */
function appendMessage(uid, role, content) {
  const data = loadSession(uid);
  data.messages.push({ role, content, ts: ts() });
  // 截断：保留最近 MAX_HISTORY 条 (不含 system，system 每次实时拼)
  if (data.messages.length > MAX_HISTORY) {
    data.messages = data.messages.slice(-MAX_HISTORY);
  }
  saveSession(uid, data);
  return data;
}

module.exports = {
  loadSession,
  saveSession,
  appendMessage,
  sessionFile,
  sessionCache,
};
