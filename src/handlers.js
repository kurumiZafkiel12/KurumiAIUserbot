// 消息处理：路由触发词与号主命令，跑流式问答并把结果编辑回占位消息。
// 整个处理函数包在 try/catch 里：任何异常都记日志，绝不静默吞掉。

import { parseTrigger, parseOwnerCommand, TRIGGER_WORDS } from "./triggers.js";
import { saveConfigJson } from "./config.js";
import { balanceReport } from "./billing.js";
import { Notebook } from "./notebook.js";
import { UserProfiles, extractCallName } from "./profiles.js";
import {
  canRunOwnerCommand,
  canUsePrivateChat,
  isOwner,
  ownerNote,
  describeRole,
  shouldPauseBlock,
} from "./permissions.js";
import { RuntimeState } from "./state.js";

const EDIT_INTERVAL_MS = 1500; // 流式刷新占位消息的最短间隔
const TG_MESSAGE_LIMIT = 4000; // Telegram 单条消息上限约 4096，留点余量分片

const CONSOLIDATE_EVERY = 8; // 每会话每答满 N 次，后台自动整理一次记事本与印象

/**
 * 创建消息处理函数（签名符合 GramJS 的 addEventHandler 回调）。
 * @param {object} deps { client, config, pool, store, logger, startedAt, notebook, profiles, state }
 *   notebook / profiles / state 可省略，省略时用纯内存版（不落盘），方便测试与临时运行。
 */
