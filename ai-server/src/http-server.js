'use strict';

/**
 * HTTP 服务器和路由
 */

const http = require('http');
const fs = require('fs');
const url = require('url');

const { DS_KEY, DS_MODEL, DS_REASONING_MODEL, whitelist, persistWhitelist } = require('./config');
const { log, ts } = require('./logger');
const { normalizeReasoning, isReasoningOn, resolveReasoningForUid } = require('./reasoning');
const { loadPersona, savePersona } = require('./persona');
const { loadSession, sessionFile, sessionCache } = require('./session');
const { chatWithUser } = require('./chat');
const { injectContext, clearInjectedContext, getInjectedContextStats } = require('./context');

// ============================ HTTP 工具 ============================

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': '*, Content-Type, Authorization',
  });
  res.end(body);
}

function sendSSEStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

// ============================ 路由 ============================

function createServer() {
  const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname || '/';
    const method = req.method || 'GET';

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': '*, Content-Type, Authorization',
      });
      res.end();
      return;
    }

    // ---------- 状态页 ----------
    if (pathname === '/' && method === 'GET') {
      return sendJSON(res, 200, {
        status: 'ok',
        service: 'ai-server (DeepSeek 对话服务)',
        model: DS_MODEL,
        whitelistSize: whitelist.size,
        whitelist: Array.from(whitelist),
        endpoints: {
          chat: 'POST /chat { uid, message, stream?, unified? }',
          history: 'GET /history/:uid',
          persona: 'GET/PUT /persona/:uid',
          whitelist: 'GET/POST/DELETE /whitelist',
          reset: 'POST /reset/:uid',
        },
      });
    }

    // ---------- 白名单管理 ----------
    if (pathname === '/whitelist' && method === 'GET') {
      return sendJSON(res, 200, { whitelist: Array.from(whitelist) });
    }

    if (pathname === '/whitelist' && method === 'POST') {
      let body = {};
      try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { return sendJSON(res, 400, { error: 'JSON 解析失败' }); }
      const uid = String(body.uid || '').trim();
      if (!uid) return sendJSON(res, 400, { error: '缺少 uid' });
      whitelist.add(uid);
      persistWhitelist();
      return sendJSON(res, 200, { ok: true, uid, whitelist: Array.from(whitelist) });
    }

    if (pathname === '/whitelist' && method === 'DELETE') {
      let body = {};
      try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { return sendJSON(res, 400, { error: 'JSON 解析失败' }); }
      const uid = String(body.uid || '').trim();
      if (!uid) return sendJSON(res, 400, { error: '缺少 uid' });
      whitelist.delete(uid);
      persistWhitelist();
      return sendJSON(res, 200, { ok: true, uid, whitelist: Array.from(whitelist) });
    }

    // ---------- 对话 ----------
    if (pathname === '/chat' && method === 'POST') {
      let body = {};
      try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { return sendJSON(res, 400, { error: 'JSON 解析失败' }); }
      const uid = String(body.uid || '').trim();
      const message = String(body.message || '').trim();
      const wantStream = body.stream === true;
      const unified = body.unified === true;
      const serverMsgId = String(body.serverMsgId || '').trim();
      // 运行时覆盖思考深度（可选）：'off' | 'low' | 'medium' | 'high'
      const reasoning = body.reasoning ? String(body.reasoning).trim() : '';

      if (!uid) return sendJSON(res, 400, { error: '缺少 uid' });
      if (!message) return sendJSON(res, 400, { error: '缺少 message' });

      // 白名单由调用方（SPRR）本地管理，ai-server 只负责对话，不再校验白名单

      if (!DS_KEY || DS_KEY.includes('在此填入')) {
        return sendJSON(res, 500, { error: 'DeepSeek API Key 未配置，请编辑 config.json' });
      }

      if (wantStream) {
        sendSSEStream(res);
        try {
          const full = await chatWithUser(uid, message, {
            stream: true,
            unified,
            serverMsgId,
            reasoning,
            onToken: (delta) => res.write(`data: ${JSON.stringify({ delta })}\n\n`),
            onReasoning: (delta) => res.write(`data: ${JSON.stringify({ reasoning: delta })}\n\n`),
          });
          res.write(`data: ${JSON.stringify({ done: true, full })}\n\n`);
          res.end();
        } catch (e) {
          res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
          res.end();
        }
        return;
      }

      try {
        const reply = await chatWithUser(uid, message, {
          stream: false,
          unified,
          serverMsgId,
          reasoning,
        });
        const persona = loadPersona(uid);
        const finalLevel = normalizeReasoning(reasoning) !== 'off'
          ? normalizeReasoning(reasoning)
          : resolveReasoningForUid(uid, persona.reasoning);
        const usedModel = isReasoningOn(finalLevel) ? DS_REASONING_MODEL : DS_MODEL;
        return sendJSON(res, 200, { ok: true, uid, reply, model: usedModel, reasoning: finalLevel, ts: ts() });
      } catch (e) {
        log(`[对话失败] uid=${uid} err=${e.message}`);
        return sendJSON(res, 500, { error: '对话失败: ' + e.message, uid });
      }
    }

    // ---------- 会话历史 ----------
    const historyMatch = pathname.match(/^\/history\/([^\/]+)$/);
    if (historyMatch && method === 'GET') {
      const uid = decodeURIComponent(historyMatch[1]);
      const data = loadSession(uid);
      return sendJSON(res, 200, data);
    }

    // ---------- 注入历史上下文 ----------
    // POST /inject-context { uid, messages, msgCount }
    // 把历史聊天记录（结构化消息数组）注入到指定用户的专用上下文文件，
    // AI 下次回复时作为对话上下文（而非 system prompt）参考
    if (pathname === '/inject-context' && method === 'POST') {
      let body = {};
      try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { return sendJSON(res, 400, { error: 'JSON 解析失败' }); }
      const uid = String(body.uid || '').trim();
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const msgCount = parseInt(body.msgCount, 10) || messages.length;
      if (!uid) return sendJSON(res, 400, { error: '缺少 uid' });
      if (messages.length === 0) return sendJSON(res, 400, { error: '缺少 messages' });
      injectContext(uid, messages, msgCount);
      log(`[注入上下文] uid=${uid} msgCount=${msgCount} messageCount=${messages.length}`);
      return sendJSON(res, 200, { ok: true, uid, msgCount, messageCount: messages.length });
    }

    // ---------- 清除注入的上下文 ----------
    // POST /clear-context/:uid
    const clearContextMatch = pathname.match(/^\/clear-context\/([^\/]+)$/);
    if (clearContextMatch && method === 'POST') {
      const uid = decodeURIComponent(clearContextMatch[1]);
      clearInjectedContext(uid);
      log(`[清除上下文] uid=${uid}`);
      return sendJSON(res, 200, { ok: true, uid, message: '注入的上下文已清除' });
    }

    // ---------- 注入上下文状态 ----------
    if (pathname === '/context-status' && method === 'GET') {
      return sendJSON(res, 200, { injected: getInjectedContextStats() });
    }

    // ---------- 重置会话 ----------
    const resetMatch = pathname.match(/^\/reset\/([^\/]+)$/);
    if (resetMatch && method === 'POST') {
      const uid = decodeURIComponent(resetMatch[1]);
      const file = sessionFile(uid);
      try { fs.unlinkSync(file); } catch {}
      sessionCache.delete(uid);
      log(`[重置会话] uid=${uid}`);
      return sendJSON(res, 200, { ok: true, uid, message: '会话已重置' });
    }

    // ---------- 人设管理 ----------
    const personaMatch = pathname.match(/^\/persona\/([^\/]+)$/);
    if (personaMatch && method === 'GET') {
      const uid = decodeURIComponent(personaMatch[1]);
      const persona = loadPersona(uid);
      return sendJSON(res, 200, persona);
    }
    if (personaMatch && method === 'PUT') {
      const uid = decodeURIComponent(personaMatch[1]);
      let body = {};
      try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { return sendJSON(res, 400, { error: 'JSON 解析失败' }); }
      if (!body.systemPrompt) return sendJSON(res, 400, { error: '缺少 systemPrompt' });
      const personaObj = {
        name: body.name || uid,
        description: body.description || '',
        systemPrompt: body.systemPrompt,
      };
      savePersona(uid, personaObj);
      log(`[人设更新] uid=${uid}`);
      return sendJSON(res, 200, { ok: true, uid, persona: { ...personaObj, source: `user:${uid}` } });
    }

    sendJSON(res, 404, { error: `未知路径: ${method} ${pathname}` });
  });

  return server;
}

module.exports = {
  createServer,
  sendJSON,
  sendSSEStream,
  readBody,
};
