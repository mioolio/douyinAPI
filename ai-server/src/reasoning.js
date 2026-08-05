'use strict';

/**
 * reasoning 配置和解析
 *
 * 全局思考深度配置 reasoning.json 管理全局思考深度，支持热重载：
 *   {
 *     "defaultReasoning": "medium",      // 全局默认
 *     "perUser": { "<uid>": "high" }     // 按用户覆盖
 *   }
 *
 * 优先级（高 → 低）：
 *   1. 请求体 opts.reasoning     （运行时覆盖，最高）
 *   2. persona.reasoning         （用户级 persona 文件，显式配置才生效）
 *   3. reasoning.json.perUser    （全局配置文件的例外）
 *   4. reasoning.json.defaultReasoning（全局默认）
 */

const fs = require('fs');
const path = require('path');

const { log } = require('./logger');

const REASONING_CONFIG_FILE = path.join(__dirname, '..', 'reasoning.json');
let _reasoningConfig = { defaultReasoning: 'off', perUser: {} };
let _reasoningConfigMtime = 0;

/**
 * 规范化 reasoning 配置值
 * 接受：'off'/'low'/'medium'/'high' / true / false / undefined
 * 返回：'off' | 'low' | 'medium' | 'high'
 */
function normalizeReasoning(v) {
  if (v === true) return 'low';
  if (v === false || v === undefined || v === null) return 'off';
  const s = String(v).toLowerCase().trim();
  if (s === 'low' || s === 'medium' || s === 'high') return s;
  return 'off';
}

/** 判断 reasoning 等级是否启用深度思考 */
function isReasoningOn(level) {
  return level === 'low' || level === 'medium' || level === 'high';
}

/** 加载（或热重载）reasoning.json */
function loadReasoningConfig() {
  try {
    const stat = fs.statSync(REASONING_CONFIG_FILE);
    const mtime = stat.mtimeMs;
    // 文件未变化则跳过
    if (mtime === _reasoningConfigMtime) return _reasoningConfig;
    const raw = JSON.parse(fs.readFileSync(REASONING_CONFIG_FILE, 'utf-8'));
    _reasoningConfig = {
      defaultReasoning: normalizeReasoning(raw.defaultReasoning),
      perUser: {},
    };
    if (raw.perUser && typeof raw.perUser === 'object') {
      for (const [uid, level] of Object.entries(raw.perUser)) {
        _reasoningConfig.perUser[String(uid)] = normalizeReasoning(level);
      }
    }
    _reasoningConfigMtime = mtime;
    log(`[思考配置] 已加载 default=${_reasoningConfig.defaultReasoning} perUser=${Object.keys(_reasoningConfig.perUser).length}个`);
  } catch (e) {
    // 文件不存在或解析失败，保持当前配置不变
    log(`[思考配置] 加载失败: ${e.message}`);
  }
  return _reasoningConfig;
}

/**
 * 按 uid 解析最终思考深度（不含请求体覆盖，请求体覆盖在 chatWithUser 中处理）
 * 优先级：persona.reasoning（显式配置）> perUser[uid] > defaultReasoning
 */
function resolveReasoningForUid(uid, personaReasoning) {
  loadReasoningConfig(); // 触发热重载
  // persona 显式配置（非 off 时视为用户主动设置）
  if (personaReasoning && normalizeReasoning(personaReasoning) !== 'off') {
    return normalizeReasoning(personaReasoning);
  }
  // perUser 覆盖
  if (uid && _reasoningConfig.perUser[String(uid)]) {
    return _reasoningConfig.perUser[String(uid)];
  }
  // 全局默认
  return _reasoningConfig.defaultReasoning || 'off';
}

/**
 * 根据 reasoning 等级构造 system prompt 的思考指令
 * - off  : 不追加
 * - low  : 允许简要思考
 * - medium: 鼓励仔细思考
 * - high : 要求深入思考
 *
 * 注意：deepseek-reasoner 模型本身会通过 reasoning_content 字段独立返回思考过程，
 *       这里仅在 system prompt 中给模型一个「思考深度」的软引导，
 *       不要使用 <think> 标签（避免与模型原生 reasoning 重复）。
 */
function buildReasoningInstruction(level) {
  if (!isReasoningOn(level)) return '';
  const map = {
    low: '## 思考规则\n你可以在回答前简要思考一下，但不要在回复里输出思考过程。',
    medium: '## 思考规则\n回答前请仔细思考用户的真实意图和最合适的回复方式，但不要在回复里输出思考过程。',
    high: '## 思考规则\n回答前请深入思考：分析用户情绪、潜台词、上下文连贯性，给出最贴切自然的回复。不要在回复里输出思考过程。',
  };
  return map[level] || '';
}

module.exports = {
  normalizeReasoning,
  isReasoningOn,
  loadReasoningConfig,
  resolveReasoningForUid,
  buildReasoningInstruction,
};
