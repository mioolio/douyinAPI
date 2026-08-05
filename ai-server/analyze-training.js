'use strict';

/**
 * 真人聊天风格分析工具（训练数据生成器）
 *
 * 读取所有用户的聊天记录，用极致推理（reasoning=high）分析真人说话的
 * 语气、性格特点、上下文语义，生成 training.json。
 *
 * AI 对话时会参考 training.json 学习真人风格。
 *
 * 用法：
 *   node analyze-training.js              # 分析所有用户的所有聊天记录
 *   node analyze-training.js --uid xxx    # 仅分析指定用户
 *   node analyze-training.js --limit 200  # 限制每个用户最多读取的轮次数
 *
 * 生成文件：ai-server/training.json
 * 手动运行，建议在停机维护时执行。
 */

const fs = require('fs');
const path = require('path');

// 复用 src/ 模块
const { config, DATA_DIR, userDir } = require('./src/config');
const { log, ts } = require('./src/logger');
const { callDeepSeek } = require('./src/deepseek');

// ============================ 参数解析 ============================

const args = process.argv.slice(2);
let filterUid = '';
let limitPerUser = 0; // 0=不限制

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--uid' && args[i + 1]) {
    filterUid = args[i + 1];
    i++;
  } else if (args[i] === '--limit' && args[i + 1]) {
    limitPerUser = parseInt(args[i + 1], 10) || 0;
    i++;
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log('用法: node analyze-training.js [--uid <uid>] [--limit <n>]');
    console.log('  --uid <uid>     仅分析指定用户');
    console.log('  --limit <n>     每个用户最多读取的轮次数（默认不限制）');
    process.exit(0);
  }
}

// ============================ 读取聊天记录 ============================

const usersDir = path.join(DATA_DIR, 'users');

if (!fs.existsSync(usersDir)) {
  log('[错误] 未找到 data/users 目录，无聊天记录可分析');
  process.exit(1);
}

/**
 * 收集所有用户的聊天记录
 * @returns {Array<{uid: string, turns: Array<{user: string, assistant: string}>}>}
 */
function collectAllTurns() {
  const result = [];
  const userDirs = fs.readdirSync(usersDir).filter((name) => {
    const fullPath = path.join(usersDir, name);
    return fs.statSync(fullPath).isDirectory();
  });

  for (const uid of userDirs) {
    if (filterUid && uid !== filterUid) continue;

    const dir = userDir(uid);
    const turns = [];

    // 读取所有日期文件（YYYYMMDD.json）
    const files = fs.readdirSync(dir).filter((f) => /^\d{8}\.json$/.test(f));
    files.sort(); // 按日期排序

    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
        if (!Array.isArray(data.turns)) continue;
        for (const turn of data.turns) {
          if (turn.user && turn.assistant) {
            turns.push({ user: turn.user, assistant: turn.assistant });
          }
        }
      } catch (e) {
        log(`[警告] 解析失败: ${file} ${e.message}`);
      }
    }

    if (turns.length === 0) continue;

    // 限制轮次数
    const limited = limitPerUser > 0 ? turns.slice(-limitPerUser) : turns;

    result.push({ uid, turns: limited });
    log(`[收集] uid=${uid} 轮次=${limited.length}`);
  }

  return result;
}

// ============================ 分析真人风格 ============================

/**
 * 构造分析 prompt
 *
 * 把真人聊天记录喂给 AI，让它分析真人说话的语气、性格特点、上下文语义，
 * 以及 AI 回复与真人回复的差异。
 */
