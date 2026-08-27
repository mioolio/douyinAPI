'use strict';

/**
 * 免打扰计划任务管理
 *
 * 当用户对 AI 说「今晚到明早7点不要理我」时，AI 输出 <schedule> 标记，
 * chat.js 解析后调用本模块存储免打扰时间段。
 *
 * 在 start~end 时间段内，chat.js 收到该用户消息时直接返回 <fail>，
 * 不调用 DeepSeek，省钱且不打扰用户。
 *
 * 文件位置：data/users/<uid>/schedule.json
 * 文件结构：
 *   {
 *     schedules: [
 *       { start: "2026-08-06 19:00", end: "2026-08-07 07:00", reason: "...", createdAt: "..." }
 *     ]
 *   }
 *
 * 过期的 schedule 会在检查时自动清理（惰性删除）。
 */

const fs = require('fs');
const path = require('path');

const { userDir } = require('./config');

// 内存缓存：uid -> { schedules: [...] }
const _cache = new Map();

function scheduleFile(uid) {
  return path.join(userDir(uid), 'schedule.json');
}

/**
 * 加载用户的 schedule（带缓存）
 */
function loadSchedule(uid) {
  if (_cache.has(uid)) return _cache.get(uid);
  const file = scheduleFile(uid);
  let data = { schedules: [] };
  if (fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (Array.isArray(raw.schedules)) data = raw;
    } catch {}
  }
  _cache.set(uid, data);
  return data;
}

/**
 * 持久化 schedule 到文件
 */
function saveSchedule(uid) {
  const data = _cache.get(uid);
  if (!data) return;
  const file = scheduleFile(uid);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * 解析时间字符串为时间戳
 * 支持 "YYYY-MM-DD HH:mm" 格式
 */
function parseTime(str) {
  // 匹配 "YYYY-MM-DD HH:mm"
  const m = String(str).trim().match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  const dt = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+08:00`);
  const ts = dt.getTime();
  return isNaN(ts) ? null : ts;
}

/**
 * 检查用户当前是否在免打扰时间段内
 *
 * 同时清理已过期的 schedule（惰性删除）。
 *
 * @param {string} uid 用户 ID
 * @returns {{ silent: boolean, schedule?: object }} silent=true 表示应静音
 */
function checkSilent(uid) {
  const data = loadSchedule(uid);
  const now = Date.now();
  let changed = false;
  const active = [];

  for (const s of data.schedules) {
    const startTs = parseTime(s.start);
    const endTs = parseTime(s.end);
    // 无法解析或已过期 → 跳过（惰性删除）
    if (!startTs || !endTs || endTs <= now) {
      changed = true;
      continue;
    }
    active.push(s);
    // 当前时间在 [start, end) 内 → 静音
    if (now >= startTs && now < endTs) {
      if (changed) {
        data.schedules = active;
        saveSchedule(uid);
      }
      return { silent: true, schedule: s };
    }
  }

  // 清理过期 schedule
  if (changed) {
    data.schedules = active;
    saveSchedule(uid);
  }

  return { silent: false };
}

/**
 * 添加免打扰计划
 *
 * @param {string} uid 用户 ID
 * @param {string} start 开始时间 "YYYY-MM-DD HH:mm"
 * @param {string} end 结束时间 "YYYY-MM-DD HH:mm"
 * @param {string} reason 原因
 */
function addSchedule(uid, start, end, reason) {
  const data = loadSchedule(uid);
  data.schedules.push({
    start,
    end,
    reason: reason || '',
    createdAt: new Date().toISOString(),
  });
  saveSchedule(uid);
}

/**
 * 清除用户的所有免打扰计划
 */
function clearSchedule(uid) {
  const data = { schedules: [] };
  _cache.set(uid, data);
  saveSchedule(uid);
}

/**
 * 获取用户的 schedule 列表（用于调试/展示）
 */
function getScheduleList(uid) {
  const data = loadSchedule(uid);
  return data.schedules;
}

module.exports = {
  checkSilent,
  addSchedule,
  clearSchedule,
  getScheduleList,
  parseTime,
};
