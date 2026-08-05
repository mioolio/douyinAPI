'use strict';

/**
 * 日志 + 时间工具
 */

const { LOG_TO_CONSOLE } = require('./config');

function ts() {
  // 返回北京时间 ISO 字符串（便于人类阅读，UTC+8）
  const d = new Date();
  const beijing = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${beijing.getUTCFullYear()}-${p(beijing.getUTCMonth() + 1)}-${p(beijing.getUTCDate())}T${p(beijing.getUTCHours())}:${p(beijing.getUTCMinutes())}:${p(beijing.getUTCSeconds())}+08:00`;
}

/** 生成自然语言时间，让 AI 一眼看懂（北京时间） */
function naturalTime() {
  const d = new Date();
  const beijing = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  const h = beijing.getUTCHours();
  const m = beijing.getUTCMinutes();
  // 时段描述
  let period;
  if (h < 6) period = '凌晨';
  else if (h < 9) period = '早上';
  else if (h < 12) period = '上午';
  else if (h < 14) period = '中午';
  else if (h < 18) period = '下午';
  else if (h < 22) period = '晚上';
  else period = '深夜';
  const weekday = ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'][beijing.getUTCDay()];
  return `${beijing.getUTCFullYear()}年${beijing.getUTCMonth() + 1}月${beijing.getUTCDate()}日 ${weekday} ${period}${h}点${m}分（北京时间）`;
}

function tsFileName() {
  const d = new Date();
  const beijing = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${beijing.getUTCFullYear()}${p(beijing.getUTCMonth() + 1)}${p(beijing.getUTCDate())}-${p(beijing.getUTCHours())}${p(beijing.getUTCMinutes())}${p(beijing.getUTCSeconds())}`;
}

/** 日期文件名：YYYYMMDD（按北京时间） */
function dateFileName() {
  const d = new Date();
  const beijing = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${beijing.getUTCFullYear()}${p(beijing.getUTCMonth() + 1)}${p(beijing.getUTCDate())}`;
}

function log(line) {
  if (LOG_TO_CONSOLE) console.log(line);
  // 不为每条日志建文件，仅关键操作写存档
}

module.exports = {
  log,
  ts,
  naturalTime,
  tsFileName,
  dateFileName,
};