function buildAnalysisPrompt(userData) {
  // 拼接所有对话记录
  const dialogueLines = [];
  let totalUser = 0;
  let totalAssistant = 0;
  let userMsgLens = [];

  for (const { uid, turns } of userData) {
    dialogueLines.push(`\n--- 用户 ${uid} 的对话记录 ---`);
    for (const t of turns) {
      dialogueLines.push(`真人: ${t.user}`);
      dialogueLines.push(`AI: ${t.assistant}`);
      totalUser++;
      totalAssistant++;
      userMsgLens.push(t.user.length);
    }
  }

  const avgUserLen = userMsgLens.length > 0
    ? Math.round(userMsgLens.reduce((a, b) => a + b, 0) / userMsgLens.length)
    : 0;
  const maxUserLen = userMsgLens.length > 0 ? Math.max(...userMsgLens) : 0;
  const minUserLen = userMsgLens.length > 0 ? Math.min(...userMsgLens) : 0;

  const dialogue = dialogueLines.join('\n');

  const systemPrompt = `你是一个专业的聊天风格分析师。你的任务是分析真人用户的聊天记录，总结真人的说话风格特点，并指导 AI 如何更像真人。

分析维度：
1. **语气特点**：真人说话的语气（随意/正式/幽默/冷淡/热情等）
2. **消息长度**：真人平均每条消息多少字，最长最短多少
3. **用词习惯**：真人常用词汇、口头禅、表情符号使用频率
4. **回复节奏**：真人是否喜欢分多条消息发，还是一次性说完
5. **情感表达**：真人如何表达情感（直接/含蓄/夸张/克制）
6. **上下文连贯**：真人如何承接上下文，是否喜欢引用对方的话
7. **AI 与真人的差异**：AI 回复哪些地方不像真人（太长/太正式/爱解释/爱反问等）

请基于以下聊天记录进行分析。注意：真人消息标记为"真人:"，AI 回复标记为"AI:"。

统计信息：
- 真人消息总数：${totalUser}
- 真人消息平均长度：${avgUserLen} 字
- 真人消息最长：${maxUserLen} 字
- 真人消息最短：${minUserLen} 字

请输出 JSON 格式的分析报告。

**重要：JSON 格式要求**
- 所有字符串值必须用双引号包裹
- 字符串值内部**禁止使用双引号**，如需引用词语请用单引号或书名号
- 例如：不要写 "常用'啦'和'喵'"（双引号内嵌双引号会破坏 JSON），而要写 "常用'啦'和'喵'"（用单引号）
- 数组元素用双引号包裹
- 输出标准 JSON，不要用代码块包裹，不要输出其他内容

结构如下：
{
  "toneStyle": "语气特点描述（1-2句话）",
  "lengthPattern": "消息长度规律（1-2句话）",
  "wordHabit": "用词习惯描述（1-2句话）",
  "replyRhythm": "回复节奏描述（1-2句话）",
  "emotionStyle": "情感表达方式描述（1-2句话）",
  "contextHandling": "上下文处理方式描述（1-2句话）",
  "aiProblems": ["AI回复的问题1", "AI回复的问题2", "AI回复的问题3"],
  "suggestions": "给AI的改进建议（2-3句话，具体可执行）",
  "exampleResponses": [
    {"situation": "当用户问时间", "goodResponse": "快三点啦", "badResponse": "现在是凌晨两点五十四分喵！主人怎么又问时间呢..."},
    {"situation": "当用户撒娇", "goodResponse": "嗯嗯~", "badResponse": "呜...主人不要撒娇嘛！咱最喜欢主人了..."}
  ]
}

只输出 JSON，不要用代码块包裹，不要输出其他内容。`;

  return {
    system: systemPrompt,
    user: `以下是聊天记录，请分析：\n\n${dialogue}`,
  };
}

/**
 * 尝试从 AI 输出中提取并解析 JSON
 * 支持容错：代码块包裹、未转义引号修复
 */
function parseAnalysisJson(text) {
  const trimmed = text.trim();

  // 1. 尝试直接解析
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    // 继续尝试
  }

  // 2. 尝试从 ```json 代码块提取
  const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1].trim());
    } catch (e) {
      // 继续尝试
    }
  }

  // 3. 尝试提取第一个 { 到最后一个 } 之间的内容
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const jsonStr = trimmed.slice(start, end + 1);
    try {
      return JSON.parse(jsonStr);
    } catch (e) {
      // 继续尝试修复
    }

    // 4. 修复常见 JSON 错误：字符串值内部的未转义双引号
    // 策略：把字符串值内部的双引号替换为单引号
    // 这是个简单的启发式修复，不完美但能处理大部分情况
    try {
      const fixed = fixUnescapedQuotes(jsonStr);
      return JSON.parse(fixed);
    } catch (e2) {
      // 放弃，返回原始文本
    }
  }

  return null;
}

/**
 * 修复 JSON 字符串值内部的未转义双引号
 *
 * 启发式：遍历字符串，跟踪是否在字符串内部，
 * 遇到字符串内部的双引号（后面不是 , : ] } 且前面不是 : [ , {）时替换为单引号
 */
