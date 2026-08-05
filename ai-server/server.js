'use strict';

/**
 * AI 对话服务 (DeepSeek) - 入口文件
 *
 * - 独立 Node 服务，HTTP API，供 SPRR 抖音工具调用
 * - 白名单机制：默认不回复任何人，只有指定 user_id 才回复
 * - 每个白名单用户独立人设 + 独立会话上下文 (解耦)
 * - 统一模式：unified=true 额外写一份全局存档
 * - 存档：会话级 (每用户 session.json) + 轮次级 (每轮 timestamp.json)
 *
 * 仅用 Node 内置模块，无需 npm install。
 *
 * 模块化拆分后，本文件仅负责启动服务器，所有逻辑在 src/ 下。
 */

const { createServer } = require('./src/http-server');
const { log } = require('./src/logger');
const { PORT, BIND_HOST, DS_BASE, DS_KEY, DS_MODEL, DEFAULT_PERSONA_FILE, DATA_DIR, whitelist } = require('./src/config');

// 创建并启动服务器
const server = createServer();

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log(`[端口占用] ${PORT} 仍在使用，1 秒后重试...`);
    setTimeout(() => server.listen({ port: PORT, host: BIND_HOST, exclusive: false }), 1000);
  } else {
    log(`[监听错误] ${e.message}`);
  }
});

server.listen({ port: PORT, host: BIND_HOST, exclusive: false }, () => {
  const os = require('os');
  const nets = os.networkInterfaces();
  const lanIPs = [];
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) lanIPs.push(ni.address);
    }
  }
  const sep = '═'.repeat(70);
  log(sep);
  log('  AI 对话服务已启动 (ai-server)');
  log(`  监听绑定 : ${BIND_HOST}:${PORT}`);
  log(`  本机地址 : http://127.0.0.1:${PORT}`);
  for (const ip of lanIPs) log(`  局域网地址 : http://${ip}:${PORT}`);
  log(`  DeepSeek : ${DS_BASE} | 模型: ${DS_MODEL}`);
  log(`  API Key  : ${DS_KEY && !DS_KEY.includes('在此填入') ? `已配置 (${DS_KEY.slice(0, 8)}...)` : '⚠ 未配置，请编辑 config.json'}`);
  log(`  白名单   : ${whitelist.size} 个用户 ${whitelist.size ? '([' + Array.from(whitelist).join(', ') + '])' : '(默认拒绝所有人)'}`);
  log(`  默认人设 : ${DEFAULT_PERSONA_FILE}`);
  log(`  数据目录 : ${DATA_DIR}`);
  log('  用法: POST /chat { uid, message, stream?, unified? }');
  log(sep);
  log('等待请求...');
});

process.on('uncaughtException', (e) => log(`[未捕获异常] ${e.stack || e.message}`));
process.on('unhandledRejection', (e) => log(`[未处理 Promise] ${e}`));
