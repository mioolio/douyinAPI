/**
 * CLI UI 工具集
 *
 * 颜色常量、格式化函数、成功提示模板等。
 * 从 indexv2.ts 抽取，供所有命令模块复用。
 */

import type { MessageItem } from '../api/operations.js';
import { cliState } from './context.js';
import { stripVTControlCharacters } from 'node:util';

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
  const sender = padDisplay(m.senderLabel, 6);
  let content: string;
  if (m.category === 'video_share') {
    const author = m.videoAuthor ? `作者:${m.videoAuthor} ` : '';
    content = `${author}${m.text || '(无标题)'}`;
  } else if (m.category === 'system_tip') {
    content = cliState.verbose ? (m.text || '(系统提示)') : (m.text?.replace(/\{\{\d+\}\}/g, '').trim() || '(系统提示)');
  } else if (m.category === 'image') {
    content = m.text || (m.isEncryptedImage ? '[阅后即焚图片，尚未读取]' : '[图片]');
    if (cliState.verbose && m.stickerUrl) content += ` ${m.stickerUrl}`;
  } else if (m.category === 'sticker') {
    content = m.text || '[表情]';
    if (cliState.verbose && m.stickerUrl) content += ` ${m.stickerUrl}`;
  } else if (m.category === 'recall') {
    content = m.text || '撤回了一条消息';
  } else if (m.category === 'unknown' && !cliState.verbose) {
    content = m.text?.startsWith('[未识别消息') ? '[暂不支持的消息]' : (m.text || '[暂不支持的消息]');
  } else {
    content = m.text || '(空消息)';
  }
  const idSuffix = m.serverMsgId ? ` ${C.gray}[id:${m.serverMsgId}]${C.reset}` : '';
  return `  ${C.gray}[${ts}]${C.reset} ${typeTag} ${sender}: ${content}${idSuffix}`;
}

export function formatCategoryTag(category: string): string {
  const tag = (s: string, color: string) => `${color}[${s}]${C.reset}`;
  const pad = (s: string) => padDisplay(s, 8);
  switch (category) {
    case 'text':        return tag(pad('文本'), C.white);
    case 'video_share': return tag(pad('分享视频'), C.brightMagenta);
    case 'ai_text':     return tag(pad('AI回复'), C.brightBlue);
    case 'system_tip':  return tag(pad('系统提示'), C.gray);
    case 'image':       return tag(pad('图片'), C.brightGreen);
    case 'sticker':     return tag(pad('表情'), C.brightYellow);
    case 'recall':      return tag(pad('撤回'), C.yellow);
    default:            return tag(pad('未知'), C.dim);
  }
}

export function formatTable(headers: string[], rows: string[][]): string {
  const singleLine = (s: string) => s.replace(/[\r\n\t]+/g, ' ');
  const cells = rows.map((row) => headers.map((_, i) => singleLine(row[i] || '')));
  const titles = headers.map(singleLine);
  const widths = headers.map((h, i) => {
    const maxRowLen = Math.max(0, ...cells.map((r) => visualWidth(r[i])));
    return Math.max(visualWidth(h), maxRowLen);
  });
  const pad = (s: string, i: number) => padDisplay(s, widths[i]);
  const sep = '─'.repeat(widths.reduce((a, b) => a + b, 0) + Math.max(0, widths.length - 1) * 3);
  const headerLine = titles.map(pad).join(' │ ');
  const rowLines = cells.map((r) => r.map(pad).join(' │ '));
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

const graphemeSegments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function isWide(point: number): boolean {
  return point >= 0x1100 && (
    point <= 0x115f || point === 0x2329 || point === 0x232a ||
    (point >= 0x2e80 && point <= 0xa4cf && point !== 0x303f) ||
    (point >= 0xac00 && point <= 0xd7a3) || (point >= 0xf900 && point <= 0xfaff) ||
    (point >= 0xfe10 && point <= 0xfe19) || (point >= 0xfe30 && point <= 0xfe6f) ||
    (point >= 0xff00 && point <= 0xff60) || (point >= 0xffe0 && point <= 0xffe6) ||
    (point >= 0x1b000 && point <= 0x1b2ff) || (point >= 0x20000 && point <= 0x3fffd)
  );
}

/** Terminal columns: ignore ANSI and combining marks; CJK and emoji occupy two. */
export function visualWidth(s: string): number {
  let width = 0;
  for (const { segment } of graphemeSegments.segment(stripVTControlCharacters(s))) {
    if (/\p{Emoji_Presentation}|\u20e3/u.test(segment) ||
        (/\p{Extended_Pictographic}/u.test(segment) && segment.includes('\uFE0F'))) {
      width += 2;
      continue;
    }
    for (const char of segment) {
      if (/[\p{Mark}\p{Format}\p{Control}]/u.test(char)) continue;
      width += isWide(char.codePointAt(0)!) ? 2 : 1;
    }
  }
  return width;
}

function padDisplay(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - visualWidth(s)));
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
