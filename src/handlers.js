// 消息处理：路由触发词与号主命令，跑流式问答并把结果编辑回占位消息。
// 整个处理函数包在 try/catch 里：任何异常都记日志，绝不静默吞掉。

import { parseTrigger, parseOwnerCommand, TRIGGER_WORDS } from "./triggers.js";
import { saveConfigJson } from "./config.js";
import { balanceReport } from "./billing.js";
import {
  canRunOwnerCommand,
  canUsePrivateChat,
  isOwner,
  ownerNote,
  describeRole,
} from "./permissions.js";

const EDIT_INTERVAL_MS = 1500; // 流式刷新占位消息的最短间隔
const TG_MESSAGE_LIMIT = 4000; // Telegram 单条消息上限约 4096，留点余量分片

/**
 * 创建消息处理函数（签名符合 GramJS 的 addEventHandler 回调）。
 * @param {object} deps { client, config, pool, store, logger, startedAt }
 */
export function createHandler(deps) {
  const { client, config, pool, store, logger, startedAt } = deps;

  const blacklist = new Set(config.blacklist || []);
  /** @type {Set<string>} 管理员名单（创建者用命令增删，持久化在 config.json） */
  const adminIds = new Set((config.adminIds || []).map(String));
  /** @type {Map<string, number>} 普通用户上次提问时间（冷却用） */
  const lastAskAt = new Map();

  // 权限判断用的配置视图：管理员名单以运行时 Set 为准（命令增删后立刻生效，不必重启）。
  function permConfig() {
    return { ownerId: config.ownerId, adminIds: [...adminIds], privateChat: config.privateChat };
  }

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

  function persistAdmins() {
    try {
      saveConfigJson({ adminIds: [...adminIds] });
    } catch (err) {
      logger.error(`保存管理员名单失败：${err.message}`);
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

    if (cmd === "账单" || cmd === "用量") {
      const bal = await balanceReport(pool.entries);
      await reply(msg, `今日账单：\n${pool.usageReport()}\n\nAPI 余额：\n${bal}`);
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

    if (cmd === "加管理员") {
      const target = (rest[0] || "").trim();
      if (!target) return reply(msg, "用法：@ai 加管理员 <用户ID>");
      if (isOwner(target, permConfig())) return reply(msg, "创建者本人就是最高权限，不用再加为管理员。");
      if (adminIds.has(target)) return reply(msg, `用户 ${target} 已经是管理员了`);
      adminIds.add(target);
      persistAdmins();
      return reply(msg, `已添加管理员 ${target}`);
    }

    if (cmd === "删管理员") {
      const target = (rest[0] || "").trim();
      if (!target) return reply(msg, "用法：@ai 删管理员 <用户ID>");
      if (!adminIds.has(target)) return reply(msg, `用户 ${target} 不在管理员名单里`);
      adminIds.delete(target);
      persistAdmins();
      return reply(msg, `已删除管理员 ${target}`);
    }

    if (cmd === "管理员列表") {
      if (adminIds.size === 0) {
        return reply(msg, "暂无管理员。用 @ai 加管理员 <用户ID> 添加。");
      }
      const lines = [...adminIds].map((id) => `- ${id}`);
      return reply(msg, `管理员名单（共 ${adminIds.size} 人）：\n${lines.join("\n")}`);
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

    return reply(
      msg,
      "未知命令。可用：状态、账单、拉黑 <ID>、解封 <ID>、加管理员 <ID>、删管理员 <ID>、管理员列表、清空上下文、绑定列表",
    );
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
    // 系统提示 = 基础提示 + 创建者信息（认主）+ 当前发言者身份标注（创建者/管理员才有）。
    const systemParts = [config.systemPrompt];
    const on = ownerNote(config);
    if (on) systemParts.push(on);
    const role = describeRole(senderId, permConfig());
    if (role) systemParts.push(role);
    const messages = [
      { role: "system", content: systemParts.join("\n") },
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

      // 号主命令：必须是创建者本人，且以 “@ai ” 开头。
      if (canRunOwnerCommand(senderId, permConfig())) {
        const body = parseOwnerCommand(text);
        if (body !== null) {
          await handleOwnerCommand(msg, senderId, body);
          return;
        }
      }

      // 私聊门禁：privateChat="admins" 时普通用户的私聊静默不回；群聊不受影响。
      // 私聊的判定：peer 是单个用户（userId）且不带群/频道 ID。
      const isPrivateChat = Boolean(msg.peerId?.userId) && !msg.peerId?.chatId && !msg.peerId?.channelId;
      if (isPrivateChat && !canUsePrivateChat(senderId, permConfig())) {
        logger.info(`私聊门禁拦截：用户 ${senderId} 不在放行名单（privateChat=admins）`);
        return;
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
