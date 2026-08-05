'use strict';

/**
 * 人设管理
 *
 * 加载人设：优先用户专属 personas/<uid>.json，否则 default.json
 * 人设文件结构: { name, description, systemPrompt, identity, background, tone, reasoning }
 */

const fs = require('fs');
const path = require('path');

const { PERSONAS_DIR, DEFAULT_PERSONA_FILE, ensureDir } = require('./config');
const { log } = require('./logger');
const { normalizeReasoning } = require('./reasoning');

// 内存缓存：人设
const personaCache = new Map(); // uid -> { systemPrompt, ... }

/**
 * 将 JSON 对象（嵌套）格式化为可读的多行字符串
 * 例：{ "名字": "小嘴", "外貌": { "猫耳": "水绿色" } }
 * → 名字：小嘴
 *    外貌：
 *      猫耳：水绿色
 */
function formatNestedObject(obj, indent = 0) {
  const pad = '  '.repeat(indent);
  const lines = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      lines.push(`${pad}${k}：`);
      lines.push(formatNestedObject(v, indent + 1));
    } else if (Array.isArray(v)) {
      lines.push(`${pad}${k}：${v.join('、')}`);
    } else {
      lines.push(`${pad}${k}：${v}`);
    }
  }
  return lines.join('\n');
}

/**
 * 从人设文件的四个字段拼接完整 system prompt
 * 顺序：systemPrompt → 身份设定 → 背景设定 → 语气设定
 * 每个部分用清晰的标题分隔，方便 LLM 理解，同时人能直接读文件修改
 */
function buildSystemPrompt(raw) {
  const sections = [];

  // 1. 系统提示词（核心规则）
  if (raw.systemPrompt && typeof raw.systemPrompt === 'string' && raw.systemPrompt.trim()) {
    sections.push(raw.systemPrompt.trim());
  }

  // 2. 身份设定
  if (raw.identity && typeof raw.identity === 'object') {
    sections.push(
      '## 你的身份设定（请严格遵守，不要忘掉）\n' +
      formatNestedObject(raw.identity),
    );
  }

  // 3. 背景设定
  if (raw.background && typeof raw.background === 'object') {
    sections.push(
      '## 背景设定\n' +
      formatNestedObject(raw.background),
    );
  }

  // 4. 语气与行为风格
  if (raw.tone && typeof raw.tone === 'object') {
    sections.push(
      '## 语气与行为风格\n' +
      formatNestedObject(raw.tone),
    );
  }

  // 兜底：兼容旧版只有 systemPrompt 的文件
  if (sections.length === 0 && raw.systemPrompt) {
    return raw.systemPrompt;
  }

  return sections.join('\n\n');
}

function loadPersona(uid) {
  if (personaCache.has(uid)) return personaCache.get(uid);

  const userPersonaFile = path.join(PERSONAS_DIR, `${uid}.json`);
  let file = DEFAULT_PERSONA_FILE;
  let source = 'default';
  if (fs.existsSync(userPersonaFile)) {
    file = userPersonaFile;
    source = `user:${uid}`;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    // persona.reasoning 仅记录用户显式配置（off 表示未配置），
    // 最终思考深度由 resolveReasoningForUid 统一解析：
    //   persona.reasoning（显式）> reasoning.json.perUser[uid] > reasoning.json.defaultReasoning
    const persona = {
      name: raw.name || 'default',
      description: raw.description || '',
      systemPrompt: buildSystemPrompt(raw),
      source,
      reasoning: normalizeReasoning(raw.reasoning), // 仅记录显式配置，off=未配置
    };
    personaCache.set(uid, persona);
    return persona;
  } catch (e) {
    log(`[人设加载失败] uid=${uid} file=${file} err=${e.message}`);
    return { name: 'fallback', description: '', systemPrompt: '你是一个可爱的喵娘。', source: 'fallback', reasoning: 'off' };
  }
}

function savePersona(uid, personaObj) {
  ensureDir(PERSONAS_DIR);
  const file = path.join(PERSONAS_DIR, `${uid}.json`);
  fs.writeFileSync(file, JSON.stringify(personaObj, null, 2), 'utf-8');
  personaCache.delete(uid); // 清缓存，下次重新加载
}

module.exports = {
  loadPersona,
  savePersona,
  buildSystemPrompt,
  formatNestedObject,
  personaCache,
};
