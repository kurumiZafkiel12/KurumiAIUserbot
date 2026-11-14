// 消息处理：路由触发词与号主命令，跑流式问答并把结果编辑回占位消息。
// 整个处理函数包在 try/catch 里：任何异常都记日志，绝不静默吞掉。

import { parseTrigger, parseOwnerCommand, TRIGGER_WORDS } from "./triggers.js";
import { saveConfigJson } from "./config.js";

const EDIT_INTERVAL_MS = 1500; // 流式刷新占位消息的最短间隔
const TG_MESSAGE_LIMIT = 4000; // Telegram 单条消息上限约 4096，留点余量分片

/**
 * 创建消息处理函数（签名符合 GramJS 的 addEventHandler 回调）。
 * @param {object} deps { client, config, pool, store, logger, startedAt }
 */
export function createHandler(deps) {
  const { client, config, pool, store, logger, startedAt } = deps;

  const blacklist = new Set(config.blacklist || []);
  /** @type {Map<string, number>} 普通用户上次提问时间（冷却用） */
  const lastAskAt = new Map();

  async function reply(msg, text) {
    await client.sendMessage(msg.peerId, { message: text, replyTo: msg.id });
  }

  function persistBlacklist() {
    try {
      saveConfigJson({ blacklist: [...blacklist] });
    } catch (err) {
      logger.error(`保存黑名单失败：${err.message}`);
    }
  }

  async function handleOwnerCommand(msg, senderId, body) {
    const [cmd, ...rest] = body.split(/\s+/);

    if (cmd === "状态") {
      const upSec = Math.floor((Date.now() - startedAt) / 1000);
      await reply(
        msg,
        `运行状态：正常\n已运行：${Math.floor(upSec / 60)} 分 ${upSec % 60} 秒\n提供方数量：${pool.entries.length}\n名字时钟：${config.nameClock ? "开" : "关"}`,
      );
      return;
    }

    if (cmd === "用量") {
      await reply(msg, `今日用量：\n${pool.usageReport()}`);
      return;
    }

    if (cmd === "拉黑") {
      const target = (rest[0] || "").trim();
      if (!target) return reply(msg, "用法：@ai 拉黑 <用户ID>");
      blacklist.add(target);
      persistBlacklist();
      return reply(msg, `已拉黑用户 ${target}`);
    }

    if (cmd === "解封") {
      const target = (rest[0] || "").trim();
      if (!target) return reply(msg, "用法：@ai 解封 <用户ID>");
      blacklist.delete(target);
      persistBlacklist();
      return reply(msg, `已解封用户 ${target}`);
    }

    if (cmd === "清空上下文") {
      const n = store.clearAll();
      return reply(msg, `已清空全部对话上下文（${n} 组）`);
    }

    if (cmd === "绑定列表") {
      const lines = TRIGGER_WORDS.map((w) => {
        const bound = config.triggerMap[w];
        if (bound) return `${w} → ${bound}`;
        return w === "@ai" ? `${w} → default（默认）` : `${w} → （未绑定）`;
      });
      return reply(msg, `触发词绑定：\n${lines.join("\n")}`);
    }

    return reply(msg, "未知命令。可用：状态、用量、拉黑 <ID>、解封 <ID>、清空上下文、绑定列表");
  }

  async function handleChat(msg, chatId, senderId, parsed) {
    if (!parsed.question) {
      await reply(msg, "在触发词后面写上你的问题，例如：@ai 今天天气怎么样");
      return;
    }
    if (parsed.providerName === null) {
      await reply(msg, `触发词 ${parsed.trigger} 还没有绑定模型，请联系号主在 config.json 里绑定。`);
      return;
    }

    // 普通用户冷却：间隔太短的提问直接忽略，防止刷屏烧额度。
    const now = Date.now();
    const last = lastAskAt.get(senderId) || 0;
    if (config.cooldownSeconds > 0 && now - last < config.cooldownSeconds * 1000) return;
    lastAskAt.set(senderId, now);

    // 先发占位消息；发不出去（如被群禁言 USER_BANNED_IN_CHANNEL）就记日志返回，不要硬撑。
    let placeholder;
    try {
      placeholder = await client.sendMessage(msg.peerId, {
        message: "🤓 正在思考中...",
        replyTo: msg.id,
      });
    } catch (err) {
      logger.error(`发送占位消息失败（chat=${chatId}）：${err.message}`);
      return;
    }

    const history = store.get(chatId, senderId);
    const messages = [
      { role: "system", content: config.systemPrompt },
      ...history,
      { role: "user", content: parsed.question },
    ];

    const tried = new Set();
    let preferred = parsed.providerName;
    let answer = null;
    let usedEntry = null;
    let lastEditAt = 0;

    while (!answer) {
      const entry = pool.pick(tried, preferred);
      preferred = null; // 优先项只用一次，之后按权重挑
      if (!entry) break;
      tried.add(entry.name);
      try {
        const text = await pool.chat(entry, messages, (partial) => {
          const t = Date.now();
          if (t - lastEditAt >= EDIT_INTERVAL_MS && partial.trim()) {
            lastEditAt = t;
            client
              .editMessage(msg.peerId, { message: placeholder.id, text: partial.slice(0, TG_MESSAGE_LIMIT) })
              .catch(() => {});
          }
        });
        answer = text;
        usedEntry = entry;
        pool.markSuccess(entry);
      } catch (err) {
        logger.error(`提供方 ${entry.name} 回答失败：${err.message}`);
        pool.markFailure(entry, err);
      }
    }

    if (!answer) {
      try {
        await client.editMessage(msg.peerId, {
          message: placeholder.id,
          text: "抱歉，所有模型都暂时不可用，请稍后再试。",
        });
      } catch (err) {
        logger.error(`发送失败提示出错：${err.message}`);
      }
      return;
    }

    // 保存上下文（问题 + 回答），下次提问能接上话。
    store.push(chatId, senderId, "user", parsed.question);
    store.push(chatId, senderId, "assistant", answer);

    // 最终答案：先编辑占位消息；超长时剩余部分分片续发。
    try {
      await client.editMessage(msg.peerId, {
        message: placeholder.id,
        text: answer.slice(0, TG_MESSAGE_LIMIT),
      });
      let rest = answer.slice(TG_MESSAGE_LIMIT);
      while (rest.length > 0) {
        const chunk = rest.slice(0, TG_MESSAGE_LIMIT);
        rest = rest.slice(TG_MESSAGE_LIMIT);
        await client.sendMessage(msg.peerId, { message: chunk, replyTo: msg.id });
      }
    } catch (err) {
      logger.error(`发送最终答案失败（chat=${chatId}，模型=${usedEntry.name}）：${err.message}`);
    }
  }

  return async function handler(event) {
    try {
      const msg = event && event.message;
      if (!msg) return;
      if (msg.out) return; // 忽略自己发出的消息

      const text = msg.message || "";
      if (!text) return; // v1 只处理文本消息

      const senderId = msg.senderId ? msg.senderId.toString() : "";
      const chatId = (
        msg.chatId ||
        msg.peerId?.channelId ||
        msg.peerId?.chatId ||
        msg.peerId?.userId ||
        ""
      ).toString();
      if (!senderId) return;

      if (blacklist.has(senderId)) return;

      // 号主命令：必须是号主本人，且以 “@ai ” 开头。
      if (config.ownerId && senderId === config.ownerId) {
        const body = parseOwnerCommand(text);
        if (body !== null) {
          await handleOwnerCommand(msg, senderId, body);
          return;
        }
      }

      const parsed = parseTrigger(text, {
        username: config.myUsername,
        triggerMap: config.triggerMap,
      });
      if (!parsed) return;

      await handleChat(msg, chatId, senderId, parsed);
    } catch (err) {
      // 兜底：处理消息时的任何异常都进日志，不能让它无声消失。
      logger.error(`处理消息时出错：${err.stack || err.message || err}`);
    }
  };
}
