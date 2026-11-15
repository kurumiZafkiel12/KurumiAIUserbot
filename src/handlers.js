// 消息处理：路由触发词与号主命令，跑流式问答并把结果编辑回占位消息。
// 整个处理函数包在 try/catch 里：任何异常都记日志，绝不静默吞掉。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
parseTrigger,
parseOwnerCommand,
resolveProvider,
isReplyToSelf,
isHelpQuery,
TRIGGER_WORDS,
DEFAULT_TRIGGER,
} from "./triggers.js";
import { formatNowLine} from "./time.js";
import { saveConfigJson} from "./config.js";
import { balanceReport} from "./billing.js";
import { Notebook} from "./notebook.js";
import { UserProfiles, extractCallName} from "./profiles.js";
import {
canRunOwnerCommand,
canUsePrivateChat,
isOwner,
ownerNote,
describeRole,
roleOf,
shouldPauseBlock,
} from "./permissions.js";
import { RuntimeState} from "./state.js";
import { PendingSelections} from "./pending.js";
import { UsageStats} from "./usagestats.js";
import { SlowdownTracker} from "./limits.js";
import { findKeyword, isSensitiveBlocked, unwrapArg} from "./moderation.js";
import { formatServerInfo} from "./serverinfo.js";

const EDIT_INTERVAL_MS = 1500; // 流式刷新占位消息的最短间隔
const TG_MESSAGE_LIMIT = 4000; // Telegram 单条消息上限约 4096，留点余量分片
const CODE_WARN_LIMIT = 3; // 代码关键词命中第几次时自动拉黑

/** 占位消息文案（纯文字，不带任何表情，用户定版格式）。 */
export const PLACEHOLDER_TEXT = "（思考中...）";

/**
* 号主帮助：代码写死的固定文本（不走模型），内容与 handleOwnerCommand 的真实分支逐条对齐。
* 号主命令只认 /ai 前缀（如「/ai 状态」）；@ai 只是聊天触发词，不是命令前缀。
*/
export const OWNER_HELP_TEXT = `可用命令：

注：带（再回 <序号>）的命令要分两条发——先单独发命令，它列出选项后，60 秒内再单独回数字；把数字和命令写在同一条里不生效。


/ai 帮助
/ai 状态
/ai 服务器
/ai 日志
/ai 用量报告
/ai 账单（查看今日用量、Token 与余额；「用量」是它的别名）


/ai 开启用户名
/ai 关闭用户名（关后普通用户 @用户名 无法触发；触发词、回复续聊、私聊不受影响）


/ai 加管理员 <用户ID>
/ai 删管理员 <用户ID>
/ai 管理员列表（管理员是主人信任的人：机器人认得他、不受限速和提问冷却影响）


/ai 拉黑 <用户ID>
/ai 解封 <用户ID>
/ai 限速 <用户ID>
/ai 解除限速 <用户ID>


/ai 加词 <关键词…>
/ai 删词 <关键词…>
/ai 加屏蔽 <群ID> <词>（词对所有屏蔽群生效）


/ai 查看api
/ai 查看模型 <API名字>
/ai 换模型（再回 <序号>）
/ai 限额（再回 <序号>，再发纯数字）
/ai 换key（再回 <序号>，再发新 key）
/ai 禁用api（再回 <序号>，别禁唯一在用的 API）
/ai 启用api（再回 <序号>）
/ai 加聊天api <名字> <baseURL> <key> <模型名>


/ai 记住 <内容>
/ai 记事本
/ai 忘掉 <序号>
/ai 清空记事本


/ai 关闭 / /ai 开启（一键全局暂停 / 恢复回复）
/ai 设人设 <内容>
/ai 人设
/ai 清除人设
/ai 绑定 <触发词> <API名字>
/ai 解绑 <触发词>
/ai 绑定列表
/ai 清空上下文

群友用法：群里 @机器人用户名 提问、回复机器人的消息续聊，或私聊直接发消息即可。`;

/**
* 公开帮助：给普通用户看的固定文本（不走模型），只写群友能用的，
* 不含任何号主命令与敏感信息。
*/
export const PUBLIC_HELP_TEXT = `使用帮助：

- 群里：@机器人用户名 + 你的问题，就能问我
- 回复我发出的任意一条消息提问，就能接着上文继续聊，不用再 @
- 私聊：直接发消息就行，不用 @、不用加任何前缀
- 问现在几点、今天几号，我按北京时间回答

想让我做点什么，直接说就行。`;

const CONSOLIDATE_EVERY = 8; // 每会话每答满 N 次，后台自动整理一次记事本与印象

