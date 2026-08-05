'use strict';

/**
 * 配置加载 + 常量导出 + 持久化工具
 *
 * 注意：本模块位于 src/ 下，引用根目录文件需要 path.join(__dirname, '..')
 */

const fs = require('fs');
const path = require('path');

// ============================ 配置加载 ============================

const configPath = path.join(__dirname, '..', 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const PORT = config.port || 7861;
const BIND_HOST = config.bindHost || '0.0.0.0';
const DS_BASE = (config.deepseek && config.deepseek.baseURL) || 'https://api.deepseek.com/v1';
const DS_KEY = (config.deepseek && config.deepseek.apiKey) || '';
const DS_MODEL = (config.deepseek && config.deepseek.model) || 'deepseek-chat';
const DS_REASONING_MODEL = (config.deepseek && config.deepseek.reasoningModel) || 'deepseek-reasoner';
const DS_TEMP = (config.deepseek && config.deepseek.temperature) ?? 0.85;
const DS_MAX_TOKENS = (config.deepseek && config.deepseek.maxTokens) || 1024;
const DS_TIMEOUT = (config.deepseek && config.deepseek.timeoutMs) || 60000;

const MAX_HISTORY = config.maxHistoryMessages || 30;
const DATA_DIR = path.join(__dirname, '..', config.dataDir || 'data');
const PERSONAS_DIR = path.join(__dirname, '..', 'personas');
const DEFAULT_PERSONA_FILE = path.join(__dirname, '..', config.defaultPersona || 'personas/default.json');
const LOG_TO_CONSOLE = config.logToConsole !== false;
const LOG_TO_FILE = config.logToFile !== false;

// 白名单：运行时可改，同时持久化到 config
const whitelist = new Set(Array.isArray(config.whitelist) ? config.whitelist : []);

// ============================ 持久化目录工具 ============================

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function userDir(uid) {
  const safe = String(uid).replace(/[^\w-]/g, '_');
  const dir = path.join(DATA_DIR, 'users', safe);
  ensureDir(dir);
  return dir;
}

function unifiedDir() {
  const dir = path.join(DATA_DIR, 'unified');
  ensureDir(dir);
  ensureDir(path.join(dir, 'turns'));
  return dir;
}

// ============================ 持久化白名单 ============================

function persistWhitelist() {
  config.whitelist = Array.from(whitelist);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

module.exports = {
  PORT,
  BIND_HOST,
  DS_BASE,
  DS_KEY,
  DS_MODEL,
  DS_REASONING_MODEL,
  DS_TEMP,
  DS_MAX_TOKENS,
  DS_TIMEOUT,
  MAX_HISTORY,
  DATA_DIR,
  PERSONAS_DIR,
  DEFAULT_PERSONA_FILE,
  LOG_TO_CONSOLE,
  LOG_TO_FILE,
  config,
  configPath,
  whitelist,
  ensureDir,
  userDir,
  unifiedDir,
  persistWhitelist,
};
