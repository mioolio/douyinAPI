'use strict';

/**
 * 训练数据管理（真人风格参考）
 *
 * 加载 ai-server/training.json（由 analyze-training.js 生成），
 * 在 AI 对话时注入 system prompt，让 AI 学习真人聊天风格。
 *
 * 特性：
 *   - training.json 不存在时，不注入（AI 正常对话，不参考真人风格）
 *   - training.json 存在时，自动热重载（修改后下次对话生效）
 *   - 注入内容精简，避免占用过多 token
 */

const fs = require('fs');
const path = require('path');
const { log } = require('./logger');

// 训练数据独立文件夹：ai-server/training/
const TRAINING_DIR = path.join(__dirname, '..', 'training');
const TRAINING_FILE = path.join(TRAINING_DIR, 'training.json');

let _trainingData = null;
let _trainingMtime = 0;

/**
 * 加载（或热重载）training/training.json
 * @returns {object|null} 训练数据对象，文件不存在返回 null
 */
function loadTrainingData() {
  try {
    if (!fs.existsSync(TRAINING_FILE)) {
      return null;
    }
    const stat = fs.statSync(TRAINING_FILE);
    const mtime = stat.mtimeMs;
    // 文件未变化则跳过
    if (mtime === _trainingMtime && _trainingData) return _trainingData;
    const raw = JSON.parse(fs.readFileSync(TRAINING_FILE, 'utf-8'));
    _trainingData = raw;
    _trainingMtime = mtime;
    log(`[训练数据] 已加载 sampleCount=${raw.sampleCount || 0} userCount=${raw.userCount || 0}`);
    return raw;
  } catch (e) {
    log(`[训练数据] 加载失败: ${e.message}`);
    return null;
  }
}

/**
 * 生成注入 system prompt 的真人风格参考段落
 *
 * 从 training.json 的 analysis 字段提取关键信息，
 * 精简后拼成一段参考文本。如果 training.json 不存在则返回空字符串。
 *
 * @returns {string} 注入段落，空字符串=不参考
 */
function buildTrainingSection() {
  const data = loadTrainingData();
  if (!data || !data.analysis) return '';

  const a = data.analysis;
  const lines = [];

  lines.push('## 真人风格参考（基于历史聊天记录分析，请学习真人说话方式）');

  if (a.toneStyle) lines.push(`- 语气特点：${a.toneStyle}`);
  if (a.lengthPattern) lines.push(`- 长度规律：${a.lengthPattern}`);
  if (a.wordHabit) lines.push(`- 用词习惯：${a.wordHabit}`);
  if (a.replyRhythm) lines.push(`- 回复节奏：${a.replyRhythm}`);
  if (a.emotionStyle) lines.push(`- 情感表达：${a.emotionStyle}`);
  if (a.contextHandling) lines.push(`- 上下文处理：${a.contextHandling}`);

  if (Array.isArray(a.aiProblems) && a.aiProblems.length > 0) {
    lines.push(`- AI 常见问题（请避免）：${a.aiProblems.join('；')}`);
  }

  if (a.suggestions) lines.push(`- 改进建议：${a.suggestions}`);

  // 注入示例（最多 3 个，避免 token 过多）
  if (Array.isArray(a.exampleResponses) && a.exampleResponses.length > 0) {
    lines.push('- 参考示例：');
    const examples = a.exampleResponses.slice(0, 3);
    for (const ex of examples) {
      if (ex.situation && ex.goodResponse) {
        lines.push(`  · ${ex.situation} → "${ex.goodResponse}"`);
      }
    }
  }

  return lines.join('\n');
}

module.exports = {
  loadTrainingData,
  buildTrainingSection,
};