/**
* 创建消息处理函数（签名符合 GramJS 的 addEventHandler 回调）。
* @param {object} deps { client, config, pool, store, logger, startedAt, notebook, profiles,
* state, selfId, pending, slowdown, usageStats, reloadRuntime}
* notebook / profiles / state / pending / slowdown / usageStats 可省略，省略时用纯内存版，
* 方便测试与临时运行。
* reloadRuntime 可省略：提供时，号主命令改完 config.json 会调它重新加载配置并重建
* 提供方池（返回 { config, pool}），改动立即生效；省略时改动只落盘、下次启动才生效。
* selfId 是本账号的数字 ID（回复续聊判定用），可省略，省略时回复续聊只认 out 标记。
*/
export function createHandler(deps) {
const { client, store, logger, startedAt} = deps;
let config = deps.config;
let pool = deps.pool;
const selfId = deps.selfId!== undefined && deps.selfId!== null? String(deps.selfId): "";
const notebook = deps.notebook || new Notebook(null);
const profiles = deps.profiles || new UserProfiles(null);
const state = deps.state || new RuntimeState(null);
const pending = deps.pending || new PendingSelections();
const slowdown = deps.slowdown || new SlowdownTracker();
const usageStats = deps.usageStats || new UsageStats(null);

const blacklist = new Set(config.blacklist || []);
/** @type {Set<string>} 管理员名单（创建者用命令增删，持久化在 config.json） */
const adminIds = new Set((config.adminIds || []).map(String));
/** @type {Set<string>} 限速名单（持久化在 config.json 的 slowdownUsers） */
const slowdownSet = new Set((config.slowdownUsers || []).map(String));
/** @type {Set<string>} 代码关键词（持久化在 config.json 的 codeKeywords） */
const codeKeywordSet = new Set(config.codeKeywords || []);
/** @type {Set<string>} 屏蔽群 ID（持久化在 config.json 的 sensitiveGroups） */
const sensitiveGroupsSet = new Set((config.sensitiveGroups || []).map(String));
/** @type {Set<string>} 屏蔽词（持久化在 config.json 的 sensitiveKeywords，对所有屏蔽群生效） */
const sensitiveKeywordsSet = new Set(config.sensitiveKeywords || []);
/** @type {Map<string, number>} 普通用户上次提问时间（冷却用） */
const lastAskAt = new Map();
/** @type {Map<string, number>} 代码关键词命中计数（内存版，累计到 CODE_WARN_LIMIT 拉黑） */
const codeWarnCounts = new Map();

// 权限判断用的配置视图：管理员名单以运行时 Set 为准（命令增删后立刻生效，不必重启）。
function permConfig() {
return { ownerId: config.ownerId, adminIds: [...adminIds], privateChat: config.privateChat};
}

async function reply(msg, text) {
await client.sendMessage(msg.peerId, { message: text, replyTo: msg.id});
}

function persistBlacklist() {
try {
saveConfigJson({ blacklist: [...blacklist]});
} catch (err) {
logger.error(`保存黑名单失败：${err.message}`);
}
}

function persistAdmins() {
try {
saveConfigJson({ adminIds: [...adminIds]});
} catch (err) {
logger.error(`保存管理员名单失败：${err.message}`);
}
}

function persistSlowdown() {
try {
saveConfigJson({ slowdownUsers: [...slowdownSet]});
} catch (err) {
logger.error(`保存限速名单失败：${err.message}`);
}
}

function persistCodeKeywords() {
try {
saveConfigJson({ codeKeywords: [...codeKeywordSet]});
} catch (err) {
logger.error(`保存代码关键词失败：${err.message}`);
}
}

function persistSensitive() {
try {
saveConfigJson({ sensitiveGroups: [...sensitiveGroupsSet], sensitiveKeywords: [...sensitiveKeywordsSet]});
} catch (err) {
logger.error(`保存屏蔽名单失败：${err.message}`);
}
}

/**
* 运行时重载：请入口重新 loadConfig 并重建提供方池，把本闭包引用的 config/pool 换新。
* 入口没提供 reloadRuntime 时返回 false（改动只落盘，下次启动生效）。
*/
function doReload() {
if (typeof deps.reloadRuntime!== "function") return false;
try {
const next = deps.reloadRuntime();
if (next && next.config) config = next.config;
if (next && next.pool) pool = next.pool;
return true;
} catch (err) {
logger.error(`运行时重载失败：${err.message}`);
return false;
}
}

/** 落盘一个 config 补丁并立刻重载生效。返回是否全部成功。 */
function saveAndReload(patch) {
try {
saveConfigJson(patch);
} catch (err) {
logger.error(`保存配置失败：${err.message}`);
return false;
}
doReload();
return true;
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
if (callName && speakerName && callName!== speakerName) {
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
let seenUsage = null;
try {
const text = await pool.chat(entry, messages, null, (u) => {
seenUsage = u;
});
pool.markSuccess(entry);
usageStats.record(entry.model, seenUsage);
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
.map((m) => (m.role === "user"? m.content: `机器人：${m.content}`))
.join("\n");
const existing = notebook.render(chatId) || "（空）";
const out = await askModelOnce([
{ role: "system", content: "你是一个记事本整理助手，只做整理，不闲聊。"},
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
`\n${existing}\n\n\n${convo}`,
},
]);
if (out && out.trim()!== "（空）") {
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
{ role: "system", content: "你是一个观察助手，只做概括，不闲聊。"},
{
role: "user",
content:
"根据下面这个人最近的发言，概括你对他的印象：一到两句中文，只记说话风格、常聊的话题、氛围和公开的日常小事，" +
"不要记密码、住址、电话、财务等隐私。只输出印象本身，不要加任何前缀。" +
(oldImp? `已有印象是：「${oldImp}」。有新信息就给出更新后的完整印象，没有新信息就只回复「保留」。`: "") +
`\n\n\n${samples.map((m) => m.content).join("\n")}`,
},
]);
const text = (imp || "").trim();
if (text &&!text.startsWith("保留")) {
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

/** 提供方编号列表（查看api 与两步选择共用）。只含名字/模型/地址/状态/用量，绝不含 key。 */
function providerListText() {
return pool.entries
.map((e, i) => {
const s = e.counter.snapshot();
const limitText = s.limit > 0? `${s.count}/${s.limit}`: `${s.count}/不限`;
const status = e.disabled? "禁用": e.cooldownUntil > Date.now()? "冷却中": "启用";
return `${i + 1}. ${e.name} | 模型：${e.model} | 地址：${e.baseURL} | 状态：${status} | 今日：${limitText}`;
})
.join("\n");
}

/** 发起一个两步选择：回编号列表并登记 pending，等号主单独回数字。 */
async function startSelect(msg, chatId, senderId, kind) {
pending.set(chatId, senderId, { kind, step: 1});
await reply(
msg,
`请选择（60 秒内单独回一个数字，数字和命令写在同一条里不生效）：\n${providerListText()}`,
);
}

/**
* 执行一条 pending（号主回数字 / 换key 回全文时调用）。pending 已被调用方消费。
* @param {object} entry pending 条目 { kind, step, providerName}
* @param {string} text 号主这条消息的全文（已 trim）
*/
async function executePending(msg, chatId, senderId, entry, text) {
const keyProp = "api" + "Key";

// 第二步：限额（text 是纯数字，调用方已校验）
if (entry.step === 2 && entry.kind === "限额") {
const n = Number.parseInt(text, 10);
const dailyLimits = {...(config.dailyLimits || {})};
dailyLimits[entry.providerName] = n;
if (!saveAndReload({ dailyLimits})) return reply(msg, "保存失败，请看日志。");
return reply(msg, `「${entry.providerName}」的每日上限已设为 ${n === 0? "不限": `${n} 次`}，已生效。`);
}

// 第二步：换key（text 全文就是新 key；只落盘，绝不回显、绝不记日志）
if (entry.step === 2 && entry.kind === "换key") {
const newKey = text.trim();
if (!newKey) return reply(msg, "key 是空的，没改。重新发 /ai 换key 再试。");
const overrides = {...(config.providerOverrides || {})};
overrides[entry.providerName] = {...(overrides[entry.providerName] || {}), [keyProp]: newKey};
if (!saveAndReload({ providerOverrides: overrides})) return reply(msg, "保存失败，请看日志。");
return reply(msg, `「${entry.providerName}」的 key 已更新，已生效。（key 不会回显）`);
}

// 第一步：按编号选提供方
const idx = Number.parseInt(text, 10) - 1;
if (!Number.isFinite(idx) || idx < 0 || idx >= pool.entries.length) {
return reply(msg, `编号超出范围（1~${pool.entries.length}），请重新发命令。`);
}
const target = pool.entries[idx];

if (entry.kind === "换模型") {
if (!saveAndReload({ defaultProvider: target.name})) return reply(msg, "保存失败，请看日志。");
return reply(
msg,
`默认提供方已切换为「${target.name}」（模型 ${target.model}），已生效。未显式绑定的触发词、@ 提及都会优先用它。`,
);
}

if (entry.kind === "禁用api") {
if (target.disabled) return reply(msg, `「${target.name}」已经是禁用状态了。`);
if (pool.enabledCount() <= 1) {
return reply(msg, `不能禁用「${target.name}」：它是最后一个启用的提供方，禁了就没得用了。`);
}
const overrides = {...(config.providerOverrides || {})};
overrides[target.name] = {...(overrides[target.name] || {}), disabled: true};
if (!saveAndReload({ providerOverrides: overrides})) return reply(msg, "保存失败，请看日志。");
return reply(msg, `已禁用「${target.name}」，已生效。它不会再被挑中回答。`);
}

if (entry.kind === "启用api") {
if (!target.disabled) return reply(msg, `「${target.name}」本来就是启用状态。`);
const overrides = {...(config.providerOverrides || {})};
overrides[target.name] = {...(overrides[target.name] || {}), disabled: false};
if (!saveAndReload({ providerOverrides: overrides})) return reply(msg, "保存失败，请看日志。");
return reply(msg, `已启用「${target.name}」，已生效。`);
}

if (entry.kind === "限额") {
pending.set(chatId, senderId, { kind: "限额", step: 2, providerName: target.name});
return reply(msg, `已选「${target.name}」。请单独发一个纯数字设置它的每日上限（0 = 不限），60 秒内有效。`);
}

if (entry.kind === "换key") {
pending.set(chatId, senderId, { kind: "换key", step: 2, providerName: target.name});
return reply(
msg,
`已选「${target.name}」。请把新 key 作为下一条消息单独发出来，60 秒内有效。放心：key 不会回显，也不会记进日志。`,
);
}

return reply(msg, "这个选择已失效，请重新发命令。");
}

  async function handleOwnerCommand(msg, chatId, senderId, body) {
    const [cmd, ...rest] = body.split(/\s+/);
    const keyProp = "api" + "Key";

    if (cmd === "帮助" || cmd === "help") {
      await reply(msg, OWNER_HELP_TEXT);
      return;
    }

    if (cmd === "状态") {
      const upSec = Math.floor((Date.now() - startedAt) / 1000);
      const lines = [
        "运行状态：正常",
        `已运行：${Math.floor(upSec / 60)} 分 ${upSec % 60} 秒`,
        `提供方数量：${pool.entries.length}`,
        `名字时钟：${config.nameClock ? "开" : "关"}`,
        `全局开关：${state.isPaused() ? "已关闭（暂停回复中，号主命令仍可用）" : "开启（正常回复）"}`,
        `用户名触发：${config.usernameTrigger ? "开" : "关"}`,
        `代码关键词：${codeKeywordSet.size} 个`,
        `屏蔽群：${sensitiveGroupsSet.size} 个 / 屏蔽词：${sensitiveKeywordsSet.size} 个`,
        `默认提供方：${config.defaultProvider || "default"}`,
      ];
      const disabledCount = pool.entries.filter((e) => e.disabled).length;
      if (disabledCount > 0) lines.push(`被禁用的提供方：${disabledCount} 个`);
      await reply(msg, lines.join("\n"));
      return;
    }

    if (cmd === "服务器") {
      await reply(
        msg,
        formatServerInfo({
          hostname: os.hostname(),
          platform: os.type(),
          release: os.release(),
          cpus: os.cpus().length,
          loadavg: os.loadavg(),
          totalMemBytes: os.totalmem(),
          freeMemBytes: os.freemem(),
          uptimeSec: os.uptime(),
          procMemBytes: process.memoryUsage().rss,
          procUptimeSec: process.uptime(),
          nodeVersion: process.version,
        }),
      );
      return;
    }

    if (cmd === "日志") {
      const day = new Date().toISOString().slice(0, 10);
      const file = path.resolve("logs", `bot-${day}.log`);
      if (!fs.existsSync(file)) {
        return reply(msg, "今天还没有日志。");
      }
      try {
        await client.sendFile(msg.peerId, { file, forceDocument: true, replyTo: msg.id });
      } catch (err) {
        logger.error(`发送日志文件失败，改发文本：${err.message}`);
        try {
          const lines = fs.readFileSync(file, "utf-8").trimEnd().split("\n").slice(-15).join("\n");
          return reply(msg, `日志文件没发出去，改发最近 15 行：\n${lines}`);
        } catch (readErr) {
          return reply(msg, `日志读取失败：${readErr.message}`);
        }
      }
      return;
    }

    if (cmd === "关闭") {
      if (state.isPaused()) return reply(msg, "已经是关闭状态了。发 /ai 开启 恢复回复。");
      state.setPaused(true);
      return reply(msg, "已关闭：现在起任何人的提问我都不再回复、不调用模型（你的号主命令除外）。发 /ai 开启 恢复。");
    }

    if (cmd === "开启") {
      if (!state.isPaused()) return reply(msg, "本来就是开启状态，正常回复中。");
      state.setPaused(false);
      return reply(msg, "已开启：恢复正常回复。");
    }

    if (cmd === "账单" || cmd === "用量") {
      const bal = await balanceReport(pool.entries);
      const snap = usageStats.snapshot();
      await reply(
        msg,
        `今日账单：\n${pool.usageReport()}\nToken（今日）：输入 ${snap.totals.prompt} / 输出 ${snap.totals.completion} / 合计 ${snap.totals.total}\n\nAPI 余额：\n${bal}`,
      );
      return;
    }

    if (cmd === "用量报告") {
      const snap = usageStats.snapshot();
      const tokenLines = Object.entries(snap.models).map(
        ([m, r]) => `- ${m}：调用 ${r.calls} 次，Token 输入 ${r.prompt} / 输出 ${r.completion} / 合计 ${r.total}`,
      );
      const bal = await balanceReport(pool.entries);
      await reply(
        msg,
        [
          `用量报告（${snap.day}）：`,
          "",
          "各提供方今日用量：",
          pool.usageReport(),
          "",
          "Token 统计（今日，按模型）：",
          tokenLines.length > 0 ? tokenLines.join("\n") : "暂无",
          `合计：输入 ${snap.totals.prompt} / 输出 ${snap.totals.completion} / 合计 ${snap.totals.total}`,
          "",
          "API 余额：",
          bal,
        ].join("\n"),
      );
      return;
    }

    if (cmd === "开启用户名") {
      if (!saveAndReload({ usernameTrigger: true })) return reply(msg, "保存失败，请看日志。");
      return reply(msg, "已开启用户名触发：普通用户 @机器人用户名 就能提问，已生效。");
    }

    if (cmd === "关闭用户名") {
      if (!saveAndReload({ usernameTrigger: false })) return reply(msg, "保存失败，请看日志。");
      return reply(
        msg,
        "已关闭用户名触发：普通用户 @机器人用户名 不再触发（触发词、回复续聊、私聊不受影响；你和管理员 @用户名 照常能触发），已生效。",
      );
    }

    if (cmd === "拉黑") {
      const target = unwrapArg((rest[0] || "").trim());
      if (!target) return reply(msg, "用法：/ai 拉黑 <用户ID>");
      blacklist.add(target);
      persistBlacklist();
      return reply(msg, `已拉黑用户 ${target}`);
    }

    if (cmd === "解封") {
      const target = unwrapArg((rest[0] || "").trim());
      if (!target) return reply(msg, "用法：/ai 解封 <用户ID>");
      blacklist.delete(target);
      persistBlacklist();
      return reply(msg, `已解封用户 ${target}`);
    }

    if (cmd === "限速") {
      const target = unwrapArg((rest[0] || "").trim());
      if (!/^\d+$/.test(target)) return reply(msg, "用法：/ai 限速 <用户ID>");
      if (slowdownSet.has(target)) return reply(msg, `用户 ${target} 已经在限速名单里了。`);
      slowdownSet.add(target);
      persistSlowdown();
      return reply(msg, `已对 ${target} 开启限速：每次被成功回答后进入递增冷却（5 / 10 / 30 / 60 分钟），冷却内提问会被静默忽略。`);
    }

    if (cmd === "解除限速") {
      const target = unwrapArg((rest[0] || "").trim());
      if (!/^\d+$/.test(target)) return reply(msg, "用法：/ai 解除限速 <用户ID>");
      if (!slowdownSet.has(target)) return reply(msg, `用户 ${target} 不在限速名单里。`);
      slowdownSet.delete(target);
      slowdown.reset(target);
      persistSlowdown();
      return reply(msg, `已解除 ${target} 的限速，冷却与递增计数一并清零。`);
    }

    if (cmd === "加词" || cmd === "删词") {
      const words = rest.map((w) => w.trim()).filter(Boolean);
      if (words.length === 0) return reply(msg, `用法：/ai ${cmd} <关键词1> <关键词2> …`);
      let added = 0;
      let existed = 0;
      let removed = 0;
      let missing = 0;
      for (const w of words) {
        if (cmd === "加词") {
          if (codeKeywordSet.has(w)) existed += 1;
          else {
            codeKeywordSet.add(w);
            added += 1;
          }
        } else if (codeKeywordSet.delete(w)) removed += 1;
        else missing += 1;
      }
      persistCodeKeywords();
      if (cmd === "加词") {
        return reply(msg, `代码关键词已更新：新增 ${added} 个，已存在 ${existed} 个，现有共 ${codeKeywordSet.size} 个。`);
      }
      return reply(msg, `代码关键词已更新：删除 ${removed} 个，不存在 ${missing} 个，现有共 ${codeKeywordSet.size} 个。`);
    }

    if (cmd === "加屏蔽") {
      const gid = unwrapArg((rest[0] || "").trim());
      const word = unwrapArg(rest.slice(1).join(" ").trim());
      if (!gid || !word) return reply(msg, "用法：/ai 加屏蔽 <群ID> <词>");
      sensitiveGroupsSet.add(gid);
      sensitiveKeywordsSet.add(word);
      persistSensitive();
      return reply(msg, `已给群 ${gid} 添加屏蔽词：${word}（屏蔽词对所有屏蔽群生效）`);
    }

    if (cmd === "加管理员") {
      const target = unwrapArg((rest[0] || "").trim());
      if (!target) return reply(msg, "用法：/ai 加管理员 <用户ID>");
      if (isOwner(target, permConfig())) return reply(msg, "创建者本人就是最高权限，不用再加为管理员。");
      if (adminIds.has(target)) return reply(msg, `用户 ${target} 已经是管理员了`);
      adminIds.add(target);
      persistAdmins();
      return reply(msg, `已添加管理员 ${target}`);
    }

    if (cmd === "删管理员") {
      const target = unwrapArg((rest[0] || "").trim());
      if (!target) return reply(msg, "用法：/ai 删管理员 <用户ID>");
      if (!adminIds.has(target)) return reply(msg, `用户 ${target} 不在管理员名单里`);
      adminIds.delete(target);
      persistAdmins();
      return reply(msg, `已删除管理员 ${target}`);
    }

    if (cmd === "管理员列表") {
      if (adminIds.size === 0) {
        return reply(msg, "暂无管理员。用 /ai 加管理员 <用户ID> 添加。");
      }
      const lines = [...adminIds].map((id) => `- ${id}`);
      return reply(msg, `管理员名单（共 ${adminIds.size} 人）：\n${lines.join("\n")}`);
    }

    if (cmd === "查看api") {
      return reply(msg, `当前 API 列表：\n${providerListText()}`);
    }

    if (cmd === "查看模型") {
      const name = unwrapArg((rest[0] || "").trim());
      if (!name) return reply(msg, "用法：/ai 查看模型 <API名字>（名字看 /ai 查看api）");
      const entry = pool.getByName(name);
      if (!entry) return reply(msg, `没有叫「${name}」的提供方。先发 /ai 查看api 看名字。`);
      try {
        const list = await entry.client.models.list();
        const ids = ((list && list.data) || []).map((m) => m && m.id).filter(Boolean);
        if (ids.length === 0) return reply(msg, `「${name}」没返回任何模型。`);
        const shown = ids.slice(0, 50);
        const more = ids.length > shown.length ? `\n（共 ${ids.length} 个，只列前 ${shown.length} 个）` : "";
        return reply(msg, `「${name}」可用模型：\n${shown.map((id) => `- ${id}`).join("\n")}${more}`);
      } catch (err) {
        return reply(msg, `查询「${name}」的模型列表失败：${String(err.message || err).slice(0, 200)}`);
      }
    }

    if (cmd === "换模型" || cmd === "限额" || cmd === "换key" || cmd === "禁用api" || cmd === "启用api") {
      // 两步选择：这一条只负责列出选项并登记 pending，数字必须下一条单独发。
      return startSelect(msg, chatId, senderId, cmd);
    }

    if (cmd === "加聊天api") {
      const parts = rest.map((p) => unwrapArg(p.trim())).filter(Boolean);
      if (parts.length !== 4) {
        return reply(msg, "用法：/ai 加聊天api <名字> <baseURL> <key> <模型名>（名字不能有空格，四段都要有）");
      }
      const [name, baseURL, apiKeyValue, model] = parts;
      if (pool.getByName(name) || (config.customProviders || []).some((p) => p && p.name === name)) {
        return reply(msg, `提供方名字「${name}」已经有了，换个名字再加。`);
      }
      const next = [...(config.customProviders || []), { name, baseURL, [keyProp]: apiKeyValue, model }];
      if (!saveAndReload({ customProviders: next })) return reply(msg, "保存失败，请看日志。");
      return reply(msg, `已添加提供方「${name}」（模型 ${model}），已生效。发 /ai 查看api 可确认。（key 不会回显）`);
    }

    if (cmd === "绑定") {
      const word = unwrapArg((rest[0] || "").trim());
      const pname = unwrapArg((rest[1] || "").trim());
      if (!word || !pname) return reply(msg, "用法：/ai 绑定 <触发词> <API名字>");
      if (!TRIGGER_WORDS.includes(word)) return reply(msg, `触发词只能是 @aa ~ @az 之一，你发的是「${word}」。`);
      if (!pool.getByName(pname)) return reply(msg, `没有叫「${pname}」的提供方。先发 /ai 查看api 看名字。`);
      const map = { ...config.triggerMap, [word]: pname };
      if (!saveAndReload({ triggerMap: map })) return reply(msg, "保存失败，请看日志。");
      return reply(msg, `已绑定：${word} → ${pname}，已生效。`);
    }

    if (cmd === "解绑") {
      const word = unwrapArg((rest[0] || "").trim());
      if (!word) return reply(msg, "用法：/ai 解绑 <触发词>");
      if (!TRIGGER_WORDS.includes(word)) return reply(msg, `触发词只能是 @aa ~ @az 之一，你发的是「${word}」。`);
      const map = { ...config.triggerMap };
      if (!(word in map)) return reply(msg, `${word} 本来就没有绑定。`);
      delete map[word];
      if (!saveAndReload({ triggerMap: map })) return reply(msg, "保存失败，请看日志。");
      const note =
        word === DEFAULT_TRIGGER
          ? `已解绑 ${word}，它会回退到默认提供方（${config.defaultProvider || "default"}）。`
          : `已解绑 ${word}，用它提问会提示未绑定。`;
      return reply(msg, `${note}已生效。`);
    }

    if (cmd === "设人设") {
      const content = unwrapArg(rest.join(" ").trim());
      if (!content) return reply(msg, "用法：/ai 设人设 <内容>");
      if (!saveAndReload({ systemPrompt: content })) return reply(msg, "保存失败，请看日志。");
      return reply(msg, "人设已设置，已生效。发 /ai 人设 可查看当前人设。");
    }

    if (cmd === "人设") {
      if (config.systemPromptIsDefault) {
        return reply(
          msg,
          `当前用的是内置默认人设：\n${config.systemPrompt}\n\n设置：/ai 设人设 <内容>（比如：你是个毒舌但热心的群友，说话简短带点阴阳怪气）`,
        );
      }
      return reply(msg, `当前人设：\n${config.systemPrompt}\n\n改：/ai 设人设 <内容>；清除：/ai 清除人设`);
    }

    if (cmd === "清除人设") {
      if (!saveAndReload({ systemPrompt: "" })) return reply(msg, "保存失败，请看日志。");
      return reply(msg, "人设已清除，回到内置默认人设，已生效。");
    }

    if (cmd === "记住") {
      const content = rest.join(" ").trim();
      if (!content) return reply(msg, "用法：/ai 记住 <内容>");
      const added = notebook.addFacts(chatId, [content]);
      if (added > 0) return reply(msg, `记好了：${content}`);
      return reply(msg, "这条没记上：记事本里已经有了，或它是以机器人为主语的内容。");
    }

    if (cmd === "记事本") {
      const list = notebook.facts(chatId);
      if (list.length === 0) {
        return reply(msg, "当前会话的记事本是空的。用 /ai 记住 <内容> 手工加一条；平时聊天答满次数也会自动整理。");
      }
      const lines = list.map((f, i) => `${i + 1}. ${f}`);
      return reply(msg, `当前会话记事本（共 ${list.length} 条）：\n${lines.join("\n")}`);
    }

    if (cmd === "忘掉") {
      const target = unwrapArg((rest[0] || "").trim());
      const removed = notebook.removeAt(chatId, Number(target));
      if (removed) return reply(msg, `已忘掉第 ${target} 条：${removed}`);
      return reply(msg, "用法：/ai 忘掉 <序号>（序号看 /ai 记事本）");
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
        return w === "@ai" ? `${w} → ${config.defaultProvider || "default"}（默认）` : `${w} → （未绑定）`;
      });
      return reply(msg, `触发词绑定：\n${lines.join("\n")}`);
    }

    return reply(msg, "未知命令。发 /ai 帮助 看全部命令（都是代码写死的固定说明，不走模型）。");
  }

  async function handleChat(msg, chatId, senderId, speakerName, parsed) {
    if (!parsed.question) {
      await reply(msg, "在触发词后面写上你的问题，例如：@ai 今天天气怎么样");
      return;
    }
    if (parsed.providerName === null) {
      await reply(msg, `触发词 ${parsed.trigger} 还没有绑定模型，请联系号主绑定（/ai 绑定）。`);
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
        message: PLACEHOLDER_TEXT,
        replyTo: msg.id,
      });
    } catch (err) {
      logger.error(`发送占位消息失败（chat=${chatId}）：${err.message}`);
      return;
    }

    const history = store.get(chatId, senderId);
    // 系统提示 = 基础提示 + 创建者信息（认主）+ 发言者身份/称呼 + 对他的印象 + 本会话记事本 + 当前时间。
    // 后几段都是程序生成的系统级信息，不是用户能伪造的。
    const systemParts = [config.systemPrompt];
    const on = ownerNote(config);
    if (on) systemParts.push(on);
    const role = speakerSegment(senderId, speakerName);
    if (role) systemParts.push(role);
    const imp = impressionSegment(senderId);
    if (imp) systemParts.push(imp);
    const nb = notebookSegment(chatId);
    if (nb) systemParts.push(nb);
    // 当前时间段：不给的话模型对「现在几点了」只能瞎编或说不知道。
    systemParts.push(formatNowLine(config.timezone));
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
        let seenUsage = null;
        const text = await pool.chat(
          entry,
          messages,
          (partial) => {
            const t = Date.now();
            if (t - lastEditAt >= EDIT_INTERVAL_MS && partial.trim()) {
              lastEditAt = t;
              client
                .editMessage(msg.peerId, { message: placeholder.id, text: partial.slice(0, TG_MESSAGE_LIMIT) })
                .catch(() => {});
            }
          },
          (u) => {
            seenUsage = u;
          },
        );
        answer = text;
        usedEntry = entry;
        pool.markSuccess(entry);
        usageStats.record(entry.model, seenUsage);
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

    // 限速：名单内的普通用户每次被成功回答后进入递增冷却（档位在 SlowdownTracker 里）。
    if (slowdownSet.has(senderId) && roleOf(senderId, permConfig()) === "user") {
      const mins = slowdown.recordAnswer(senderId);
      logger.info(`限速用户 ${senderId} 已被回答，进入 ${mins} 分钟冷却`);
    }

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

      // 号主专属流程：命令解析在最前；两步选择（pending）的数字/全文回复紧随其后，
      // 都排在全局暂停门禁之前——暂停时号主照样能管理。
      if (canRunOwnerCommand(senderId, permConfig())) {
        const body = parseOwnerCommand(text);
        if (body !== null) {
          pending.clear(chatId, senderId);
          await handleOwnerCommand(msg, chatId, senderId, body);
          return;
        }
        const pk = pending.peek(chatId, senderId);
        if (pk) {
          const trimmed = text.trim();
          if (pk.expired) {
            pending.clear(chatId, senderId);
            if (/^\d+$/.test(trimmed)) {
              await reply(msg, "已超时，请重新发命令。");
              return;
            }
            // 过期且不是数字：已清掉，按普通消息继续往下走。
          } else if (pk.entry.step === 2 && pk.entry.kind === "换key") {
            // 换key 第二步：下一条消息全文就是新 key（命令已在上面先行拦截，不会误吞命令）。
            pending.consume(chatId, senderId);
            await executePending(msg, chatId, senderId, pk.entry, trimmed);
            return;
          } else if (/^\d+$/.test(trimmed)) {
            pending.consume(chatId, senderId);
            await executePending(msg, chatId, senderId, pk.entry, trimmed);
            return;
          } else if (pk.entry.step === 2 && pk.entry.kind === "限额") {
            await reply(msg, "限额要发纯数字（0 = 不限）。请单独发一个数字；不想改了就等 60 秒过期。");
            return;
          }
          // 其余情况（等数字时发了别的内容）：不清 pending，按普通消息继续往下走。
        }
      }

      // 全局暂停门禁：创建者用 /ai 关闭 后，谁的提问都不回、不调模型（省 token）。
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

      const role = roleOf(senderId, permConfig());

      let parsed = parseTrigger(text, {
        username: config.myUsername,
        triggerMap: config.triggerMap,
        defaultProvider: config.defaultProvider,
        usernameTrigger: config.usernameTrigger,
        role,
      });

      // 回复续聊：没命中触发词时，若这条消息回复的是机器人自己发出的消息，也算触发，
      // 问题就是消息全文（群聊、私聊都适用）。没带回复标记的消息直接跳过，不做无谓查询。
      if (!parsed && (msg.replyTo || msg.replyToMsgId != null)) {
        try {
          if (typeof msg.getReplyMessage === "function") {
            const replied = await msg.getReplyMessage();
            if (isReplyToSelf(replied, selfId)) {
              parsed = {
                kind: "reply",
                trigger: null,
                providerName: resolveProvider(DEFAULT_TRIGGER, config.triggerMap, config.defaultProvider),
                question: text.trim(),
              };
            }
          }
        } catch (err) {
          logger.error(`取被回复消息失败（chat=${chatId}）：${err.message}`);
        }
      }

      // 私聊直通：私聊里不用 @ 也不用触发词，任何普通文本都直接当问题。
      // （走在 parseTrigger 之后：文本恰好以提及/触发词开头时，仍用上面的解析结果，
      // 不会把触发词留给模型看。号主命令、暂停门禁、私聊门禁都在更前面，不受影响。）
      if (!parsed && isPrivateChat) {
        parsed = {
          kind: "direct",
          trigger: null,
          providerName: resolveProvider(DEFAULT_TRIGGER, config.triggerMap, config.defaultProvider),
          question: text.trim(),
        };
      }

      if (!parsed) return;

      // 帮助拦截：被触发后提取出的问题恰好是「帮助」类写法时，直接回代码写死的
      // 公开版帮助，不发占位符、不调模型（不然模型会现编一份假能力清单）。
      // 号主发 /ai 帮助 已在上面的号主命令里处理（回的是更全的号主帮助）；
      // 号主发 @ai 帮助 走的是触发词聊天路径，问题恰好是「帮助」，命中的就是这里的公开帮助。
      if (isHelpQuery(parsed.question)) {
        await reply(msg, PUBLIC_HELP_TEXT);
        return;
      }

      // 屏蔽群/屏蔽词：屏蔽群内的问题命中屏蔽词 → 静默不回（号主豁免，管理员不豁免）。
      if (
        role !== "owner" &&
        isSensitiveBlocked(chatId, parsed.question, [...sensitiveGroupsSet], [...sensitiveKeywordsSet])
      ) {
        logger.info(`屏蔽词拦截：chat=${chatId} user=${senderId}，静默不回`);
        return;
      }

      // 限速门禁：名单内的普通用户还在递增冷却里 → 静默忽略。
      if (role === "user" && slowdownSet.has(senderId) && slowdown.isBlocked(senderId)) {
        logger.info(`限速冷却中，忽略用户 ${senderId} 的提问（chat=${chatId}）`);
        return;
      }

      // 代码关键词：普通用户的问题命中任一关键词 → 回提醒并计数，累计第 3 次自动拉黑。
      // 号主/管理员豁免。
      if (role === "user") {
        const hit = findKeyword(parsed.question, [...codeKeywordSet]);
        if (hit) {
          const n = (codeWarnCounts.get(senderId) || 0) + 1;
          codeWarnCounts.set(senderId, n);
          if (n >= CODE_WARN_LIMIT) {
            blacklist.add(senderId);
            persistBlacklist();
            logger.warn(`用户 ${senderId} 第 ${n} 次命中代码关键词，已自动拉黑`);
            await reply(msg, "你已多次提出这类代码生成请求，已被拉黑。如有疑问请联系号主。");
          } else {
            await reply(msg, `这类代码生成请求我不处理，换个问法吧。（第 ${n} 次提醒，再命中 ${CODE_WARN_LIMIT - n} 次会被拉黑）`);
          }
          return;
        }
      }

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