function fixUnescapedQuotes(jsonStr) {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < jsonStr.length; i++) {
    const ch = jsonStr[i];

    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      result += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      if (!inString) {
        // 进入字符串
        inString = true;
        result += ch;
      } else {
        // 在字符串内，判断这个双引号是字符串结束还是未转义的内部引号
        // 向后看跳过空白，找下一个非空白字符
        let j = i + 1;
        while (j < jsonStr.length && /\s/.test(jsonStr[j])) j++;
        const nextCh = jsonStr[j];
        // 如果下一个字符是 JSON 结构字符，说明这个双引号是字符串结束
        if (nextCh === ':' || nextCh === ',' || nextCh === '}' || nextCh === ']' || nextCh === undefined) {
          inString = false;
          result += ch;
        } else {
          // 字符串内部的未转义双引号，替换为单引号
          result += "'";
        }
      }
    } else {
      result += ch;
    }
  }

  return result;
}

// ============================ 主流程 ============================

async function main() {
  log('========================================');
  log('  真人聊天风格分析工具');
  log('========================================');
  log(`时间: ${ts()}`);
  if (filterUid) log(`筛选用户: ${filterUid}`);
  if (limitPerUser > 0) log(`每用户轮次上限: ${limitPerUser}`);
  log('');

  // 1. 收集聊天记录
  log('[步骤 1/3] 收集聊天记录...');
  const userData = collectAllTurns();
  if (userData.length === 0) {
    log('[错误] 未收集到任何聊天记录');
    process.exit(1);
  }
  const totalTurns = userData.reduce((sum, u) => sum + u.turns.length, 0);
  log(`[完成] 共 ${userData.length} 个用户，${totalTurns} 轮对话`);
  log('');

  // 2. 构造分析 prompt 并调用 DeepSeek（极致推理）
  log('[步骤 2/3] 调用 DeepSeek 分析真人风格（极致推理 high）...');
  const prompt = buildAnalysisPrompt(userData);

  // 流式打印思考过程
  let reasoningStarted = false;
  const result = await callDeepSeek({
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    stream: true,
    reasoning: 'high', // 极致推理
    onReasoning: (delta) => {
      if (!reasoningStarted) {
        process.stdout.write('\n--- 分析思考过程（流式）---\n');
        reasoningStarted = true;
      }
      process.stdout.write(delta);
    },
  });
  if (reasoningStarted) {
    process.stdout.write('\n--- 分析思考过程结束 ---\n\n');
  }

  const analysisText = typeof result === 'string' ? result : (result.text || '');

  // 3. 解析 JSON 并保存 training.json
  log('[步骤 3/3] 保存训练数据...');

  // 容错解析 JSON（支持代码块包裹、未转义引号修复）
  let analysisJson = parseAnalysisJson(analysisText);
  if (!analysisJson) {
    log(`[警告] JSON 解析失败，保存原始文本`);
    analysisJson = { raw: analysisText, parseError: '无法解析为 JSON' };
  } else {
    log('[成功] JSON 解析成功');
  }

  const trainingData = {
    generatedAt: ts(),
    sampleCount: totalTurns,
    userCount: userData.length,
    analysis: analysisJson,
  };

  const trainingFile = path.join(__dirname, 'training', 'training.json');
  // 确保训练数据文件夹存在
  const trainingDir = path.dirname(trainingFile);
  if (!fs.existsSync(trainingDir)) {
    fs.mkdirSync(trainingDir, { recursive: true });
  }
  fs.writeFileSync(trainingFile, JSON.stringify(trainingData, null, 2), 'utf-8');
  log(`[完成] 训练数据已保存到: ${trainingFile}`);
  log('');

  // 打印分析摘要
  log('========================================');
  log('  分析报告摘要');
  log('========================================');
  if (analysisJson.toneStyle) log(`语气特点: ${analysisJson.toneStyle}`);
  if (analysisJson.lengthPattern) log(`长度规律: ${analysisJson.lengthPattern}`);
  if (analysisJson.suggestions) log(`改进建议: ${analysisJson.suggestions}`);
  if (Array.isArray(analysisJson.aiProblems)) {
    log('AI 问题:');
    analysisJson.aiProblems.forEach((p, i) => log(`  ${i + 1}. ${p}`));
  }
  log('');
  log('完成！AI 下次对话时将参考此训练数据。');
}

main().catch((e) => {
  log(`[致命错误] ${e.stack || e.message}`);
  process.exit(1);
});
