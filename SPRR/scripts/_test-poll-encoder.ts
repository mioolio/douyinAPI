/**
 * 一次性校验脚本：轮询请求编码器 vs 抓包原始字节
 *
 * 用 buildRequest + buildPollBody/buildInitBody 重建抓包里的
 * cmd 2043/2048 请求，逐字节比对 bodyHex，验证协议还原正确。
 *
 * 运行：npx tsx scripts/_test-poll-encoder.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRequest, DEFAULT_UA, parseResponse } from '../src/api/imapi.js';
import {
  buildPollBody,
  buildInitBody,
  parsePollResponse,
  type PollCursors,
} from '../src/api/polling.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CAPTURE_ROOT = path.resolve(__dirname, '..', 'data', 'capture', 'debug');

const SESSION_09_07 = 'debug-20260907-043324/http';

interface Case {
  label: string;
  file: string;
  build: (seq: number) => Buffer;
}

function loadCapture(rel: string): { bodyHex: string; seq: number } {
  const full = path.join(CAPTURE_ROOT, rel);
  const d = JSON.parse(fs.readFileSync(full, 'utf-8')) as {
    request: { bodyHex: string; protoDump: { f2: number } };
  };
  return { bodyHex: d.request.bodyHex, seq: d.request.protoDump.f2 };
}

const env = {
  cookie: 'sessionid=dummy',
  userAgent: DEFAULT_UA,
  screenWidth: 1463,
  screenHeight: 915,
};

const cases: Case[] = [
  {
    label: '9/7 #008 poll(f5=空)',
    file: `${SESSION_09_07}/008-cmd2048-v1-message-get_user_message.json`,
    build: (seq) =>
      buildRequest({
        cmd: 2048,
        sequenceId: seq,
        inboxType: 1,
        body: buildPollBody(
          {
            messageCursorUs: 1788726745118835n,
            inboxSeq: 209561n,
            auxTsUs: 1788722949503009n,
          },
          '',
        ),
        env,
      }),
  },
  {
    label: '9/7 #031 poll(f5=cursor)',
    file: `${SESSION_09_07}/031-cmd2048-v1-message-get_user_message.json`,
    build: (seq) =>
      buildRequest({
        cmd: 2048,
        sequenceId: seq,
        inboxType: 1,
        body: buildPollBody({
          messageCursorUs: 1788726745118835n,
          inboxSeq: 209561n,
          auxTsUs: 1788726813527477n,
        }),
        env,
      }),
  },
  {
    label: '9/7 #001 init({f2:0})',
    file: `${SESSION_09_07}/001-cmd2043-v1-message-get_message_by_init.json`,
    build: (seq) =>
      buildRequest({
        cmd: 2043,
        sequenceId: seq,
        inboxType: 1,
        body: buildInitBody(),
        env,
      }),
  },
  {
    label: '9/7 #007 init(增量)',
    file: `${SESSION_09_07}/007-cmd2043-v1-message-get_message_by_init.json`,
    build: (seq) =>
      buildRequest({
        cmd: 2043,
        sequenceId: seq,
        inboxType: 1,
        body: buildInitBody(1783411913522396n),
        env,
      }),
  },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const cap = loadCapture(c.file);
  const rebuilt = c.build(cap.seq);
  const ok = rebuilt.toString('hex') === cap.bodyHex;
  if (ok) {
    pass++;
    console.log(`  ✓ ${c.label} (${rebuilt.length}B 逐字节一致)`);
  } else {
    fail++;
    console.log(`  ✗ ${c.label}`);
    console.log(`      抓包: ${cap.bodyHex.slice(0, 200)}`);
    console.log(`      重建: ${rebuilt.toString('hex').slice(0, 200)}`);
    const a = Buffer.from(cap.bodyHex, 'hex');
    for (let i = 0; i < Math.max(a.length, rebuilt.length); i++) {
      if (a[i] !== rebuilt[i]) {
        console.log(
          `      首个差异 @${i}: 抓包=0x${(a[i] ?? 0).toString(16)} 重建=0x${(rebuilt[i] ?? 0).toString(16)}`,
        );
        break;
      }
    }
  }
}
console.log(`\n── 响应解析校验 ──`);

function loadRespBody(rel: string): Buffer {
  const d = JSON.parse(fs.readFileSync(path.join(CAPTURE_ROOT, rel), 'utf-8')) as {
    response: { bodyBase64: string };
  };
  // HTTP 响应体是 imapi Response 信封，取内层 field 6 body
  const envelope = parseResponse(Buffer.from(d.response.bodyBase64, 'base64'));
  return envelope.body;
}

interface RespCase {
  label: string;
  check: () => string | null; // null=通过，否则失败原因
}
const baseCursors: PollCursors = {
  messageCursorUs: 1788726745118835n,
  inboxSeq: 209561n,
  auxTsUs: 1788722949503009n,
};
const respCases: RespCase[] = [
  {
    // 9/7 #046：852B 已读回执事件响应
    label: '9/7 #046 事件响应（50001 已读回执）',
    check: () => {
      const r = parsePollResponse(
        loadRespBody(`${SESSION_09_07}/046-cmd2048-v1-message-get_user_message.json`),
        baseCursors,
      );
      if (r.messages.length !== 0) return `messages 应为 0，实际 ${r.messages.length}`;
      if (r.events.length !== 1) return `events 应为 1，实际 ${r.events.length}`;
      const ev = r.events[0];
      if (ev.eventType !== 50001) return `eventType 应为 50001，实际 ${ev.eventType}`;
      if (r.next.inboxSeq !== 209564n) return `next.inboxSeq 应为 209564，实际 ${r.next.inboxSeq}`;
      if (!ev.payloadJson?.includes('read_index')) return `payloadJson 应含 read_index`;
      return null;
    },
  },
  {
    // 8/25 #029：6796B 新消息响应
    label: '8/25 #029 新消息响应',
    check: () => {
      const r = parsePollResponse(
        loadRespBody('debug-20260825-025507/http/029-cmd2048-v1-message-get_user_message.json'),
        { ...baseCursors, inboxSeq: 203649n },
      );
      if (r.messages.length !== 1) return `messages 应为 1，实际 ${r.messages.length}`;
      const m = r.messages[0];
      if (m.conversationId !== '0:1:106346672952:1196717705541576')
        return `cid 不匹配: ${m.conversationId}`;
      if (m.message.serverMsgId !== '7677674108075689521')
        return `serverMsgId 不匹配: ${m.message.serverMsgId}`;
      if (m.message.senderId !== '106346672952') return `senderId 不匹配: ${m.message.senderId}`;
      if (r.next.messageCursorUs !== 1787597816555149n)
        return `next.messageCursorUs 不匹配: ${r.next.messageCursorUs}`;
      if (r.next.inboxSeq !== 203651n) return `next.inboxSeq 应为 203651，实际 ${r.next.inboxSeq}`;
      return null;
    },
  },
  {
    // 9/7 #008：170B 空轮询
    label: '9/7 #008 空轮询响应',
    check: () => {
      const r = parsePollResponse(
        loadRespBody(`${SESSION_09_07}/008-cmd2048-v1-message-get_user_message.json`),
        baseCursors,
      );
      if (r.messages.length !== 0 || r.events.length !== 0)
        return `应为空，实际 msgs=${r.messages.length} events=${r.events.length}`;
      if (r.next.inboxSeq !== 209561n) return `seq 不应变化: ${r.next.inboxSeq}`;
      return null;
    },
  },
];

let rpass = 0;
let rfail = 0;
for (const c of respCases) {
  try {
    const err = c.check();
    if (err === null) {
      rpass++;
      console.log(`  ✓ ${c.label}`);
    } else {
      rfail++;
      console.log(`  ✗ ${c.label}: ${err}`);
    }
  } catch (e) {
    rfail++;
    console.log(`  ✗ ${c.label}: 异常 ${e}`);
  }
}
console.log(`\n结果: 请求编码 ${pass}/${pass + fail} 通过, 响应解析 ${rpass}/${rpass + rfail} 通过`);
process.exit(fail + rfail > 0 ? 1 : 0);
