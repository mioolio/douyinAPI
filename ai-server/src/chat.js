'use strict';

/**
 * 核心对话逻辑
 *
 * 与指定用户对话
 *
 * 思考深度优先级：
 *   1. 请求体 opts.reasoning（运行时覆盖，最高）
 *   2. persona.reasoning（用户级 persona 文件配置）
 *   3. config.deepseek.reasoning（全局默认）
 *
 * @param {string} uid 用户 ID
 * @param {string} userMsg 用户消息
 * @param {object} opts { stream, onToken, onReasoning, unified, serverMsgId, reasoning }
 * @returns {Promise<string>} AI 回复正文（思考内容独立存档，不返回给调用方）
 */

const { DS_MODEL, DS_REASONING_MODEL } = require('./config');
const { log, naturalTime } = require('./logger');
const { normalizeReasoning, isReasoningOn, resolveReasoningForUid, buildReasoningInstruction } = require('./reasoning');
const { loadPersona } = require('./persona');
const { loadSession, appendMessage } = require('./session');
const { saveTurn } = require('./archive');
const { callDeepSeek } = require('./deepseek');
const { buildTrainingSection } = require('./training');
const { getInjectedContextMessages } = require('./context');

async function chatWithUser(uid, userMsg, opts) {
  opts = opts || {};
  const persona = loadPersona(uid);
  const session = loadSession(uid);

  // 确定本次思考深度：
  //   请求体 opts.reasoning（最高）> resolveReasoningForUid（persona > perUser > default）
  const reqReasoning = normalizeReasoning(opts.reasoning);
  const reasoningLevel = reqReasoning !== 'off'
    ? reqReasoning
    : resolveReasoningForUid(uid, persona.reasoning);
  const useReasoner = isReasoningOn(reasoningLevel);

  // 拼接 messages: system + 注入的历史上下文 + 近期会话 + 本次用户消息
  const messages = [];
  if (persona.systemPrompt) {
    let sysContent = persona.systemPrompt;
    // 在 system prompt 末尾追加思考指令（仅 reasoner 模式）
    const reasoningInst = buildReasoningInstruction(reasoningLevel);
    if (reasoningInst) sysContent += '\n\n' + reasoningInst;
    // 注入真人风格参考（training.json 存在时，热重载）
    const trainingSection = buildTrainingSection();
    if (trainingSection) sysContent += '\n\n' + trainingSection;
    // 追加当前时间（服务端直接生成，不依赖客户端传递）
    const timeInfo = `\n\n## 当前时间\n现在是 ${naturalTime()}。\n用户问时间相关问题时，必须用这个时间回答，不要编造时间。`;
    sysContent += timeInfo;
    messages.push({ role: 'system', content: sysContent });
  }
  // 注入历史上下文（作为对话消息，而非 system prompt，避免污染和提示词攻击）
  // 通过 /context 命令拉取的用户历史记录，持久化在 data/users/<uid>/context.json
  const injectedMessages = getInjectedContextMessages(uid);
  if (injectedMessages && injectedMessages.length > 0) {
    for (const m of injectedMessages) {
      messages.push({ role: m.role, content: m.content });
    }
    log(`[上下文] uid=${uid} 已加载 ${injectedMessages.length} 条历史上下文（作为对话消息）`);
  }
  for (const m of session.messages) {
    messages.push({ role: m.role, content: m.content });
  }
  messages.push({ role: 'user', content: userMsg });

  // 打印本次请求的 system prompt 和用户消息（不含历史记录），按标准分隔
  const usedModel = useReasoner ? DS_REASONING_MODEL : DS_MODEL;
  log(`\n========== [对话请求] uid=${uid} ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} ==========`);
  log(`[模型] ${usedModel}  [思考深度] ${reasoningLevel}`);
  if (messages[0] && messages[0].role === 'system') {
    log(`--- system prompt ---`);
    log(messages[0].content);
    log(`--- system prompt 结束 ---`);
  }
  log(`--- 用户消息 ---`);
  log(userMsg);
  log(`--- 用户消息结束 ---`);

  // 调 DeepSeek
  // 始终内部流式调用 DeepSeek，便于实时打印思考过程到终端
  // 对外（HTTP /chat）的流式/非流式行为由 opts.onToken/opts.onReasoning 决定
  let reasoningStarted = false;
  const result = await callDeepSeek({
    messages,
    stream: true, // 强制内部流式
    onToken: opts.onToken,
    onReasoning: (delta) => {
      // 终端实时打印思考过程（流式输出，不停顿）
      if (!reasoningStarted) {
        process.stdout.write('--- AI 思考过程（流式）---\n');
        reasoningStarted = true;
      }
      process.stdout.write(delta);
      // 同时推给 HTTP SSE 客户端（如果有的话）
      if (opts.onReasoning) opts.onReasoning(delta);
    },
    reasoning: reasoningLevel,
  });
  // 思考结束换行
  if (reasoningStarted) {
    process.stdout.write('\n--- AI 思考过程结束 ---\n');
  }
  // 兼容老调用方：callDeepSeek 现在返回 { text, reasoning }
  const aiText = typeof result === 'string' ? result : (result.text || '');
  const aiReasoning = (typeof result === 'object' && result.reasoning) ? result.reasoning : '';

  // 写入会话历史 (先存用户消息，再存 AI 回复)
  appendMessage(uid, 'user', userMsg);
  appendMessage(uid, 'assistant', aiText);

  // 存档单轮（按日期保存，含 serverMsgId 和 reasoning）
  saveTurn(uid, userMsg, aiText, {
    unified: opts.unified,
    serverMsgId: opts.serverMsgId,
    reasoning: reasoningLevel,
    reasoning_text: aiReasoning,
  });

  log(`[对话] uid=${uid} 人设=${persona.source} 统一=${!!opts.unified} 流式=${!!opts.stream} 思考=${reasoningLevel} msgId=${opts.serverMsgId || '-'}`);
  log(`--- AI 回复 ---`);
  log(aiText);
  log(`--- AI 回复结束 ---\n`);

  return aiText;
}

module.exports = {
  chatWithUser,
};
