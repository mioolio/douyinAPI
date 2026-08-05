'use strict';

/**
 * 存档管理
 *
 * 保存单轮对话（按日期追加到 <uid>/<YYYYMMDD>.json）
 *
 * 每天一个文件，包含当天所有对话轮次，避免碎片化小文件塞满硬盘。
 * 每条记录包含 serverMsgId（来自抖音消息 ID，用于去重判断）。
 *
 * 文件结构：
 * {
 *   "date": "20260806",
 *   "uid": "517231230585881",
 *   "turns": [
 *     { "ts": "...", "serverMsgId": "7670...", "user": "...", "assistant": "...", "model": "..." }
 *   ]
 * }
 */

const fs = require('fs');
const path = require('path');

const { DS_MODEL, DS_REASONING_MODEL, userDir, unifiedDir } = require('./config');
const { ts, dateFileName } = require('./logger');
const { normalizeReasoning, isReasoningOn } = require('./reasoning');

function saveTurn(uid, userMsg, aiMsg, opts) {
  const reasoningLevel = normalizeReasoning(opts.reasoning);
  const useReasoner = isReasoningOn(reasoningLevel);
  const turn = {
    ts: ts(),
    serverMsgId: opts.serverMsgId || '',
    user: userMsg,
    assistant: aiMsg,
    // 仅在启用深度思考时记录推理内容，避免存档膨胀
    ...(opts.reasoning_text ? { reasoning: opts.reasoning_text } : {}),
    model: useReasoner ? DS_REASONING_MODEL : DS_MODEL,
    reasoningLevel,
  };

  // 按日期保存到 <uid>/<YYYYMMDD>.json
  const dateFile = path.join(userDir(uid), `${dateFileName()}.json`);
  let dayData = { date: dateFileName(), uid, turns: [] };
  try {
    const existing = JSON.parse(fs.readFileSync(dateFile, 'utf-8'));
    if (Array.isArray(existing.turns)) {
      dayData = existing;
    }
  } catch {}
  dayData.turns.push(turn);
  fs.writeFileSync(dateFile, JSON.stringify(dayData, null, 2), 'utf-8');

  // 统一模式：额外追加到全局 <YYYYMMDD>.json
  if (opts.unified) {
    const uFile = path.join(unifiedDir(), `${dateFileName()}.json`);
    let uData = { date: dateFileName(), turns: [] };
    try {
      const uExisting = JSON.parse(fs.readFileSync(uFile, 'utf-8'));
      if (Array.isArray(uExisting.turns)) uData = uExisting;
    } catch {}
    uData.turns.push({ uid, ...turn });
    fs.writeFileSync(uFile, JSON.stringify(uData, null, 2), 'utf-8');
  }
}

module.exports = {
  saveTurn,
};