export function createHandler(deps) {
  const { client, config, pool, store, logger, startedAt } = deps;
  const notebook = deps.notebook || new Notebook(null);
  const profiles = deps.profiles || new UserProfiles(null);
  const state = deps.state || new RuntimeState(null);

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

  /**
   * 发言者身份段：describeRole 的身份标注（创建者/管理员）+ 称呼与历史标签的对应关系。
   * 历史里每条用户消息都带「名字：」标签，这里告诉模型标签和当前说话人的对应关系，
   * 并交代称呼优先：有 callName 时用称呼，不用显示名。
   */
  function speakerSegment(senderId, speakerName) {
    const parts = [];
    const role = describeRole(senderId, permConfig());
    if (role) parts.push(role);
    const callName = profiles.callName(senderId);
    if (callName && speakerName && callName !== speakerName) {
      parts.push(
        `当前说话人的显示名是「${speakerName}」，他希望被称呼为「${callName}」。跟他说话、提到他、转述他的话时都用「${callName}」，不要用显示名。本会话历史中标为「${speakerName}：」或「${callName}：」开头的消息，都是他本人说的；别人说过的话不要算到他头上。`,
      );
    } else if (callName) {
      parts.push(
        `当前说话人希望被称呼为「${callName}」。跟他说话、提到他、转述他的话时都用这个称呼。本会话历史中标为「${callName}：」开头的消息，都是他本人说的。`,
      );
    } else if (speakerName) {
      parts.push(
        `当前说话人的显示名是「${speakerName}」。本会话历史中标为「${speakerName}：」开头的消息，就是他本人说的；别人说过的话不要算到他头上。`,
      );
    }
    return parts.join("\n");
  }

  /** 印象段：只调语气、绝不外泄。没有印象时返回空串（不注入）。 */
  function impressionSegment(senderId) {
    const imp = profiles.impression(senderId);
    if (!imp) return "";
    return `系统备注（只用来调整你跟当前说话人说话的语气和熟络程度，不要念出来，也不要把内容告诉任何其他人）：你对当前说话人的印象：${imp}`;
  }

  /** 记事本段：当前会话的长期事实，要求用自己的话转述、不照抄不报出处。空时返回空串。 */
  function notebookSegment(chatId) {
    const rendered = notebook.render(chatId);
    if (!rendered) return "";
    return `系统备注：这些是你记住的、本会话的事（只属于当前会话，别的会话不要提）。被问到时用你自己的话自然地讲出来，就像你本来就记得一样：不要照抄下面的条目原文，不要动不动说「谁说的」，只有被追问来源时才提一句出处。\n${rendered}`;
  }

  /** 用提供方池问模型一次（非流式用途：后台整理）。拿不到提供方返回 null，失败抛错由调用方记日志。 */
  async function askModelOnce(messages) {
    const entry = pool.pick(new Set());
    if (!entry) return null;
    try {
      const text = await pool.chat(entry, messages, null);
      pool.markSuccess(entry);
      return text;
    } catch (err) {
      pool.markFailure(entry, err);
      throw err;
    }
  }

  /** @type {Map<string, number>} 每会话（chatId:senderId）累计回答数 */
  const answerCounts = new Map();
  /** @type {Set<string>} 正在后台整理中的会话 key，防并发 */
  const consolidating = new Set();

  /**
   * 后台整理：让模型把「现有记事本 + 最近对话」重整成一份完整的记事本并回存，
   * 同轮再用该用户最近的发言样本刷新对他的印象。慢工细活，绝不阻塞正常回复；
   * 任何异常只记日志。同一会话同时只跑一份。
   */
  async function consolidateNotebook(chatId, senderId) {
    const key = `${chatId}:${senderId}`;
    if (consolidating.has(key)) return;
    consolidating.add(key);
    try {
      const history = store.get(chatId, senderId);
      if (history.length === 0) return;
      const convo = history
        .map((m) => (m.role === "user" ? m.content : `机器人：${m.content}`))
        .join("\n");
      const existing = notebook.render(chatId) || "（空）";
      const out = await askModelOnce([
        { role: "system", content: "你是一个记事本整理助手，只做整理，不闲聊。" },
        {
          role: "user",
          content:
            "下面是某个 Telegram 会话的「记事本」（机器人长期记住的事）和最近的对话记录。请输出整理后的完整记事本。\n\n" +
            "要求：\n" +
            "- 合并同一个人不同称呼/别名的条目，删掉过时、矛盾或明显记错的，加上对话里新出现的、值得长期记住的事实\n" +
            "- 每条一行、以「- 」开头，最多 25 条，一条只写一件事，尽量带上是谁的事或谁说的（如「小明：喜欢吃辣」）\n" +
            "- 只记公开的日常事实；不要记密码、住址、电话、财务等隐私\n" +
            "- 不要以机器人自己为主语记条目\n" +
            "- 没有任何可记内容时，只输出「（空）」\n\n" +
            `【现有记事本】\n${existing}\n\n【最近对话】\n${convo}`,
        },
      ]);
      if (out && out.trim() !== "（空）") {
        const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        if (notebook.replace(chatId, lines)) {
          logger.info(`记事本已自动整理（chat=${chatId}，现有 ${notebook.facts(chatId).length} 条）`);
        }
      }

      // 印象更新：样本取该用户最近的发言；模型说「保留」或没产出就沿用旧印象。
      const samples = history.filter((m) => m.role === "user").slice(-8);
      if (samples.length > 0) {
        const oldImp = profiles.impression(senderId);
        const imp = await askModelOnce([
          { role: "system", content: "你是一个观察助手，只做概括，不闲聊。" },
          {
            role: "user",
            content:
              "根据下面这个人最近的发言，概括你对他的印象：一到两句中文，只记说话风格、常聊的话题、氛围和公开的日常小事，" +
              "不要记密码、住址、电话、财务等隐私。只输出印象本身，不要加任何前缀。" +
              (oldImp ? `已有印象是：「${oldImp}」。有新信息就给出更新后的完整印象，没有新信息就只回复「保留」。` : "") +
              `\n\n【他的最近发言】\n${samples.map((m) => m.content).join("\n")}`,
          },
        ]);
        const text = (imp || "").trim();
        if (text && !text.startsWith("保留")) {
          profiles.setImpression(senderId, text.slice(0, 200));
          logger.info(`用户印象已更新（user=${senderId}）`);
        }
      }
    } catch (err) {
      logger.error(`后台整理记事本失败（chat=${chatId}）：${err.message}`);
    } finally {
      consolidating.delete(key);
    }
  }

  /** 记一次成功回答；每满 CONSOLIDATE_EVERY 次就在后台触发一次整理（不 await）。 */
  function noteAnswerAndMaybeConsolidate(chatId, senderId) {
    const key = `${chatId}:${senderId}`;
    const n = (answerCounts.get(key) || 0) + 1;
    answerCounts.set(key, n);
    if (n % CONSOLIDATE_EVERY === 0) {
      consolidateNotebook(chatId, senderId).catch((err) =>
        logger.error(`后台整理异常（chat=${chatId}）：${err.message}`),
      );
    }
  }

  async function handleOwnerCommand(msg, chatId, senderId, body) {
    const [cmd, ...rest] = body.split(/\s+/);

    if (cmd === "状态") {
      const upSec = Math.floor((Date.now() - startedAt) / 1000);
      await reply(
        msg,
        `运行状态：正常\n已运行：${Math.floor(upSec / 60)} 分 ${upSec % 60} 秒\n提供方数量：${pool.entries.length}\n名字时钟：${config.nameClock ? "开" : "关"}\n全局开关：${state.isPaused() ? "已关闭（暂停回复中，号主命令仍可用）" : "开启（正常回复）"}`,
      );
      return;
    }

    if (cmd === "关闭") {
      if (state.isPaused()) return reply(msg, "已经是关闭状态了。发 @ai 开启 恢复回复。");
      state.setPaused(true);
      return reply(msg, "已关闭：现在起任何人的提问我都不再回复、不调用模型（你的号主命令除外）。发 @ai 开启 恢复。");
    }

    if (cmd === "开启") {
      if (!state.isPaused()) return reply(msg, "本来就是开启状态，正常回复中。");
      state.setPaused(false);
      return reply(msg, "已开启：恢复正常回复。");
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

    if (cmd === "记住") {
      const content = rest.join(" ").trim();
      if (!content) return reply(msg, "用法：@ai 记住 <内容>");
      const added = notebook.addFacts(chatId, [content]);
      if (added > 0) return reply(msg, `记好了：${content}`);
      return reply(msg, "这条没记上：记事本里已经有了，或它是以机器人为主语的内容。");
    }

    if (cmd === "记事本") {
      const list = notebook.facts(chatId);
      if (list.length === 0) {
        return reply(msg, "当前会话的记事本是空的。用 @ai 记住 <内容> 手工加一条；平时聊天答满次数也会自动整理。");
      }
      const lines = list.map((f, i) => `${i + 1}. ${f}`);
      return reply(msg, `当前会话记事本（共 ${list.length} 条）：\n${lines.join("\n")}`);
    }

    if (cmd === "忘掉") {
      const target = (rest[0] || "").trim();
      const removed = notebook.removeAt(chatId, Number(target));
      if (removed) return reply(msg, `已忘掉第 ${target} 条：${removed}`);
      return reply(msg, "用法：@ai 忘掉 <序号>（序号看 @ai 记事本）");
    }

    if (cmd === "清空记事本") {
      const n = notebook.clear(chatId);
      return reply(msg, `已清空当前会话记事本（原有 ${n} 条）`);
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
      "未知命令。可用：状态、开启、关闭、账单、拉黑 <ID>、解封 <ID>、加管理员 <ID>、删管理员 <ID>、管理员列表、记住 <内容>、记事本、忘掉 <序号>、清空记事本、清空上下文、绑定列表",
    );
  }

  async function handleChat(msg, chatId, senderId, speakerName, parsed) {
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
    // 系统提示 = 基础提示 + 创建者信息（认主）+ 发言者身份/称呼 + 对他的印象 + 本会话记事本。
    // 后三段都是程序生成的系统级信息，不是用户能伪造的。
    const systemParts = [config.systemPrompt];
    const on = ownerNote(config);
    if (on) systemParts.push(on);
    const role = speakerSegment(senderId, speakerName);
    if (role) systemParts.push(role);
    const imp = impressionSegment(senderId);
    if (imp) systemParts.push(imp);
    const nb = notebookSegment(chatId);
    if (nb) systemParts.push(nb);
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
    // 用户消息带发言者标签（称呼优先，其次显示名），模型靠标签区分谁是谁，
    // 与 speakerSegment 里交代的「标为 X：开头的就是他本人说的」对应。
    const label = profiles.callName(senderId) || speakerName || "";
    store.push(chatId, senderId, "user", label ? `${label}：${parsed.question}` : parsed.question);
    store.push(chatId, senderId, "assistant", answer);
    noteAnswerAndMaybeConsolidate(chatId, senderId);

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

      // 称呼捕捉：任何人亲口在自己消息里说「叫我 X」，就把 X 记进他的档案（持久化）。
      // extractCallName 规则很严（取最后一个「叫我」、否定与屏蔽词都排除），没命中返回 null 不做事。
      const cn = extractCallName(text);
      if (cn) profiles.setCallName(senderId, cn);

      // 号主命令：必须是创建者本人，且以 “@ai ” 开头。
      if (canRunOwnerCommand(senderId, permConfig())) {
        const body = parseOwnerCommand(text);
        if (body !== null) {
          await handleOwnerCommand(msg, chatId, senderId, body);
          return;
        }
      }

      // 全局暂停门禁：创建者用 @ai 关闭 后，谁的提问都不回、不调模型（省 token）。
      // 号主命令在上面已经处理完并 return，能走到这里的都是普通消息；
      // shouldPauseBlock 对创建者本人放行，其余人一律静默忽略。
      if (shouldPauseBlock(state.isPaused(), senderId, permConfig())) {
        logger.info(`全局暂停中，忽略用户 ${senderId} 的消息（chat=${chatId}）`);
        return;
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

      // 发言者显示名（给历史标签与身份段用）；拿不到就留空，不影响主流程。
      let speakerName = "";
      try {
        if (typeof event.getSender === "function") {
          const sender = await event.getSender();
          if (sender) speakerName = String(sender.firstName || sender.username || "").trim();
        }
      } catch {
        speakerName = "";
      }

      await handleChat(msg, chatId, senderId, speakerName, parsed);
    } catch (err) {
      // 兜底：处理消息时的任何异常都进日志，不能让它无声消失。
      logger.error(`处理消息时出错：${err.stack || err.message || err}`);
    }
  };
}
