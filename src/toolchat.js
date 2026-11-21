// 工具调用对话：把工具表交给模型（OpenAI function calling），模型要调工具就执行、回喂结果，
// 直到模型给出最终文本。非流式；提供方不支持 tools 时返回 null，调用方回退到原流式聊天。
// 轮数上限防死循环；最后一轮不再给工具，逼模型收尾。

import { TOOL_SCHEMAS, executeTool } from "./tools.js";

const MAX_TOOL_ROUNDS = 4;

/**
 * @param {object} entry 提供方条目（用它的 client 与 model）
 * @param {Array<object>} messages 原始对话消息
 * @param {object} ctx 工具执行上下文 { chatId, senderId, timezone, logger, outbox, store }
 * @param {Function} [onUsage] usage 回调（累计后回调一次）
 * @returns {Promise<string|null>} 最终回复文本；提供方不支持工具时返回 null
 */
export async function chatWithTools(entry, messages, ctx, onUsage) {
  const convo = [...messages];
  let totalUsage = null;
  const addUsage = (u) => {
    if (!u) return;
    if (!totalUsage) {
      totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    }
    totalUsage.prompt_tokens += u.prompt_tokens || 0;
    totalUsage.completion_tokens += u.completion_tokens || 0;
    totalUsage.total_tokens += u.total_tokens || 0;
  };

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const lastRound = round === MAX_TOOL_ROUNDS;
    let res;
    try {
      res = await entry.client.chat.completions.create({
        model: entry.model,
        messages: convo,
        ...(lastRound ? {} : { tools: TOOL_SCHEMAS, tool_choice: "auto" }),
      });
    } catch (err) {
      // 第一轮就因 tools 参数报错：多半是这家接口不支持工具调用，回退普通聊天。
      if (round === 0 && /tool/i.test((err && err.message) || "")) return null;
      throw err;
    }
    addUsage(res && res.usage);
    const message = res && res.choices && res.choices[0] && res.choices[0].message;
    if (!message) throw new Error("模型返回了空内容");
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (!calls.length) {
      const text = String(message.content || "").trim();
      if (!text) throw new Error("模型返回了空内容");
      if (totalUsage && onUsage) {
        try {
          onUsage(totalUsage);
        } catch {
          // 统计回调出错不影响回答本身。
        }
      }
      return text;
    }
    convo.push({ role: "assistant", content: message.content || "", tool_calls: calls });
    for (const call of calls) {
      let args = {};
      try {
        args = JSON.parse((call.function && call.function.arguments) || "{}");
      } catch {
        args = {};
      }
      const result = await executeTool(call.function && call.function.name, args, ctx);
      convo.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }
  throw new Error("工具调用轮数过多，已中止");
}
