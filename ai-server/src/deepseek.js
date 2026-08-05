'use strict';

/**
 * DeepSeek API 调用
 *
 * 调用 DeepSeek (OpenAI 兼容) 接口
 *
 * @param {object} opts
 *        - messages         消息数组
 *        - stream           是否流式
 *        - onToken          正文 token 回调
 *        - onReasoning      推理 token 回调（DeepSeek-R1 的 reasoning_content）
 *        - reasoning        思考深度 'off'|'low'|'medium'|'high'
 * @returns {Promise<{text: string, reasoning: string}>} 正文 + 推理内容
 */

const { DS_BASE, DS_KEY, DS_MODEL, DS_REASONING_MODEL, DS_TEMP, DS_MAX_TOKENS, DS_TIMEOUT } = require('./config');
const { normalizeReasoning, isReasoningOn } = require('./reasoning');

async function callDeepSeek(opts) {
  const { messages, stream, onToken, onReasoning } = opts;
  const reasoningLevel = normalizeReasoning(opts.reasoning);
  const useReasoner = isReasoningOn(reasoningLevel);
  const model = useReasoner ? DS_REASONING_MODEL : DS_MODEL;

  // 构造请求体
  // 注意：deepseek-reasoner 不支持 temperature/top_p/max_tokens/presence_penalty/frequency_penalty 等参数
  //       传了会返回 400，因此 reasoner 模式下必须省略这些字段
  const body = {
    model,
    messages,
    stream: !!stream,
  };
  if (!useReasoner) {
    body.temperature = DS_TEMP;
    body.max_tokens = DS_MAX_TOKENS;
  }

  const controller = new AbortController();
  // reasoner 思考耗时显著增加，超时时间放大 2 倍
  const timeoutMs = useReasoner ? DS_TIMEOUT * 2 : DS_TIMEOUT;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${DS_BASE.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DS_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`DeepSeek HTTP ${res.status}: ${errText.slice(0, 500)}`);
    }

    if (!stream) {
      const data = await res.json();
      const msg = data.choices?.[0]?.message || {};
      return {
        text: msg.content || '',
        reasoning: msg.reasoning_content || '',
      };
    }

    // 流式解析 SSE：同时读取 content 和 reasoning_content
    let full = '';
    let reasoning = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta || {};
          // 普通正文
          if (delta.content) {
            full += delta.content;
            if (onToken) onToken(delta.content);
          }
          // 推理内容（DeepSeek-R1 独有字段）
          if (delta.reasoning_content) {
            reasoning += delta.reasoning_content;
            if (onReasoning) onReasoning(delta.reasoning_content);
          }
        } catch (e) {
          // 忽略解析错误的 chunk
        }
      }
    }
    return { text: full, reasoning };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  callDeepSeek,
};
