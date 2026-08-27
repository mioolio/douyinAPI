/**
 * CLI UI 工具集
 *
 * 颜色常量、格式化函数、成功提示模板等。
 * 从 indexv2.ts 抽取，供所有命令模块复用。
 */

import type { MessageItem } from '../api/operations.js';
import { cliState } from './context.js';

// ============================ 颜色常量 ============================

export const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
};

// ============================ 格式化函数 ============================

export function formatMessageLine(m: MessageItem): string {
  const ts = m.timestamp
    ? new Date(m.timestamp).toLocaleString('zh-CN', { hour12: false })
    : '                   ';
  const typeTag = formatCategoryTag(m.category);
  const sender = m.senderLabel.padEnd(3, ' ');
  let content: string;
  if (m.category === 'video_share') {
    const author = m.videoAuthor ? `作者:${m.videoAuthor} ` : '';
    content = `${author}${m.text || '(无标题)'}`;
  } else if (m.category === 'system_tip') {
    content = m.text || '(系统提示)';
  } else if (m.category === 'image') {
    content = m.stickerUrl ? `${m.text || '[图片]'} ${m.stickerUrl}` : (m.text || '[图片]');
  } else if (m.category === 'sticker') {
    content = m.stickerUrl ? `${m.text} ${m.stickerUrl}` : (m.text || '[表情]');
  } else if (m.category === 'recall') {
    content = m.text || '撤回了一条消息';
  } else {
    content = m.text || '(空消息)';
  }
  const idSuffix = m.serverMsgId ? ` ${C.gray}[id:${m.serverMsgId}]${C.reset}` : '';
  return `  ${C.gray}[${ts}]${C.reset} ${typeTag} ${sender}: ${content}${idSuffix}`;
}

export function formatCategoryTag(category: string): string {
  const tag = (s: string, color: string) => `${color}[${s}]${C.reset}`;
  const pad = (s: string) => s.padEnd(6, ' ');
  switch (category) {
    case 'text':        return tag(pad('文本'), C.white);
    case 'video_share': return tag('分享视频', C.brightMagenta);
    case 'ai_text':     return tag(pad('AI回复'), C.brightBlue);
    case 'system_tip':  return tag('系统提示', C.gray);
    case 'image':       return tag(pad('图片'), C.brightGreen);
    case 'sticker':     return tag(pad('表情'), C.brightYellow);
    case 'recall':      return tag(pad('撤回'), C.yellow);
    default:            return tag(pad('未知'), C.dim);
  }
}

export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => {
    const maxRowLen = Math.max(...rows.map((r) => (r[i] || '').length));
    return Math.max(h.length, maxRowLen);
  });
  const pad = (s: string, i: number) => (s || '').padEnd(widths[i]);
  const sep = '─'.repeat(widths.reduce((a, b) => a + b + 3, 0));
  const headerLine = headers.map(pad).join(' │ ');
  const rowLines = rows.map((r) => r.map(pad).join(' │ '));
  return [headerLine, sep, ...rowLines].join('\n');
}

export function output<T>(data: T, pretty: (data: T) => void): void {
  if (cliState.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  } else {
    pretty(data);
  }
}

export function noticeTypeLabel(type: number): string {
  switch (type) {
    case 8:  return '新粉丝';
    case 31: return '评论';
    case 33: return '新粉丝';
    case 41: return '点赞';
    case 45: return '@提及';
    case 42: return '评论';
    case 44: return '@我';
    default: return `type=${type}`;
  }
}

export function truncate(s: string, max: number): string {
  const lines = s.replace(/\n/g, ' ').trim();
  return lines.length > max ? lines.slice(0, max) + '...' : lines;
}

/** 分隔线 */
export function divider(char = '─', len = 80, color = C.gray): string {
  return color + char.repeat(len) + C.reset;
}

/** 剥离 ANSI 颜色码，计算字符串可视宽度 */
export function visualWidth(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/**
 * 小猫 + 框 成功提示模板
 *
 * 布局：
 *   ⠀∧,,,∧    ~   ┏━━━━━━━━┓
 *   ( ̳• · • ̳)  ~   ┃ 消息 ┃
 *   /       づ  ~   ┗━━━━━━━━┛
 *
 * 框宽自适应消息长度，消息在框内居中。
 */
export function catBox(message: string, opts?: { color?: string }): void {
  const color = opts?.color ?? C.green;
  const catColor = C.brightYellow;
  const catLines = [
    '⠀∧,,,∧    ~   ',
    '( ̳• · • ̳)  ~   ',
    '/       づ  ~   ',
  ];
  const msgWidth = visualWidth(message);
  const innerWidth = Math.max(msgWidth + 2, 4);
  const horizontal = '━'.repeat(innerWidth);
  const padding = 1;
  const boxLines = [
    `${color}┏${horizontal}┓${C.reset}`,
    `${color}┃${C.reset}${' '.repeat(padding)}${message}${' '.repeat(padding)}${color}┃${C.reset}`,
    `${color}┗${horizontal}┛${C.reset}`,
  ];
  const lines = catLines.map((cat, i) => `${catColor}${cat}${C.reset}${boxLines[i]}`);
  process.stdout.write(lines.join('\n') + '\n');
}
