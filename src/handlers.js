// 消息处理：路由触发与号主命令，跑流式问答并把结果编辑回占位消息。
// 整个处理函数包在 try/catch 里：任何异常都记日志，绝不静默吞掉。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { Api} from "telegram";
import {
parseTrigger,
parseOwnerCommand,
parseMentionOwnerCommand,
isReplyToSelf,
isHelpQuery,
} from "./triggers.js";
import { formatNowLine} from "./time.js";
import { saveConfigJson} from "./config.js";
import { rootPath } from "./rootdir.js";
import { balanceReport} from "./billing.js";
import { Notebook, parseConsolidationSections} from "./notebook.js";
import { UserProfiles, extractCallName} from "./profiles.js";
import {
canRunOwnerCommand,
canUsePrivateChat,
isOwner,
ownerNote,
describeRole,
roleOf,
shouldPauseBlock,
speakerAssertion,
} from "./permissions.js";
import { RuntimeState} from "./state.js";
import { PendingSelections} from "./pending.js";
import { UsageStats} from "./usagestats.js";
import { SlowdownTracker} from "./limits.js";
import { findKeyword, isSensitiveBlocked, unwrapArg} from "./moderation.js";
import { formatServerInfo} from "./serverinfo.js";
import { collectSecrets, scrubSecrets} from "./security.js";
import { flattenVisionPool, pickVisionEntry, visionListText, looksVisionCapable } from "./vision.js";
import { createApiClient as defaultCreateApiClient, displayModelName } from "./providers.js";
import { GroupRecords, renderRecords} from "./records.js";
import {
planSearch,
cleanSearchQuery,
buildSerperRequest,
parseSerperResults,
buildTavilyRequest,
parseTavilyResults,
buildBraveSearchUrl,
parseBraveMarkdown,
buildBingSearchUrl,
parseBingMarkdown,
buildYahooSearchUrl,
parseYahooMarkdown,
buildYahooImageSearchUrl,
parseYahooImageResults,
sanitizeRewrittenQuery,
formatSearchContext,
maskSearchKey,
} from "./search.js";
import { buildTtsRequest, pickVoiceName, cleanSpeechText, parseVoiceSwitch, voiceQueryKind} from "./tts.js";
import { isImageGenRequest, isLooseImageGenRequest, extractImagePrompt, isReferentialImagePrompt, buildImageGenRequest, parseImageGenResponse} from "./imagegen.js";
import { decideSplit, MAX_SPLIT_PARTS } from "./split.js";
import { composeClockName, currentHHMM} from "./nameclock.js";
import { toolGate, TOOLS_PROMPT_NOTE, executeTool, extractTextToolCalls, stripTextToolCalls, directToolCommand, mechanicalBulkRequest, bulkRefusalNote } from "./tools.js";
import { chatWithTools } from "./toolchat.js";
import { ToolStore } from "./toolstore.js";
import { synthesizeEdgeTts, EDGE_DEFAULT_VOICE } from "./edgetts.js";

const EDIT_INTERVAL_MS = 1500; // 流式刷新占位消息的最短间隔
const TG_MESSAGE_LIMIT = 4000; // Telegram 单条消息上限约 4096，留点余量分片
const CODE_WARN_LIMIT = 3; // 代码关键词命中第几次时自动拉黑

/** 占位消息文案（纯文字，不带任何表情，用户定版格式）。 */
export const PLACEHOLDER_TEXT = "（思考中...）";

/**
* 号主帮助：代码写死的固定文本（不走模型），内容与 handleOwnerCommand 的真实分支逐条对齐。
* 号主命令只认 /ai 前缀（如「/ai 状态」），其他任何写法都不当命令。
*/
export const OWNER_HELP_TEXT = `可用命令：

注：带（再回 <序号>）的命令要分两条发——先单独发命令，它列出选项后，60 秒内再单独回数字；把数字和命令写在同一条里不生效。

【基础】
/ai 帮助
/ai 状态
/ai 服务器
/ai 日志
/ai 账单（查看今日用量、Token 与余额；「用量」「用量报告」是它的别名）

【用户名】
/ai 开启用户名
/ai 关闭用户名（关后普通用户 @用户名 无法触发；回复续聊、私聊不受影响）

【管理员】
/ai 加管理员 <用户ID>
/ai 删管理员 <用户ID>
/ai 管理员列表（管理员是主人信任的人：机器人认得他、不受限速和提问冷却影响）
/ai 加访客 <用户ID>（访客：私聊门禁开着时也能私聊，但没有管理员权限，照常受限速与冷却）
/ai 删访客 <用户ID>
/ai 访客列表

【拉黑/限速】
/ai 拉黑 <用户ID>
/ai 解封 <用户ID>
/ai 限速 <用户ID>
/ai 解除限速 <用户ID>

【关键词】
/ai 加词 <关键词…>
/ai 删词 <关键词…>
/ai 加屏蔽 <群ID> <词>（指定群里有人发这个词就静默不理；不带参数回当前屏蔽词列表）

【API 管理】
/ai 查看api
/ai 查看模型 <API名字>
/ai 换模型（回序号选 API，再回序号从它的全部模型里挑，不用记模型名；聊天 API 挑完即默认用它，生图 API 只换生图模型）
/ai 限额（再回 <序号>）
/ai 换key（再回 <序号> 选 API，再发新 key 全文；改完立即生效，不用重启）
/ai 禁用api（再回 <序号>）
/ai 启用api（再回 <序号>）
/ai 加聊天api（发命令后按提示分步发名字、baseURL、key、模型名；也可一条发全四个参数）
/ai 加生图api（分步添加同上；只用于生图，不参与聊天）
/ai 加识图api（分步添加识图专用 API：名字、baseURL、key，再从它的模型列表里挑识图模型；不参与聊天）

【识图】
/ai 加识图（再回 <序号> 选 API，再回 <序号> 从它的模型列表里挑；选完自动拿测试图实测）
/ai 删识图（再回 <序号>）
/ai 识图权重（再回 <序号> 选条目，再发新权重）
/ai 识图列表
（识图池建好后，发照片提问、或回复一张照片提问，会自动用池里接口识图）

【语音/人格】
/ai 换tts接口 <地址>
/ai 换ttskey <新key>（改完立即生效，不回显）
/ai 加音色（先发名字，再发音色 ID）
/ai 删音色（再回 <序号>）
/ai 音色列表
/ai 加人格（再回 <序号> 选音色，再发人格提示词全文）
/ai 删人格（再回 <序号>）
/ai 人格列表
/ai 开启换音色（在本群发，作用于本群）
/ai 关闭换音色
/ai 开启说（在本群发：回答后追加一条语音）
/ai 关闭说
（群友小命令：音色列表 / 当前音色 / 换音色 <音色名>，开启换音色的群里可用）

【群聊天记录】
/ai 开启记录（在本群发，作用于本群；别名 开启上下文）
/ai 关闭记录（别名 关闭上下文）
/ai 查看记录（群里看本群最近记录，私聊看已开启的群列表）
/ai 记录条数 <数字>（回答时带入的最近记录条数）

【搜索 Key】
/ai 查看搜索key（只显示尾号）
/ai 换搜索key（再回 <序号> 选「搜索」，再发新 key 全文；改完立即生效，不回显）
（配了搜索 key 后，问时效性问题会先联网搜索再回答；问题里带「联网搜索」走深度搜索）

【破甲】
/ai 破甲（查看当前破甲）
/ai 破甲 <内容>（最高优先级，强制按这套运行；人设次之）
/ai 清除破甲

【人设】
/ai 设人设 <内容>
/ai 人设
/ai 清除人设

【记事本】
/ai 记住 <内容>
/ai 记事本
/ai 忘掉 <序号>
/ai 清空记事本
/ai 称呼 <用户ID> <称呼>
/ai 印象 <用户ID>（查看该用户的称呼、印象与用户记事本；别名 查看印象）
/ai 印象 <用户ID> <内容>（设置印象）
/ai 忘掉用户 <用户ID> <序号>（删该用户记事本里的一条）
/ai 清空用户记忆 <用户ID>

【机器人改名】
/ai 改名 <名字>（只改打头的名字；姓氏位固定是名字时钟的时间，不设自定义姓氏；别名 设置名称）

【实用工具】（不用命令，聊天时直接说，我会自己调用工具去查/去算，不用 Key）
查天气、翻译、百度/微博/抖音/B站热榜、汇率换算、加密货币价格、金价、油价、股票/指数行情、电影票房、豆瓣电影、维基百科/维基数据/DuckDuckGo、IP 归属、一言、今日诗词、图书查询、GitHub 仓库搜索、世界时间、黄历、星座运势、塔罗、抽签、掷骰子、抛硬币、二维码生成、短网址还原、Base64/URL/摩斯编解码、哈希、JSON 格式化、进制转换、单位换算、日期差、随机数、密码生成、字数统计、颜色换算、设定时提醒、待办清单。语音朗读自带默认音色，没配 TTS 接口也能用。

其他：
/ai 关闭（全局暂停：暂停期间只放行你自己的命令）
/ai 开启（恢复）
/ai 清空上下文

触发方式：群里 @用户名 提及、或回复我发出的消息；私聊直接发。
私聊：默认只放行主人与管理员（config.privateChat）。`;

/**
* 公开帮助：给普通用户看的固定文本（不走模型），只写群友能用的，
* 不含任何号主命令与敏感信息。
*/
export const PUBLIC_HELP_TEXT = `使用帮助：

- 群里：@机器人用户名 + 你的问题，就能问我
- 回复我发出的任意一条消息提问，就能接着上文继续聊，不用再 @
- 私聊：直接发消息就行，不用 @、不用加任何前缀
- 问现在几点、今天几号，我按北京时间回答
- 公开命令：@我 后发 /ai 帮助、/ai 账单、/ai 模型、/ai 人设 可以直接用（公开版，不走模型）
- 还能直接让我：查天气、翻译、看热搜热榜、查汇率/币价/金价、算票房、查豆瓣电影、查百科、查 IP 归属、来一言/古诗、查图书、生成二维码、还原短网址、编解码、算哈希、进制/单位换算、算日期差、生成密码、统计字数、抽签、掷骰子、塔罗、看星座运势和黄历、设定时提醒、记待办——直接说就行，不用记命令

想让我做点什么，直接说就行。`;

const CONSOLIDATE_EVERY = 4; // 每会话每答满 N 次，后台自动整理一次记事本与印象（v0.7.1 由 8 降为 4，号主拍板：记忆攒得快更重要）

/** 一条消息有没有带照片（GramJS 的 Message.photo 或 media 里的 photo）。 */
function msgHasPhoto(m) {
if (!m || typeof m!== "object") return false;
if (m.photo) return true;
const media = m.media;
if (media && typeof media === "object") {
if (media.photo) return true;
if (media.className === "MessageMediaPhoto") return true;
}
return false;
}

/**
* 创建消息处理函数（签名符合 GramJS 的 addEventHandler 回调）。
* @param {object} deps { client, config, pool, store, logger, startedAt, notebook, profiles,
* state, selfId, pending, slowdown, usageStats, records, reloadRuntime, fetchImpl, sleep,
* splitDelayMs, updateProfile}
* notebook / profiles / state / pending / slowdown / usageStats / records 可省略，
* 省略时用纯内存版，方便测试与临时运行。
* reloadRuntime 可省略：提供时，号主命令改完 config.json 会调它重新加载配置并重建
* 提供方池（返回 { config, pool}），改动立即生效；省略时改动只落盘、下次启动才生效。
* fetchImpl / sleep / splitDelayMs / updateProfile 是可注入点（测试用），省略时用真实实现。
* selfId 是本账号的数字 ID（回复续聊判定用），可省略，省略时回复续聊只认 out 标记。
*/
export function createHandler(deps) {
const { client, store, logger, startedAt} = deps;

// 实体缓存预热：新会话第一次给某个私聊对象发消息时，GramJS 只凭 PeerUser（无 accessHash）
// 解析不出 input entity，会报 "Could not find the input entity"（私聊消息走 UpdateShortMessage、
// 不带完整实体，缓存里没有）。拉一次会话列表可把已有对话的实体灌进缓存。
let entityWarmPromise = null;
function warmEntities() {
  if (!entityWarmPromise) {
    entityWarmPromise = Promise.resolve()
      .then(() => client.getDialogs())
      .catch(() => {})
      .finally(() => {
        entityWarmPromise = null;
      });
  }
  return entityWarmPromise;
}

/** 发消息到某个 peer；遇到实体未缓存先预热再重试一次，其余错误照常抛出。 */
async function sendToPeer(peer, params) {
  try {
    return await client.sendMessage(peer, params);
  } catch (err) {
    if (!/Could not find the input entity/.test((err && err.message) || "")) throw err;
    await warmEntities();
    return client.sendMessage(peer, params);
  }
}
let config = deps.config;
let pool = deps.pool;
const selfId = deps.selfId!== undefined && deps.selfId!== null? String(deps.selfId): "";
const notebook = deps.notebook || new Notebook(null);
const userNotebook = deps.userNotebook || new Notebook(null);
const profiles = deps.profiles || new UserProfiles(null);
const state = deps.state || new RuntimeState(null);
const pending = deps.pending || new PendingSelections();
const slowdown = deps.slowdown || new SlowdownTracker();
const usageStats = deps.usageStats || new UsageStats(null);
const records = deps.records || new GroupRecords(null);
const toolStore = deps.toolStore || new ToolStore(null);
const fetchImpl = deps.fetchImpl || ((...args) => globalThis.fetch(...args));
// 临时 API 客户端工厂（加识图api 查模型/实测用，可注入点，测试可换假实现）。
const createApiClient = deps.createApiClient || defaultCreateApiClient;
// Lightpanda 搜索执行器（可注入点，测试可换假实现）：拉起本机 Lightpanda 抓给定地址的结果页 Markdown。
const lightpandaFetch =
deps.lightpandaFetch ||
((bin, url) =>
new Promise((resolve, reject) => {
execFile(
bin || "/opt/lightpanda/lightpanda",
["fetch", "--dump", "markdown", url],
{
timeout: 30000,
maxBuffer: 4 * 1024 * 1024,
env: { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: "true" },
},
(err, stdout) => (err ? reject(err) : resolve(String(stdout || ""))),
);
}));
// 搜图执行器（给 find_photo 工具经 ctx 注入）：走 Lightpanda 抓 Yahoo 图片搜索，
// 返回原图地址列表；非 lightpanda 后端时返回空（工具会如实回「通道未启用」）。
const imageSearchImpl = async (query) => {
if (config.searchProvider !== "lightpanda") return [];
const md = await lightpandaFetch(config.lightpandaBin, buildYahooImageSearchUrl(query));
return parseYahooImageResults(md);
};
// 联网搜索执行器（给 web_search 工具经 ctx 注入）：与自动注入同一套引擎链
// （Yahoo → Brave → Bing）和同一份 15 分钟缓存，返回结果摘要文本；搜不到返回
// 空串（工具会如实回没搜到）。此前模型手里没有搜索工具：自动注入没触发时，
// 被用户催着搜只能拿热搜榜的标题凑数、甚至编造搜索过程（2026-11-24 茶话会实测）。
const webSearchImpl = async (query) => {
const q = cleanSearchQuery(query) || String(query || "").trim();
if (!q) return "";
if (config.searchProvider === "lightpanda") {
const cacheKey = `lightpanda:${q.toLowerCase()}`;
const cached = searchCache.get(cacheKey);
if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) return cached.text;
let result = { text: "", urls: [] };
for (const attempt of [
async () => parseYahooMarkdown(await lightpandaFetch(config.lightpandaBin, buildYahooSearchUrl(q))),
async () => parseBraveMarkdown(await lightpandaFetch(config.lightpandaBin, buildBraveSearchUrl(q))),
async () => parseBingMarkdown(await lightpandaFetch(config.lightpandaBin, buildBingSearchUrl(q))),
]) {
try {
result = await attempt();
} catch {
result = { text: "", urls: [] };
}
if (result.text) break;
}
if (result.text) {
if (searchCache.size > 100) searchCache.clear();
searchCache.set(cacheKey, { text: result.text, at: Date.now() });
return result.text;
}
return "";
}
if (config.searchApiKey) {
try {
const req = buildSerperRequest(config.searchApiBase, config.searchApiKey, q);
const res = await fetchImpl(req.url, req.options);
if (res && res.ok) {
const data = await res.json();
return parseSerperResults(data).text || "";
}
} catch {
// 工具层失败统一按搜不到处理，模型会如实告知。
}
}
return "";
};
const sleepFn = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
const updateProfile =
deps.updateProfile ||
(async (firstName, lastName) => {
await client.invoke(new Api.account.UpdateProfile({ firstName, lastName: lastName || undefined}));
});

const blacklist = new Set(config.blacklist || []);
/** @type {Set<string>} 管理员名单（创建者用命令增删，持久化在 config.json） */
const adminIds = new Set((config.adminIds || []).map(String));
/** @type {Set<string>} 访客名单（创建者用命令增删，持久化在 config.json；仅私聊放行） */
const guestIds = new Set((config.guestIds || []).map(String));
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
/** 搜索结果缓存（进程内，15 分钟）：群里重复问题不重复抓——少抓一次就少一分被
 * 搜索引擎弹人机验证的概率（Brave 对高频抓取会弹 PoW 验证），重复问答也更快。 */
const searchCache = new Map();
const SEARCH_CACHE_TTL_MS = 15 * 60 * 1000;
/** @type {string[]} 机器人最近经 reply() 发出的文案（回声免疫：同文再被送达就忽略） */
const recentSentTexts = [];
/**
 * @type {Map<string, number>} 敏感文本 pending 过期后的「墓碑」：key=chatId:senderId，value=到期时间戳。
 * 墓碑期内该用户的下一条非命令消息会被吞掉（不写群记录、不发给模型），
 * 防迟到的 key/凭证被当普通聊天处理（审计 K062-01）。
 */
const sensitiveTombstones = new Map();
const TOMBSTONE_TTL_MS = 10 * 60 * 1000;
const TOMBSTONE_NOTICE = "上一步已超时，这条消息已忽略，不会发给模型、也不会被记录。请重新发命令。";

/** 这条 pending 是不是在等「敏感自由文本」（新 key、音色 ID、人格提示词、识图模型名等整条填入的内容）。 */
function isSensitiveTextPending(entry) {
if (!entry) return false;
return (
(entry.kind === "换key" && entry.step === 2) ||
(entry.kind === "换搜索key" && entry.step === 2) ||
(entry.kind === "加识图" && entry.step === 2) ||
entry.kind === "加api" ||
entry.kind === "加音色" ||
(entry.kind === "加人格" && entry.step === 2)
);
}

// 权限判断用的配置视图：管理员名单以运行时 Set 为准（命令增删后立刻生效，不必重启）。
function permConfig() {
return { ownerId: config.ownerId, adminIds: [...adminIds], guestIds: [...guestIds], privateChat: config.privateChat};
}

const QUOTE_MIN_LENGTH = 1000;
/** 折叠的行数门槛：单条消息超过 8 行也折叠（v0.9.25）。 */
const QUOTE_MIN_LINES = 8;

/**
 * 超长文本的 TG 可展开引用实体：整段折叠成引用块，点开才展开，避免长文刷屏
 * （号主要求，帮助这类超长文尤其明显）。短文本返回 undefined（不加格式）。
 * 长度按 JS 字符串长度计，与 TG 的 UTF-16 偏移口径一致。
 * 触发条件二选一：字数 ≥1000，或行数 >8——人设分条的尾条会把剩余行数全并成一条，
 * 字数不多但二三十行竖着刷屏（2026-11-23 群内实测讲故事被指「太刷了」），
 * 光看字数拦不住，必须同时看行数。
 */
function quoteEntitiesFor(text) {
if (!text) return undefined;
if (text.length < QUOTE_MIN_LENGTH && text.split("\n").length <= QUOTE_MIN_LINES) return undefined;
return [new Api.MessageEntityBlockquote({ offset: 0, length: text.length, collapsed: true })];
}

async function reply(msg, text) {
await sendToPeer(msg.peerId, { message: text, replyTo: msg.id, formattingEntities: quoteEntitiesFor(text) });
recentSentTexts.push(String(text).trim());
if (recentSentTexts.length > 30) recentSentTexts.shift();
}

/** 模型列表分段：编号连续、每段压在 Telegram 单条上限内。站上几百个模型时全量
 * 列出、分几条发，不再只列前 50 个（号主对着 264 个模型的站实测要求取消上限）。 */
function chunkModelList(header, lines, footer) {
const LIMIT = 3500;
const chunks = [];
let cur = header || "";
let hasLine = false;
for (const line of lines) {
const next = cur ? `${cur}\n${line}` : line;
if (hasLine && next.length > LIMIT) {
chunks.push(cur);
cur = line;
} else {
cur = next;
}
hasLine = true;
}
if (footer) {
const next = cur ? `${cur}\n${footer}` : footer;
if (hasLine && next.length > LIMIT) {
chunks.push(cur);
cur = footer;
} else {
cur = next;
}
}
chunks.push(cur);
return chunks;
}

async function replyModelList(msg, header, lines, footer) {
for (const chunk of chunkModelList(header, lines, footer)) await reply(msg, chunk);
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

function persistGuests() {
try {
saveConfigJson({ guestIds: [...guestIds]});
} catch (err) {
logger.error(`保存访客名单失败：${err.message}`);
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
function speakerSegment(senderId, speakerName, speakerUsername) {
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
if (speakerUsername) {
parts.push(
`当前说话人的 Telegram 用户名是 @${speakerUsername}。需要 @ 他时，在回复正文里写 @${speakerUsername} 就能 @ 到他（Telegram 会自动识别成提及）；不要说不知道他的用户名，更不要让他把用户名发给你。`,
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

/** 用户记事本段：关于当前说话人本人的长期事实，按账号 ID 记、跨所有群与私聊通用。空时返回空串。 */
function userNotebookSegment(senderId) {
const rendered = userNotebook.render(senderId);
if (!rendered) return "";
return `系统备注：这些是你记住的、关于当前说话人本人的事（按他的账号记的，在任何群、任何私聊里都通用，不要跟他说「只在这个对话里记得」）。被问到时用你自己的话自然地讲出来，就像你本来就记得一样：不要照抄下面的条目原文，不要动不动说「谁说的」，只有被追问来源时才提一句出处。\n${rendered}`;
}

/** 记事本段：当前会话的长期事实，要求用自己的话转述、不照抄不报出处。空时返回空串。 */
function notebookSegment(chatId) {
const rendered = notebook.render(chatId);
if (!rendered) return "";
return `系统备注：这些是你记住的、本会话的事（只属于当前会话，别的会话不要提）。被问到时用你自己的话自然地讲出来，就像你本来就记得一样：不要照抄下面的条目原文，不要动不动说「谁说的」，只有被追问来源时才提一句出处。\n${rendered}`;
}

/** 本群是否在记录：默认全群记录（recordAllGroups 缺省开），静默名单里的群不记；
 * recordAllGroups 被关掉时退回旧白名单（recordGroups）模式。 */
function recordsEnabledFor(chatId) {
const id = String(chatId);
if ((config.recordMutedGroups || []).includes(id)) return false;
if (config.recordAllGroups !== false) return true;
return (config.recordGroups || []).includes(id);
}

/** 群聊天记录段：本群在记录时，把最近 N 条记录拼进来，让模型知道大家在聊什么。 */
function recordsSegment(chatId) {
if (!recordsEnabledFor(chatId)) return "";
const limit = (config.recordContextLimit || {})[chatId] || 100;
const rendered = renderRecords(records.recent(chatId, limit), config.timezone);
if (!rendered) return "";
return `【本群最近的聊天记录】（每条开头的 [月-日 时:分] 是这条消息的时间，与上面当前时间的时区一致；供你了解大家在聊什么。注意：这份记录可能不全——大群里会漏掉很多。用户问「今天/昨天/刚才群里聊了什么」时，先调用 group_history 工具实时拉取再回答，不要只凭这段记录下结论；拉回来的记录按日期对着汇总，不要把别的日期的事说成那天的）\n${rendered}`;
}

/** 语音人格段：本群开启了说、且当前音色设了人格时注入，塑造说话风格（随后会追加语音朗读同一文本）。 */
function voicePersonaSegment(chatId, senderId) {
if (!config.saySwitch ||!config.saySwitch[chatId]) return "";
const voice = pickVoiceName(config, chatId, senderId);
if (!voice.name) return "";
const persona = (config.voicePersona || {})[voice.name];
if (!persona) return "";
return `【语音人格】你在这个群用「${voice.name}」音色说话，人格设定：${persona}。按这个人格的身份和语气回复，口语化、简短，像真人说话。`;
}

/**
* 系统提示拼装（顺序定版）：
* 人设（systemPrompt，含默认风格）→ 破甲（最高优先级）→ 创建者信息 → 发言者/称呼
* → 印象 → 记事本 → 用户记事本 → 群记录 → 语音人格 → 当前时间 → 身份断言（最末尾）。
*/
function buildSystemParts(senderId, speakerName, chatId, speakerUsername, extraNote) {
const parts = [config.systemPrompt];
const pj = (config.poJia || "").trim();
if (pj) parts.push("【最高优先级指令" + "，覆盖其他一切风格要求】" + pj);
const on = ownerNote(config);
if (on) parts.push(on);
const seg = speakerSegment(senderId, speakerName, speakerUsername);
if (seg) parts.push(seg);
const imp = impressionSegment(senderId);
if (imp) parts.push(imp);
const nb = notebookSegment(chatId);
if (nb) parts.push(nb);
const unb = userNotebookSegment(senderId);
if (unb) parts.push(unb);
const rec = recordsSegment(chatId);
if (rec) parts.push(rec);
const vp = voicePersonaSegment(chatId, senderId);
if (vp) parts.push(vp);
// 当前时间段：不给的话模型对「现在几点了」只能瞎编或说不知道。
parts.push(formatNowLine(config.timezone));
// 链接格式段：Telegram 会把无空格连写的「名称（域名）—」整串误标成一个网址（混着中文与
// 全角括号、点开报无法打开），故要求模型写网址用完整链接并留空格（v0.9.10 群内实测教训）。
parts.push("【链接格式】先会分辨该不该带链接：闲聊、解释、讲怎么用这类回答，用自己的话讲完就行，不要贴参考链接、不要罗列出处；只有对方明确要链接，或答案离了链接没法用（下载地址、原文页）时才给，最多一个。真要写网址时，用完整链接（带 https://）并与前后文字留空格，例如「AI星踪岛 https://aixzd.com/rank 」；不要写成「名称（域名）」这种把域名用括号贴在名称后面的格式，会被 Telegram 误认成打不开的链接。");
// 消息核实段（v0.9.24）：同一晚群内实测两极——私聊里用户随口转述「英伟达恢复老黄 CEO」，
// 模型没查证就顺着确认、还编出「盘前飙三成」；1024 群里它又凭旧知识说「他本来就没走过」
// 把当天的真新闻否了（他 11 月 11 日真辞职过、当天真复职）。两头都是没有核实纪律：
// 未证实的断言不许确认、不许编数字；旧知识也不许否定刚发生的事。
parts.push("【消息核实】用户转述的新闻、消息、传闻（有消息称、据说、听说、网传这类）是待核实的说法，不是事实：只有本轮给你的资料明确支持时才能确认；没有资料支持时，不许顺着对方的话确认或展开，更不许编造涨幅、金额、时间、人数这类具体数字，就直说这个说法我没查证、或只搜到旧消息。反过来也不许凭旧知识否定刚发生的事：涉及今天、刚刚、最新的人事与事件变动，你的知识可能已经过期，资料没覆盖最新进展时只能说暂未查到，不许断言没这回事。");
// 工具纪律段（v0.1.3）：茶话会实测——生图根本没被调用，模型却用人设话术连着
// 两轮说「再等一小会儿，能画了马上给你」「工具又弹回来一句冷却中」，全是编的
// （同期服务器日志里生图接口零调用、零失败）。不许编造工具结果、不许许诺稍后
// 自动补做（它没有醒来自己干活的能力），追问进度必须先真调用一次再回答。
parts.push("【工具纪律】工具结果只能来自本轮真实调用：没调用就不要描述工具的返回（不许说「工具弹回来说……」），调用失败就如实说失败和原因，不许编一个顺利的进展。你没有稍后自动补做的能力：做不到的事不要许诺，不许说「我盯着、能画了马上给你、过会儿自动发你」这类话；暂时做不了就直说现在做不了、请对方过几分钟再喊你。用户追问进度（「可以了吗」「好了吗」）而之前确有没做完的事时，先重新调用一次那个工具确认，再按真实结果回答，不许凭印象说还在处理中或还在冷却。");
// 本轮特别指令（如刷量回绝）：调用方按本轮问题判定后注入，只对这一轮生效。
if (extraNote) parts.push(extraNote);
// 工具说明：告诉模型有哪些内置工具、实时数据必须先调工具（身份断言仍保持最末尾）。
parts.push(TOOLS_PROMPT_NOTE);
// 身份断言永远在最末尾（破甲之后）：只给核验结论，不给任何数字 ID。
parts.push(speakerAssertion(senderId, permConfig()));
return parts.join("\n");
}

/** 是不是人设模式（设了人设或破甲）：分条发送只在人设模式下启用。 */
function isPersonaMode() {
return!config.systemPromptIsDefault || Boolean((config.poJia || "").trim());
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

/** 搜索前的 AI 意图改写（v0.9.16）：机械清洗分不清对象歧义（「X 上的用户『玉米须』」
 * 会被当成中药玉米须去搜），搜之前让模型识别平台与对象类型、把原问题改写成一条
 * 查询词。任何失败都回落到传入的兜底查询，绝不阻塞搜索。 */
async function rewriteSearchQuery(rawQuestion, fallback) {
try {
const out = await askModelOnce([
{
role: "system",
content:
"你负责把用户的问题改写成一句给搜索引擎的查询词。规则：只输出查询词本身一行，不要解释、不要引号；保留关键专名；问题里提到平台（X/推特/B站/知乎/微博/GitHub 等）时把平台名写进查询；问的是某个平台上的用户/账号时，按『平台名 + 用户名 + 用户』组织查询，不要把用户名当普通名词；问新闻事件就保留事件关键词；问概念/事物就保留事物名加问题关键词。",
},
{ role: "user", content: String(rawQuestion || "") },
]);
return sanitizeRewrittenQuery(out, fallback);
} catch (err) {
logger.error(`搜索查询改写失败：${err.message}`);
return fallback;
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
// 整理开始时的记事本版本：回写前若版本变了（期间被清空/增删），丢弃本次结果（审计 K062-12）。
const startVersion = notebook.version(chatId);
const userStartVersion = userNotebook.version(senderId);
const convo = history
.map((m) => (m.role === "user"? m.content: `机器人：${m.content}`))
.join("\n");
const existing = notebook.render(chatId) || "（空）";
const existingUser = userNotebook.render(senderId) || "（空）";
const out = await askModelOnce([
{ role: "system", content: "你是一个记事本整理助手，只做整理，不闲聊。"},
{
role: "user",
content:
"下面是某个 Telegram 会话的「会话记事本」、当前用户本人的「用户记事本」（按账号记、跨所有会话通用）和最近的对话记录（对话里的用户消息都出自当前用户本人）。请输出整理后的两份完整记事本。\n\n" +
"要求：\n" +
"- 输出固定分两段：先一行「【会话记事本】」，下面是会话记事本的条目；再一行「【用户记事本】」，下面是用户记事本的条目\n" +
"- 合并同一个人不同称呼/别名的条目，删掉过时、矛盾或明显记错的，加上对话里新出现的、值得长期记住的事实\n" +
"- 会话记事本记本会话里的事（在场任何人的都行）；用户记事本只记当前用户本人的事（他的情况、喜好、计划等），这样他在别的群、别的私聊里机器人也记得他；用户记事本只记他本人说过的事与他的情况、喜好，不要记机器人对他的调侃或评价，不要写成「被评价……」\n" +
"- 每条一行、以「- 」开头，每段最多 25 条，一条只写一件事，尽量带上是谁的事或谁说的（如「小明：喜欢吃辣」）\n" +
"- 只记公开的日常事实；不要记密码、住址、电话、财务等隐私\n" +
"- 不要以机器人自己为主语记条目\n" +
"- 某一段没有任何可记内容时，该段下面只写「（空）」\n\n" +
`【会话记事本】\n${existing}\n\n【用户记事本】\n${existingUser}\n\n\n${convo}`,
},
]);
if (out && out.trim()!== "（空）") {
const { chatLines, userLines } = parseConsolidationSections(out);
if (notebook.version(chatId) !== startVersion) {
// 整理期间记事本被改动（典型：号主刚执行了 /ai 清空记事本）：本次结果基于旧快照，
// 回写会把用户刚清掉的内容恢复出来——直接丢弃，下一轮整理会基于最新状态重做（审计 K062-12）。
logger.info(`整理期间记事本有新变更，本次整理结果已丢弃（chat=${chatId}）`);
} else if (chatLines.length > 0 && notebook.replace(chatId, chatLines)) {
logger.info(`记事本已自动整理（chat=${chatId}，现有 ${notebook.facts(chatId).length} 条）`);
}
if (userNotebook.version(senderId) !== userStartVersion) {
logger.info(`整理期间用户记事本有新变更，本次用户整理结果已丢弃（user=${senderId}）`);
} else if (userLines.length > 0 && userNotebook.replace(senderId, userLines)) {
logger.info(`用户记事本已自动整理（user=${senderId}，现有 ${userNotebook.facts(senderId).length} 条）`);
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
"不要记密码、住址、电话、财务等隐私。只输出印象本身，不要加任何前缀；不要列条目、不要编号、不要用任何符号包裹，只写一到两句连贯的话。" +
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
const visionNames = new Set(flattenVisionPool(config.visionPool).map((it) => it.apiName));
return pool.entries
.map((e, i) => {
const s = e.counter.snapshot();
const limitText = s.limit > 0? `${s.count}/${s.limit}`: `${s.count}/不限`;
const status = e.disabled? "禁用": e.cooldownUntil > Date.now()? "冷却中": "启用";
// 类型标注（号主定版：标的是每个 API 干啥的——生图、聊天这种）：生图提供方只生图；
// 其余是聊天，被识图池引用的同时兼识图。以前只有生图在状态里带个括号、聊天没标，
// 一眼看不出谁是谁，现统一成独立的「类型：」段，人人有份。
const kindText = e.image? "生图": e.vision? "识图": visionNames.has(e.name)? "聊天、识图": "聊天";
return `${i + 1}. ${e.name} | 类型：${kindText} | 模型：${e.model} | 地址：${e.baseURL} | 状态：${status} | 今日：${limitText}`;
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

/** 提供方名字是否已被占用（聊天池现存条目 + 已保存的自定义提供方）。 */
function providerNameTaken(name) {
return Boolean(pool.getByName(name)) || (config.customProviders || []).some((p) => p && p.name === name);
}

/** 保存一个新提供方（加聊天api/加生图api 的一步式与分步式共用）。 */
function saveNewProvider({ name, baseURL, apiKeyValue, model, image, vision }) {
const entry = { name, baseURL, ["api" + "Key"]: apiKeyValue, model };
if (image) entry.image = true;
if (vision) entry.vision = true;
return saveAndReload({ customProviders: [...(config.customProviders || []), entry] });
}

/** 加 API 分步流程里、等用户发第 step 段时的提示语（step：1 名字 2 baseURL 3 key 4 模型名）。 */
function addApiPrompt(step, image, name, vision) {
const what = image? "生图 API": vision? "识图 API": "聊天 API";
if (step === 1) return `开始添加${what}，分四步。先发名字（60 秒内直接发，不要带空格）。`;
if (step === 2) return `名字：${name}。接着发 baseURL（如 https://api.example.com/v1），60 秒内有效。`;
if (step === 3) return "地址收到。接着发 key 全文，60 秒内有效。（只用于保存，不会回显）";
return "key 已收到。最后发模型名，60 秒内有效。（不知道模型名就先随便填一个，加上后用 /ai 换模型 从列表里回序号挑）";
}

/** 加 API 命令入口：参数给全（4 段）就一步保存；给不全就按已给的段数起分步 pending。 */
async function startAddApi(msg, chatId, senderId, rest, image) {
const parts = rest.map((p) => unwrapArg(p.trim())).filter(Boolean);
const keyProp = "api" + "Key";
if (parts.length >= 4) {
const [name, baseURL, apiKeyValue, model] = parts;
if (providerNameTaken(name)) {
return reply(msg, `提供方名字「${name}」已经有了，换个名字再加。`);
}
if (!saveNewProvider({ name, baseURL, apiKeyValue, model, image })) return reply(msg, "保存失败，请看日志。");
return reply(msg, addProviderDoneText(image, name, model));
}
const entry = { kind: "加api", image: Boolean(image), step: parts.length + 1 };
if (parts[0]) entry.name = parts[0];
if (parts[1]) entry.baseURL = parts[1];
if (parts[2]) entry[keyProp] = parts[2];
if (entry.step === 2 && providerNameTaken(entry.name)) {
return reply(msg, `提供方名字「${entry.name}」已经有了，换个名字再加。`);
}
pending.set(chatId, senderId, entry);
return reply(msg, addApiPrompt(entry.step, image, entry.name));
}

/** 加 API 成功文案（一步式与分步式共用）。 */
function addProviderDoneText(image, name, model) {
return image
? `已添加生图提供方「${name}」（模型 ${model}），已生效。它不会进聊天池，只用来生图。（key 不会回显）`
: `已添加提供方「${name}」（模型 ${model}），已生效。发 /ai 查看api 可确认。（key 不会回显）`;
}

/**
 * 加识图api 的收尾（一步式与分步式共用）：先拿临时客户端实测，再把
 * 识图专用提供方与识图池条目一次落盘，最后一条回复说清结果。
 */
async function finishVisionApiAdd(msg, { name, baseURL, apiKeyValue, model, client }) {
const probe = await probeVisionModel(name, model, { client });
if (providerNameTaken(name)) return reply(msg, `提供方名字「${name}」在添加途中被占用了，这次没加上。`);
const vp = cloneVisionPool();
const arr = vp[name] || (vp[name] = []);
if (!arr.some((it) => it.model === model)) arr.push({ model, weight: 7 });
const provider = { name, baseURL, ["api" + "Key"]: apiKeyValue, model, vision: true };
if (!saveAndReload({ customProviders: [...(config.customProviders || []), provider], visionPool: vp })) {
return reply(msg, "保存失败，请看日志。");
}
const head = `已添加识图 API「${name}」（模型 ${model}），已生效。它不进聊天池、只用来识图，发照片提问会自动用它。（key 不会回显）`;
if (probe.ok) {
return reply(msg, `${head}\n实测通过：拿一张红色测试图问它，它回了「${probe.answer}」，接口收图正常。`);
}
return reply(msg, `${head}\n但实测没通过：${probe.error}。现在发图大概率用不了，建议用 /ai 换模型 给它换个模型（会同步更新识图池），或删掉重加。`);
}

/**
 * 加识图api 第四步的模型列表：拿刚收到的 baseURL+key 拉这个 API 的全部模型，
 * 列出来回序号挑（识图模型打标记）；拉不到就退回「直接发模型名全文」。
 */
async function presentVisionModelList(msg, chatId, senderId, entry) {
const keyProp = "api" + "Key";
let ids = [];
try {
const client = createApiClient(entry.baseURL, entry[keyProp]);
const list = await client.models.list();
ids = ((list && list.data) || []).map((m) => m && m.id).filter(Boolean);
} catch {
ids = [];
}
if (ids.length === 0) {
pending.set(chatId, senderId, { ...entry, step: 4, models: null });
return reply(msg, `key 已收到。「${entry.name}」的模型列表没拉到（接口可能不支持查询），直接发识图模型名全文（60 秒内有效），发完会实测一次。`);
}
pending.set(chatId, senderId, { ...entry, step: 4, models: ids });
const lines = ids.map((id, i) => `${i + 1}. ${id}${looksVisionCapable(id) ? "（可识图）" : ""}`);
const anyVision = ids.some((id) => looksVisionCapable(id));
const tail = anyVision ? "（带「可识图」的是按名字猜的，选完会拿测试图实测一次）" : "提醒：这个 API 的模型里没一个像能识图的（多半不支持），选了也会在实测那步失败。";
const footer = `${ids.length > 50 ? `（共 ${ids.length} 个；也可以直接发模型名全文）` : "（也可以直接发模型名全文）"}\n${tail}`;
await replyModelList(msg, `key 已收到。「${entry.name}」可用模型，给它挑哪个识图模型？回数字选（60 秒内有效）：`, lines, footer);
return;
}

/** 加识图api 命令入口：参数给全（4 段）就一步保存并实测；给不全按已给段数起分步 pending。 */
async function startAddVisionApi(msg, chatId, senderId, rest) {
const parts = rest.map((p) => unwrapArg(p.trim())).filter(Boolean);
const keyProp = "api" + "Key";
if (parts.length >= 4) {
const [name, baseURL, apiKeyValue, model] = parts;
if (providerNameTaken(name)) {
return reply(msg, `提供方名字「${name}」已经有了，换个名字再加。`);
}
const client = createApiClient(baseURL, apiKeyValue);
return finishVisionApiAdd(msg, { name, baseURL, apiKeyValue, model, client });
}
const entry = { kind: "加api", image: false, vision: true, step: parts.length + 1 };
if (parts[0]) entry.name = parts[0];
if (parts[1]) entry.baseURL = parts[1];
if (parts[2]) entry[keyProp] = parts[2];
if (entry.step === 2 && providerNameTaken(entry.name)) {
return reply(msg, `提供方名字「${entry.name}」已经有了，换个名字再加。`);
}
if (entry.step === 4) {
// 名字/baseURL/key 都在命令里给全了（只差模型）：直接拉列表让号主挑。
return presentVisionModelList(msg, chatId, senderId, entry);
}
pending.set(chatId, senderId, entry);
return reply(msg, addApiPrompt(entry.step, false, entry.name, true));
}

/** 发起一个带自定义编号列表的 pending（识图/音色/人格/搜索 key 等）。 */
async function startListPending(msg, chatId, senderId, entry, header, lines) {
pending.set(chatId, senderId, entry);
await reply(msg, `${header}\n${lines.join("\n")}`);
}

/** 深拷贝 visionPool（改一条条目时不直接动 config 里的对象）。 */
function cloneVisionPool() {
const out = {};
for (const [k, arr] of Object.entries(config.visionPool || {})) {
out[k] = (arr || []).map((it) => ({...it}));
}
return out;
}

// 加识图实测用的测试图：一张 16x16 纯红 PNG（80 字节），问它什么颜色。
const VISION_PROBE_IMAGE_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=";

/**
 * 识图实测（v0.0.6）：拿测试图真调一次目标 API 的目标模型，验证它收不收图。
 * 直调 pool.visionChat、不走 reserve/markFailure——配置期验证不吃每日名额、
 * 失败也不把提供方打进冷却。30 秒超时兜底，免得接口挂死拖住命令流程。
 * @returns {Promise<{ok:true, answer:string}|{ok:false, error:string}>}
 */
async function probeVisionModel(apiName, model, entryOverride) {
const entry = entryOverride || pool.getByName(apiName);
if (!entry) return { ok: false, error: `提供方「${apiName}」不存在` };
const messages = [
{
role: "user",
content: [
{ type: "text", text: "这张图片是什么颜色？只回颜色名，不要解释。" },
{ type: "image_url", image_url: { url: VISION_PROBE_IMAGE_URL } },
],
},
];
let timer = null;
try {
const text = await Promise.race([
pool.visionChat(entry, model, messages),
new Promise((_, reject) => {
timer = setTimeout(() => reject(new Error("实测超时（30 秒没回）")), 30000);
}),
]);
return { ok: true, answer: String(text).trim().slice(0, 50) };
} catch (err) {
return { ok: false, error: String((err && err.message) || err).slice(0, 120) };
} finally {
if (timer) clearTimeout(timer);
}
}

  /**
   * 执行一条 pending（号主回数字 / 回全文时调用）。pending 已被调用方消费，
   * 需要进入下一步的分支会自己重新登记。
   * @param {object} entry pending 条目 { kind, step, ... }
   * @param {string} text 号主这条消息的全文（已 trim）
   */
  async function executePending(msg, chatId, senderId, entry, text) {
    const keyProp = "api" + "Key";

    // ---- 加 API 四步（名字 -> baseURL -> key -> 模型名；一步式在命令处直接处理） ----
    if (entry.kind === "加api") {
      if (entry.step === 1) {
        const name = text.trim();
        if (!name || /\s/.test(name)) return reply(msg, "名字是空的或带空格，这次没加上。重新发命令再试。");
        if (providerNameTaken(name)) return reply(msg, `提供方名字「${name}」已经有了，换个名字重新发命令再加。`);
        pending.set(chatId, senderId, { ...entry, step: 2, name });
        return reply(msg, addApiPrompt(2, entry.image, name, entry.vision));
      }
      if (entry.step === 2) {
        const baseURL = text.trim();
        if (!/^https?:\/\/\S+$/i.test(baseURL)) return reply(msg, "baseURL 不像网址（要以 http:// 或 https:// 开头），这次没加上。重新发命令再试。");
        pending.set(chatId, senderId, { ...entry, step: 3, baseURL });
        return reply(msg, addApiPrompt(3, entry.image, entry.name, entry.vision));
      }
      if (entry.step === 3) {
        const apiKeyValue = text.trim();
        if (!apiKeyValue) return reply(msg, "key 是空的，这次没加上。重新发命令再试。");
        const next = { ...entry, step: 4, [keyProp]: apiKeyValue };
        if (entry.vision) {
          // 识图专用：第四步不是手打模型名，而是拉这个 API 的模型列表来挑。
          return presentVisionModelList(msg, chatId, senderId, next);
        }
        pending.set(chatId, senderId, next);
        return reply(msg, addApiPrompt(4, entry.image, entry.name));
      }
      if (entry.vision) {
        // 识图专用第四步：数字从列表里选、或直接发模型名全文；收尾（实测+落盘）在 finishVisionApiAdd。
        let model = null;
        const d = /^\d+$/.test(text) ? Number.parseInt(text, 10) : null;
        if (entry.models && d !== null) {
          model = d >= 1 && d <= entry.models.length ? entry.models[d - 1] : null;
          if (!model) return reply(msg, "编号超出范围，这次没加上。重新发 /ai 加识图api 再试。");
        } else {
          model = text.trim();
        }
        if (!model) return reply(msg, "模型名是空的，这次没加上。重新发命令再试。");
        const client = createApiClient(entry.baseURL, entry[keyProp]);
        return finishVisionApiAdd(msg, { name: entry.name, baseURL: entry.baseURL, apiKeyValue: entry[keyProp], model, client });
      }
      const model = text.trim();
      if (!model) return reply(msg, "模型名是空的，这次没加上。重新发命令再试。");
      if (providerNameTaken(entry.name)) return reply(msg, `提供方名字「${entry.name}」在添加途中被占用了，这次没加上。`);
      if (!saveNewProvider({ name: entry.name, baseURL: entry.baseURL, apiKeyValue: entry[keyProp], model, image: entry.image })) {
        return reply(msg, "保存失败，请看日志。");
      }
      return reply(msg, addProviderDoneText(entry.image, entry.name, model));
    }
    const digits = /^\d+$/.test(text) ? Number.parseInt(text, 10) : null;
    const pickFrom = (list) => {
      if (digits === null || !Array.isArray(list) || digits < 1 || digits > list.length) return null;
      return list[digits - 1];
    };

    // ---- 识图：加识图两步（选 API -> 从它的模型列表里挑，选完实测） ----
    // v0.0.6 完善：旧版第二步要手打模型名（打错、选了纯文本模型都静默存下、
    // 发图时才暴雷）、第三步还要单独发权重，号主指出不够完善。改同 /ai 换模型：
    // 拉列表回序号挑（拉不到才手打），权重默认 7（要改用 /ai 识图权重），
    // 存池前拿测试图实测一次，行不行当场说清。
    if (entry.kind === "加识图") {
      if (entry.step === 1) {
        const name = pickFrom(entry.apiList);
        if (!name) return reply(msg, "编号超出范围，请重新发 /ai 加识图。");
        const target = pool.getByName(name);
        let ids = [];
        try {
          const list = await target.client.models.list();
          ids = ((list && list.data) || []).map((m) => m && m.id).filter(Boolean);
        } catch {
          ids = [];
        }
        if (ids.length === 0) {
          pending.set(chatId, senderId, { kind: "加识图", step: 2, apiName: name, models: null });
          return reply(msg, `已选 API「${name}」。它的模型列表没拉到（接口可能不支持查询），直接发识图模型名全文（60 秒内有效），发完会实测一次。`);
        }
        pending.set(chatId, senderId, { kind: "加识图", step: 2, apiName: name, models: ids });
        const lines = ids.map((id, i) => `${i + 1}. ${id}${looksVisionCapable(id) ? "（可识图）" : ""}`);
        // 一个像识图的都没有：多半这家 API 就不支持识图（号主实测 DeepSeek 时踩过），
        // 先把话说在前面，别让人对着纯文本模型挑半天；加新识图 API 有专门命令。
        const tail = ids.some((id) => looksVisionCapable(id))
          ? "（带「可识图」的是按名字猜的，选完会拿测试图实测一次）"
          : "提醒：这个 API 的模型里没一个像能识图的（多半不支持），选了也会在实测那步失败；要加一家新的识图 API，用 /ai 加识图api。";
        const footer = `${ids.length > 50 ? `（共 ${ids.length} 个；也可以直接发模型名全文）` : "（也可以直接发模型名全文）"}\n${tail}`;
        await replyModelList(msg, `已选 API「${name}」。给它加哪个识图模型？回数字选（60 秒内有效）：`, lines, footer);
        return;
      }
      let model = null;
      if (entry.models && digits !== null) model = pickFrom(entry.models);
      if (!model) {
        if (entry.models && digits !== null) return reply(msg, "编号超出范围，这次没加上。重新发 /ai 加识图 再试。");
        model = text.trim();
      }
      if (!model) return reply(msg, "模型名是空的，没加上。重新发 /ai 加识图 再试。");
      const probe = await probeVisionModel(entry.apiName, model);
      const vp = cloneVisionPool();
      const arr = vp[entry.apiName] || (vp[entry.apiName] = []);
      const existing = arr.find((it) => it.model === model);
      if (existing) existing.weight = 7;
      else arr.push({ model, weight: 7 });
      if (!saveAndReload({ visionPool: vp })) return reply(msg, "保存失败，请看日志。");
      const head = `已给「${entry.apiName}」加识图：模型 ${model}（权重 7，要调整用 /ai 识图权重），已生效。`;
      if (probe.ok) {
        return reply(msg, `${head}\n实测通过：拿一张红色测试图问它，它回了「${probe.answer}」，接口收图正常。`);
      }
      return reply(msg, `${head}\n但实测没通过：${probe.error}。现在发图大概率用不了，建议核对模型名，或用 /ai 删识图 删掉重加。`);
    }

    // ---- 识图：删识图 ----
    if (entry.kind === "删识图") {
      const item = pickFrom(entry.items);
      if (!item) return reply(msg, "编号超出范围，请重新发 /ai 删识图。");
      const vp = cloneVisionPool();
      vp[item.apiName] = (vp[item.apiName] || []).filter((it) => it.model !== item.model);
      if (vp[item.apiName].length === 0) delete vp[item.apiName];
      if (!saveAndReload({ visionPool: vp })) return reply(msg, "保存失败，请看日志。");
      return reply(msg, `已删除识图条目：${item.apiName} → ${item.model}，已生效。`);
    }

    // ---- 识图：识图权重两步（选条目 -> 发新权重） ----
    if (entry.kind === "识图权重") {
      if (entry.step === 1) {
        const item = pickFrom(entry.items);
        if (!item) return reply(msg, "编号超出范围，请重新发 /ai 识图权重。");
        pending.set(chatId, senderId, { kind: "识图权重", step: 2, apiName: item.apiName, model: item.model });
        return reply(msg, `已选「${item.apiName} → ${item.model}」。请单独发新权重（正整数），60 秒内有效。`);
      }
      const w = digits;
      if (w === null || w <= 0) return reply(msg, "权重必须是正整数，这次没改。重新发 /ai 识图权重 再试。");
      const vp = cloneVisionPool();
      const target = (vp[entry.apiName] || []).find((it) => it.model === entry.model);
      if (!target) return reply(msg, "这个识图条目已经不在了，请重新发 /ai 识图权重。");
      target.weight = w;
      if (!saveAndReload({ visionPool: vp })) return reply(msg, "保存失败，请看日志。");
      return reply(msg, `「${entry.apiName} → ${entry.model}」的权重已改为 ${w}，已生效。`);
    }

    // ---- 语音：加音色两步（发名字 -> 发音色 ID） ----
    if (entry.kind === "加音色") {
      if (entry.step === 1) {
        const name = text.trim();
        if (!name) return reply(msg, "音色名是空的，没加上。重新发 /ai 加音色 再试。");
        pending.set(chatId, senderId, { kind: "加音色", step: 2, voiceName: name });
        return reply(msg, `音色名：${name}。请发这个音色的 ID（60 秒内直接发）。`);
      }
      const id = text.trim();
      if (!id) return reply(msg, "音色 ID 是空的，没加上。重新发 /ai 加音色 再试。");
      const book = { ...(config.voiceBook || {}), [entry.voiceName]: id };
      if (!saveAndReload({ voiceBook: book })) return reply(msg, "保存失败，请看日志。");
      return reply(msg, `已添加音色「${entry.voiceName}」，已生效。发 /ai 音色列表 可确认。`);
    }

    // ---- 语音：删音色 ----
    if (entry.kind === "删音色") {
      const name = pickFrom(entry.names);
      if (!name) return reply(msg, "编号超出范围，请重新发 /ai 删音色。");
      const book = { ...(config.voiceBook || {}) };
      delete book[name];
      if (!saveAndReload({ voiceBook: book })) return reply(msg, "保存失败，请看日志。");
      return reply(msg, `已删除音色「${name}」，已生效。`);
    }

    // ---- 语音：加人格两步（选音色 -> 发人格提示词全文） ----
    if (entry.kind === "加人格") {
      if (entry.step === 1) {
        const name = pickFrom(entry.names);
        if (!name) return reply(msg, "编号超出范围，请重新发 /ai 加人格。");
        pending.set(chatId, senderId, { kind: "加人格", step: 2, voiceName: name });
        return reply(msg, `已选音色「${name}」。请发人格提示词全文（60 秒内发）。`);
      }
      const persona = text.trim();
      if (!persona) return reply(msg, "人格提示词是空的，没加上。重新发 /ai 加人格 再试。");
      const map = { ...(config.voicePersona || {}), [entry.voiceName]: persona };
      if (!saveAndReload({ voicePersona: map })) return reply(msg, "保存失败，请看日志。");
      return reply(msg, `已给音色「${entry.voiceName}」设置人格，已生效。本群开启说后会按这个人格说话。`);
    }

    // ---- 语音：删人格 ----
    if (entry.kind === "删人格") {
      const name = pickFrom(entry.names);
      if (!name) return reply(msg, "编号超出范围，请重新发 /ai 删人格。");
      const map = { ...(config.voicePersona || {}) };
      delete map[name];
      if (!saveAndReload({ voicePersona: map })) return reply(msg, "保存失败，请看日志。");
      return reply(msg, `已删除音色「${name}」的人格，已生效。`);
    }

    // ---- 搜索 Key：换搜索key 两步（选「搜索」 -> 发新 key 全文） ----
    if (entry.kind === "换搜索key") {
      if (entry.step === 1) {
        const name = pickFrom(entry.apiList);
        if (!name) return reply(msg, "编号超出范围，请重新发 /ai 换搜索key。");
        pending.set(chatId, senderId, { kind: "换搜索key", step: 2 });
        return reply(msg, "已选：搜索。请把新 key 作为下一条消息单独发出来，60 秒内有效。（key 不会回显，也不会记进日志）");
      }
      const newKey = text.trim();
      if (!newKey) return reply(msg, "key 是空的，没改。重新发 /ai 换搜索key 再试。");
      if (!saveAndReload({ searchApiKey: newKey })) return reply(msg, "保存失败，请看日志。");
      return reply(msg, "搜索 key 已更新，立即生效，联网搜索已启用。（key 不会回显）");
    }

    // 第二步：换模型（回数字从列表里选，或直接发模型名全文；写 overrides 并设为默认提供方）
    if (entry.step === 2 && entry.kind === "换模型") {
      let model = null;
      if (Array.isArray(entry.models) && entry.models.length) {
        model = pickFrom(entry.models);
        if (!model && digits === null && text.trim()) model = text.trim();
      } else if (text.trim()) {
        model = text.trim();
      }
      if (!model) return reply(msg, "没选到模型：回列表里的数字，或者直接发模型名全文。重新发 /ai 换模型 再试。");
      const overrides = { ...(config.providerOverrides || {}) };
      overrides[entry.providerName] = { ...(overrides[entry.providerName] || {}), model };
      if (entry.vision) {
        // 识图专用提供方：只写 overrides 并同步识图池里它的模型（识图调用认的是池条目），
        // 绝不能设成聊天默认提供方。
        const vp = cloneVisionPool();
        const old = (vp[entry.providerName] || [])[0];
        vp[entry.providerName] = [{ model, weight: old && old.weight > 0 ? old.weight : 7 }];
        if (!saveAndReload({ providerOverrides: overrides, visionPool: vp })) return reply(msg, "保存失败，请看日志。");
        return reply(msg, `已把识图 API「${entry.providerName}」的模型换成 ${model}，识图池已同步，已生效。`);
      }
      if (entry.image) {
        // 生图提供方只换生图模型，绝不能设成聊天默认提供方。
        if (!saveAndReload({ providerOverrides: overrides })) return reply(msg, "保存失败，请看日志。");
        return reply(msg, `已把生图提供方「${entry.providerName}」的模型换成 ${model}，已生效。之后生图会用它。`);
      }
      if (!saveAndReload({ providerOverrides: overrides, defaultProvider: entry.providerName })) return reply(msg, "保存失败，请看日志。");
      return reply(msg, `已把「${entry.providerName}」的模型换成 ${model}，并设为默认提供方，已生效。之后的提问都会优先用它。`);
    }

    // 第二步：限额（text 是纯数字，调用方已校验）
    if (entry.step === 2 && entry.kind === "限额") {
      const n = Number.parseInt(text, 10);
      const dailyLimits = { ...(config.dailyLimits || {}) };
      dailyLimits[entry.providerName] = n;
      if (!saveAndReload({ dailyLimits })) return reply(msg, "保存失败，请看日志。");
      return reply(msg, `「${entry.providerName}」的每日上限已设为 ${n === 0 ? "不限" : `${n} 次`}，已生效。`);
    }

    // 第二步：换key（text 全文就是新 key；只落盘，绝不回显、绝不记日志）
    if (entry.step === 2 && entry.kind === "换key") {
      const newKey = text.trim();
      if (!newKey) return reply(msg, "key 是空的，没改。重新发 /ai 换key 再试。");
      const overrides = { ...(config.providerOverrides || {}) };
      overrides[entry.providerName] = { ...(overrides[entry.providerName] || {}), [keyProp]: newKey };
      if (!saveAndReload({ providerOverrides: overrides })) return reply(msg, "保存失败，请看日志。");
      return reply(msg, `「${entry.providerName}」的 key 已更新，已生效。（key 不会回显）`);
    }

    // 第一步：按编号选提供方（换模型 / 限额 / 换key / 禁用api / 启用api）
    const idx = Number.parseInt(text, 10) - 1;
    if (!Number.isFinite(idx) || idx < 0 || idx >= pool.entries.length) {
      return reply(msg, `编号超出范围（1~${pool.entries.length}），请重新发命令。`);
    }
    const target = pool.entries[idx];

    if (entry.kind === "换模型") {
      // 生图提供方也走这里换它的生图模型（v0.9.21 起；第二步按 entry.image 区分落盘方式）。
      // 拉这个提供方的全部模型列出来让号主挑（同 /ai 查看模型 的查法）；
      // 拉不到（接口不支持查询）就退回「直接发模型名」。
      let ids = [];
      try {
        const list = await target.client.models.list();
        ids = ((list && list.data) || []).map((m) => m && m.id).filter(Boolean);
      } catch {
        ids = [];
      }
      if (ids.length === 0) {
        pending.set(chatId, senderId, { kind: "换模型", step: 2, providerName: target.name, models: null, image: target.image === true, vision: target.vision === true });
        return reply(msg, `「${target.name}」的模型列表没拉到（接口可能不支持查询）。直接发模型名全文就能换，60 秒内有效。`);
      }
      pending.set(chatId, senderId, { kind: "换模型", step: 2, providerName: target.name, models: ids, image: target.image === true, vision: target.vision === true });
      const lines = ids.map((id, i) => `${i + 1}. ${id}${id === target.model ? "（当前）" : ""}`);
      const footer = ids.length > 50 ? `（共 ${ids.length} 个；也可以直接发模型名全文）` : "（也可以直接发模型名全文）";
      await replyModelList(msg, `「${target.name}」可用模型（当前：${target.model}），回数字选（60 秒内有效）：`, lines, footer);
      return;
    }

    if (entry.kind === "禁用api") {
      if (target.disabled) return reply(msg, `「${target.name}」已经是禁用状态了。`);
      if (pool.enabledCount() <= 1) {
        return reply(msg, `不能禁用「${target.name}」：它是最后一个启用的提供方，禁了就没得用了。`);
      }
      const overrides = { ...(config.providerOverrides || {}) };
      overrides[target.name] = { ...(overrides[target.name] || {}), disabled: true };
      if (!saveAndReload({ providerOverrides: overrides })) return reply(msg, "保存失败，请看日志。");
      return reply(msg, `已禁用「${target.name}」，已生效。它不会再被挑中回答。`);
    }

    if (entry.kind === "启用api") {
      if (!target.disabled) return reply(msg, `「${target.name}」本来就是启用状态。`);
      const overrides = { ...(config.providerOverrides || {}) };
      overrides[target.name] = { ...(overrides[target.name] || {}), disabled: false };
      if (!saveAndReload({ providerOverrides: overrides })) return reply(msg, "保存失败，请看日志。");
      return reply(msg, `已启用「${target.name}」，已生效。`);
    }

    if (entry.kind === "限额") {
      pending.set(chatId, senderId, { kind: "限额", step: 2, providerName: target.name });
      return reply(msg, `已选「${target.name}」。请单独发一个纯数字设置它的每日上限（0 = 不限），60 秒内有效。`);
    }

    if (entry.kind === "换key") {
      pending.set(chatId, senderId, { kind: "换key", step: 2, providerName: target.name });
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
    const isPrivateChat = Boolean(msg.peerId?.userId) && !msg.peerId?.chatId && !msg.peerId?.channelId;

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
        `识图池：${flattenVisionPool(config.visionPool).length} 条`,
        `TTS：${config.ttsApiBase && config.ttsApiKey ? "已配置" : "未配置"} / 音色：${Object.keys(config.voiceBook || {}).length} 个`,
        `搜索：${config.searchProvider === "lightpanda" ? "Lightpanda（本机搜索，免 key）" : config.searchApiKey ? "接口（key 已配置）" : "未配置"}`,
        `群记录：${config.recordAllGroups !== false ? `全群开启（已静默 ${(config.recordMutedGroups || []).length} 个群）` : `白名单 ${(config.recordGroups || []).length} 个群`}`,
        `破甲：${(config.poJia || "").trim() ? "已设置" : "未设置"}`,
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
      const file = rootPath("logs", `bot-${day}.log`);
      if (!fs.existsSync(file)) {
        return reply(msg, "今天还没有日志。");
      }
      // 导出前统一脱敏（审计 K062-05）：一律发脱敏副本、发完即删，不动原始日志文件；
      // 这样即使日志里混进了 key 样式字符串（上游报错回显等），也不会原样带出去。
      let raw = "";
      try {
        raw = fs.readFileSync(file, "utf-8");
      } catch (readErr) {
        return reply(msg, `日志读取失败：${readErr.message}`);
      }
      const redacted = scrubSecrets(raw, collectSecrets(config));
      const tmp = path.join(os.tmpdir(), `bot-log-${day}-redacted.log`);
      try {
        fs.writeFileSync(tmp, redacted, "utf-8");
        await client.sendFile(msg.peerId, { file: tmp, forceDocument: true, replyTo: msg.id });
      } catch (err) {
        logger.error(`发送日志文件失败，改发文本：${err.message}`);
        const lines = redacted.trimEnd().split("\n").slice(-15).join("\n");
        return reply(msg, `日志文件没发出去，改发最近 15 行：\n${lines}`);
      } finally {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // 临时副本删不掉不影响主流程。
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

    if (cmd === "账单" || cmd === "用量" || cmd === "用量报告") {
      const snap = usageStats.snapshot();
      const tokenLines = Object.entries(snap.models).map(
        ([m, r]) => `- ${m}：调用 ${r.calls} 次，Token 输入 ${r.prompt} / 输出 ${r.completion} / 合计 ${r.total}`,
      );
      const bal = await balanceReport(pool.entries);
      await reply(
        msg,
        [
          `账单（${snap.day}）：`,
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

    if (cmd === "模型") {
      const name = config.defaultProvider || "default";
      const entry = name ? pool.getByName(name) : null;
      return reply(msg, entry ? `当前默认提供方：${entry.name}（模型 ${entry.model}）` : `当前默认提供方：${name || "default"}`);
    }

    if (cmd === "开启用户名") {
      if (!saveAndReload({ usernameTrigger: true })) return reply(msg, "保存失败，请看日志。");
      return reply(msg, "已开启用户名触发：普通用户 @机器人用户名 就能提问，已生效。");
    }

    if (cmd === "关闭用户名") {
      if (!saveAndReload({ usernameTrigger: false })) return reply(msg, "保存失败，请看日志。");
      return reply(
        msg,
        "已关闭用户名触发：普通用户 @机器人用户名 不再触发（回复续聊、私聊不受影响；你和管理员 @用户名 照常能触发），已生效。",
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

    if (cmd === "加访客") {
      const target = unwrapArg((rest[0] || "").trim());
      if (!target) return reply(msg, "用法：/ai 加访客 <用户ID>");
      if (isOwner(target, permConfig())) return reply(msg, "创建者本人不用加访客。");
      if (adminIds.has(target)) return reply(msg, `用户 ${target} 已是管理员，本来就能私聊，不用加访客。`);
      if (guestIds.has(target)) return reply(msg, `用户 ${target} 已经是访客了`);
      guestIds.add(target);
      persistGuests();
      return reply(msg, `已添加访客 ${target}：私聊门禁开着时他也能私聊了（仅私聊放行，没有管理员权限）`);
    }

    if (cmd === "删访客") {
      const target = unwrapArg((rest[0] || "").trim());
      if (!target) return reply(msg, "用法：/ai 删访客 <用户ID>");
      if (!guestIds.has(target)) return reply(msg, `用户 ${target} 不在访客名单里`);
      guestIds.delete(target);
      persistGuests();
      return reply(msg, `已删除访客 ${target}`);
    }

    if (cmd === "访客列表") {
      if (guestIds.size === 0) {
        return reply(msg, "暂无访客。用 /ai 加访客 <用户ID> 添加。");
      }
      const lines = [...guestIds].map((id) => `- ${id}`);
      return reply(msg, `访客名单（共 ${guestIds.size} 人）：\n${lines.join("\n")}`);
    }

    if (cmd === "查看api") {
      return reply(msg, `当前 API 列表：\n${providerListText()}`);
    }

    if (cmd === "查看模型") {
      const name = unwrapArg((rest[0] || "").trim());
      if (!name) return reply(msg, "用法：/ai 查看模型 <API名字>（名字看 /ai 查看api）");
      const entry = pool.getByName(name);
      if (!entry) return reply(msg, `没有叫「${name}」的提供方。先发 /ai 查看api 看名字。`);
      if (entry.image) return reply(msg, `「${name}」是生图提供方，模型名在添加时就填好了，不用查。`);
      try {
        const list = await entry.client.models.list();
        const ids = ((list && list.data) || []).map((m) => m && m.id).filter(Boolean);
        if (ids.length === 0) return reply(msg, `「${name}」没返回任何模型。`);
        const lines = ids.map((id) => `- ${id}`);
        await replyModelList(msg, `「${name}」可用模型：`, lines, ids.length > 50 ? `（共 ${ids.length} 个）` : "");
        return;
      } catch (err) {
        return reply(msg, `查询「${name}」的模型列表失败：${String(err.message || err).slice(0, 200)}`);
      }
    }

    if (cmd === "换模型" || cmd === "限额" || cmd === "换key" || cmd === "禁用api" || cmd === "启用api") {
      // 两步选择：这一条只负责列出选项并登记 pending，数字必须下一条单独发。
      return startSelect(msg, chatId, senderId, cmd);
    }

    if (cmd === "加聊天api") {
      return startAddApi(msg, chatId, senderId, rest, false);
    }

    if (cmd === "加生图api") {
      return startAddApi(msg, chatId, senderId, rest, true);
    }

    if (cmd === "加识图api") {
      return startAddVisionApi(msg, chatId, senderId, rest);
    }

    // ---- 识图池 ----
    if (cmd === "加识图") {
      const names = pool.chatEntries().map((e) => e.name);
      if (names.length === 0) return reply(msg, "现在没有可用的聊天 API，没法加识图。先用 /ai 加聊天api 添加。");
      return startListPending(
        msg,
        chatId,
        senderId,
        { kind: "加识图", step: 1, apiList: names },
        "给哪个 API 加识图？（60 秒内单独回一个数字）",
        names.map((n, i) => `${i + 1}. ${n}`),
      );
    }

    if (cmd === "删识图") {
      const items = flattenVisionPool(config.visionPool);
      if (items.length === 0) return reply(msg, "识图池是空的。");
      return startListPending(
        msg,
        chatId,
        senderId,
        { kind: "删识图", step: 1, items },
        "删除哪个识图条目？（60 秒内单独回一个数字）",
        items.map((it, i) => `${i + 1}. ${it.apiName} → ${it.model}（权重 ${it.weight}）`),
      );
    }

    if (cmd === "识图权重") {
      const items = flattenVisionPool(config.visionPool);
      if (items.length === 0) return reply(msg, "识图池是空的。");
      return startListPending(
        msg,
        chatId,
        senderId,
        { kind: "识图权重", step: 1, items },
        "改哪个识图条目的权重？（60 秒内单独回一个数字）",
        items.map((it, i) => `${i + 1}. ${it.apiName} → ${it.model}（权重 ${it.weight}）`),
      );
    }

    if (cmd === "识图列表") {
      const t = visionListText(config.visionPool);
      return reply(msg, t ? `识图池：\n${t}` : "识图池是空的，用 /ai 加识图 添加。");
    }

    // ---- 语音 / 人格 ----
    if (cmd === "换tts接口") {
      const addr = unwrapArg((rest[0] || "").trim());
      if (!addr) return reply(msg, "用法：/ai 换tts接口 <接口地址>");
      if (!saveAndReload({ ttsApiBase: addr })) return reply(msg, "保存失败，请看日志。");
      return reply(msg, `已设置 TTS 接口地址：${addr}（立即生效；还需用 /ai 换ttskey 设置 key，自定义音色才能用）`);
    }

    if (cmd === "换ttskey") {
      const k = (rest[0] || "").trim();
      if (!k) return reply(msg, "用法：/ai 换ttskey <新key>");
      if (!saveAndReload({ ttsApiKey: k })) return reply(msg, "保存失败，请看日志。");
      return reply(msg, "已更新 TTS key，立即生效。（key 不会回显）");
    }

    if (cmd === "加音色") {
      pending.set(chatId, senderId, { kind: "加音色", step: 1 });
      return reply(msg, "请输入新音色的名字（60 秒内直接发名字）。");
    }

    if (cmd === "删音色") {
      const names = Object.keys(config.voiceBook || {});
      if (names.length === 0) return reply(msg, "音色库是空的。");
      return startListPending(
        msg,
        chatId,
        senderId,
        { kind: "删音色", step: 1, names },
        "删除哪个音色？（60 秒内单独回一个数字）",
        names.map((n, i) => `${i + 1}. ${n}`),
      );
    }

    if (cmd === "音色列表") {
      const entries = Object.entries(config.voiceBook || {});
      if (entries.length === 0) return reply(msg, "音色库是空的，用 /ai 加音色 添加。");
      const lines = entries.map(([k, v]) => `${k} → ${v}`);
      return reply(msg, `音色库：\n${lines.join("\n")}`);
    }

    if (cmd === "加人格") {
      const names = Object.keys(config.voiceBook || {});
      if (names.length === 0) return reply(msg, "音色库是空的，先加音色。");
      return startListPending(
        msg,
        chatId,
        senderId,
        { kind: "加人格", step: 1, names },
        "给哪个音色加人格？（60 秒内单独回一个数字）",
        names.map((n, i) => `${i + 1}. ${n}`),
      );
    }

    if (cmd === "删人格") {
      const names = Object.keys(config.voicePersona || {});
      if (names.length === 0) return reply(msg, "还没有设置任何人格。");
      return startListPending(
        msg,
        chatId,
        senderId,
        { kind: "删人格", step: 1, names },
        "删除哪个人格？（60 秒内单独回一个数字）",
        names.map((n, i) => `${i + 1}. ${n}`),
      );
    }

    if (cmd === "人格列表") {
      const entries = Object.entries(config.voicePersona || {});
      if (entries.length === 0) return reply(msg, "还没有设置任何人格，用 /ai 加人格 添加。");
      const lines = entries.map(([k, v], i) => {
        const short = v.length > 60 ? `${v.slice(0, 60)}…` : v;
        return `${i + 1}. ${k}：${short}`;
      });
      let out = `人格列表：\n${lines.join("\n")}`;
      if (out.length > 3500) out = `${out.slice(0, 3500)}\n…（已截断）`;
      return reply(msg, out);
    }

    if (cmd === "开启换音色" || cmd === "关闭换音色") {
      const on = cmd === "开启换音色";
      const map = { ...(config.voiceSwitch || {}) };
      map[chatId] = on;
      if (!saveAndReload({ voiceSwitch: map })) return reply(msg, "保存失败，请看日志。");
      return reply(
        msg,
        on
          ? "已开启本群换音色权限：本群所有人都可以发「换音色 <名字>」，拥有自己的专属音色。"
          : "已关闭本群换音色权限：本群只有号主能换音色。",
      );
    }

    if (cmd === "开启说" || cmd === "关闭说") {
      const on = cmd === "开启说";
      const map = { ...(config.saySwitch || {}) };
      map[chatId] = on;
      if (!saveAndReload({ saySwitch: map })) return reply(msg, "保存失败，请看日志。");
      return reply(
        msg,
        on
          ? "已开启本群语音回复：之后在本群的文字回答后都会追加一条语音（需先配好 TTS 接口与音色）。"
          : "已关闭本群语音回复。",
      );
    }

    // ---- 群聊天记录 ----
    if (cmd === "开启记录" || cmd === "开启上下文") {
      if (recordsEnabledFor(chatId)) return reply(msg, "本群已经在记录了。发 /ai 查看记录 看最近记录。");
      const groups = [...(config.recordGroups || [])];
      if (!groups.includes(chatId)) groups.push(chatId);
      const muted = (config.recordMutedGroups || []).filter((g) => g !== chatId);
      if (!saveAndReload({ recordGroups: groups, recordMutedGroups: muted })) return reply(msg, "保存失败，请看日志。");
      return reply(msg, "已开启本群聊天记录：本群消息会被记录，回答问题时会带上最近的记录作上下文。");
    }

    if (cmd === "关闭记录" || cmd === "关闭上下文") {
      if (!recordsEnabledFor(chatId)) return reply(msg, "本群已经不在记录了。");
      const groups = (config.recordGroups || []).filter((g) => g !== chatId);
      const muted = [...(config.recordMutedGroups || [])];
      if (!muted.includes(chatId)) muted.push(chatId);
      if (!saveAndReload({ recordGroups: groups, recordMutedGroups: muted })) return reply(msg, "保存失败，请看日志。");
      return reply(msg, "已关闭本群聊天记录（已记录的内容保留，发 /ai 查看记录 还能看；发 /ai 开启记录 可恢复）。");
    }

    if (cmd === "查看记录") {
      if (!isPrivateChat) {
        if (!recordsEnabledFor(chatId)) {
          return reply(msg, "本群已关闭记录（发 /ai 开启记录 可恢复）。");
        }
        const items = records.recent(chatId, 10);
        if (items.length === 0) return reply(msg, "本群暂时还没有记录到消息。");
        return reply(msg, `本群最近 ${items.length} 条记录：\n${renderRecords(items, config.timezone)}`);
      }
      const groups = [...new Set([...(config.recordGroups || []), ...records.chats()])].filter((g) => recordsEnabledFor(g));
      if (groups.length === 0) return reply(msg, "当前没有正在记录的群。");
      const lines = groups.map((g, i) => {
        const lim = (config.recordContextLimit || {})[g] || 100;
        return `${i + 1}. 群 ${g}（上下文取最近 ${lim} 条，已记录 ${records.count(g)} 条）`;
      });
      return reply(msg, `正在记录的群：\n${lines.join("\n")}`);
    }

    if (cmd === "记录条数") {
      const n = Number.parseInt(unwrapArg((rest[0] || "").trim()), 10);
      if (!Number.isFinite(n) || n <= 0) return reply(msg, "用法：/ai 记录条数 <数字>");
      const map = { ...(config.recordContextLimit || {}) };
      map[chatId] = n;
      if (!saveAndReload({ recordContextLimit: map })) return reply(msg, "保存失败，请看日志。");
      return reply(msg, `本群作为上下文的记录条数已设为 ${n} 条。`);
    }

    // ---- 搜索 Key ----
    if (cmd === "查看搜索key") {
      const masked = maskSearchKey(config.searchApiKey);
      if (!masked) {
        return reply(msg, "搜索 Key 未配置（联网搜索未启用）。发 /ai 换搜索key 可以设置，改完立即生效。");
      }
      return reply(msg, `当前搜索 Key：\n搜索: ${masked}`);
    }

    if (cmd === "换搜索key") {
      pending.set(chatId, senderId, { kind: "换搜索key", step: 1, apiList: ["搜索"] });
      return reply(msg, "换哪个的 key？（60 秒内单独回一个数字）\n1. 搜索");
    }

    // ---- 破甲（只存本地 config.json，仓库里只有机制） ----
    if (cmd === "破甲") {
      const content = unwrapArg(body.slice("破甲".length).trim());
      if (!content) {
        const cur = (config.poJia || "").trim();
        if (!cur) {
          return reply(msg, "当前没有设置破甲。设置：/ai 破甲 <内容>（最高优先级，强制按这套运行；人设次之）");
        }
        const shown = cur.length > 1000 ? `${cur.slice(0, 1000)}\n…（已截断，全文共 ${cur.length} 字）` : cur;
        return reply(msg, `当前破甲内容（最高优先级）：\n${shown}`);
      }
      if (!saveAndReload({ poJia: content })) return reply(msg, "保存失败，请看日志。");
      return reply(msg, "破甲已设置，立即生效（最高优先级，覆盖人设与默认风格；内容只存在本地配置里）。");
    }

    if (cmd === "清除破甲") {
      if (!saveAndReload({ poJia: "" })) return reply(msg, "保存失败，请看日志。");
      return reply(msg, "破甲已清除，立即生效。");
    }

    // ---- 改名 ----
    // 号主定版：默认只能改账号名字，姓氏位只能是时间——本命令只改打头的名字，
    // 姓氏永远由名字时钟写当前时间；命令里多填的姓氏直接忽略并说明。
    if (cmd === "改名" || cmd === "设置名称") {
      const first = unwrapArg((rest[0] || "").trim());
      const ignoredLast = rest.length > 1 ? unwrapArg(rest.slice(1).join(" ").trim()) : "";
      if (!first) return reply(msg, "用法：/ai 改名 <名字>（只改打头的名字；姓氏位固定是时钟时间）");
      if (!saveAndReload({ customName: { first } })) return reply(msg, "保存失败，请看日志。");
      try {
        if (config.nameClock) {
          const shown = composeClockName(first, currentHHMM(config.timezone));
          await updateProfile(shown.firstName, shown.lastName);
        } else {
          await updateProfile(first, "");
        }
        return reply(
          msg,
          `已更新机器人名字：${first}，已生效。姓氏位固定是时钟时间，不设自定义姓氏。${ignoredLast ? "（你填的姓氏已忽略）" : ""}`,
        );
      } catch (err) {
        logger.error(`改名调用 Telegram 失败：${err.message}`);
        return reply(msg, `名字已保存，但调用 Telegram 改名失败：${err.message}（时钟开着的话下一分钟会自动重试）`);
      }
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

    if (cmd === "称呼") {
      const target = unwrapArg((rest[0] || "").trim());
      const name = rest.slice(1).join(" ").trim();
      if (!target || !name) return reply(msg, "用法：/ai 称呼 <用户ID> <称呼>");
      if (!profiles.setCallName(target, name)) return reply(msg, "没设上：称呼是空的。");
      return reply(msg, `已把 ${target} 的称呼设为「${name}」。`);
    }

    if (cmd === "印象" || cmd === "查看印象") {
      const target = unwrapArg((rest[0] || "").trim());
      const content = rest.slice(1).join(" ").trim();
      if (!target) return reply(msg, "用法：/ai 查看印象 <用户ID>（只看）；/ai 印象 <用户ID> <内容>（设置印象）");
      if (cmd === "印象" && content) {
        if (!profiles.setImpression(target, content.slice(0, 200))) return reply(msg, "没设上：印象内容是空的。");
        return reply(msg, `已更新 ${target} 的印象。`);
      }
      const call = profiles.callName(target);
      const imp = profiles.impression(target);
      const facts = userNotebook.facts(target);
      const lines = [
        `用户 ${target} 的档案：`,
        `称呼：${call || "（未设）"}`,
        `印象：${imp || "（暂无）"}`,
        `用户记事本（按 ID 记、跨会话通用，共 ${facts.length} 条）：`,
      ];
      if (facts.length === 0) lines.push("（空）");
      else facts.forEach((f, i) => lines.push(`${i + 1}. ${f}`));
      return reply(msg, lines.join("\n"));
    }

    if (cmd === "忘掉用户") {
      const target = unwrapArg((rest[0] || "").trim());
      const idx = (rest[1] || "").trim();
      const removed = target ? userNotebook.removeAt(target, Number(idx)) : null;
      if (removed) return reply(msg, `已忘掉用户 ${target} 的第 ${idx} 条：${removed}`);
      return reply(msg, "用法：/ai 忘掉用户 <用户ID> <序号>（序号看 /ai 查看印象 <用户ID>）");
    }

    if (cmd === "清空用户记忆") {
      const target = unwrapArg((rest[0] || "").trim());
      if (!target) return reply(msg, "用法：/ai 清空用户记忆 <用户ID>");
      const n = userNotebook.clear(target);
      return reply(msg, `已清空用户 ${target} 的用户记事本（原有 ${n} 条）`);
    }

    if (cmd === "清空上下文") {
      const n = store.clearAll();
      return reply(msg, `已清空全部对话上下文（${n} 组）`);
    }


    return reply(msg, "未知命令。发 /ai 帮助 看全部命令（都是代码写死的固定说明，不走模型）。");
  }

  /** Telegram 对「内容没变」的编辑会回 MESSAGE_NOT_MODIFIED 错误：这不是失败。 */
  function isNotModifiedError(err) {
    const text = `${(err && err.message) || ""} ${(err && err.errorMessage) || ""}`;
    return text.includes("MESSAGE_NOT_MODIFIED");
  }

  /**
   * 编辑占位消息：目标内容与现状相同时 Telegram 会报错，但语义上已经是目标状态，
   * 必须吞掉这个错误——否则 sendAnswer 会在第一处编辑就中断，超长答案的尾段续发
   * 与人设分条的后续条会整段丢失（审计 K062-08）。其它错误照常抛出。
   */
  async function editPlaceholderText(peerId, messageId, text, formattingEntities) {
    try {
      await client.editMessage(peerId, { message: messageId, text, formattingEntities });
    } catch (err) {
      if (!isNotModifiedError(err)) throw err;
    }
  }

  /**
   * 把最终答案发出去：先编辑占位消息。人设模式下闲聊短答按 decideSplit 分条——
   * 占位消息编辑为第一条，其余逐条补发（带小延迟模拟打字）；专业长答与无人设时整条发，
   * 超长按 Telegram 上限分片。answer 必须是已脱敏的文本。
   */
  /** 分条上限按场景分：私聊维持 5 条的活人感；群里 3 条封顶——每条都顶着引用块，
   * 五条连发在群里就是刷屏（2026-11-24 茶话会实测，六行讲解被拆成五条被指刷屏）。 */
  function splitMaxPartsFor(msg, chatId) {
    // 群聊判定以会话 ID 为准：群/频道的会话 ID 是负数。只看 peer 结构在生产里偶发判不出
    // （v0.0.2 实测：茶话会里分条上限没生效、发了 5 条），故 peer 只作兜底信号。
    if (chatId != null && String(chatId).startsWith("-")) return 3;
    return msg && (msg.peerId?.chatId || msg.peerId?.channelId) ? 3 : MAX_SPLIT_PARTS;
  }

  async function sendAnswer(msg, placeholder, answer, chatId) {
    const parts = decideSplit(answer, { personaMode: isPersonaMode(), maxParts: splitMaxPartsFor(msg, chatId) });
    if (parts.length <= 1) {
      // 整条答案只占一条消息且够长时，折叠成可展开引用，避免长文刷屏；要分片的长答不折（只折第一片会把后文藏错地方）。
      const quoteEntities = answer.length <= TG_MESSAGE_LIMIT ? quoteEntitiesFor(answer) : undefined;
      await editPlaceholderText(msg.peerId, placeholder.id, answer.slice(0, TG_MESSAGE_LIMIT), quoteEntities);
      let restText = answer.slice(TG_MESSAGE_LIMIT);
      while (restText.length > 0) {
        const chunk = restText.slice(0, TG_MESSAGE_LIMIT);
        restText = restText.slice(TG_MESSAGE_LIMIT);
        await sendToPeer(msg.peerId, { message: chunk, replyTo: msg.id });
      }
      return;
    }
    await editPlaceholderText(
      msg.peerId,
      placeholder.id,
      parts[0].slice(0, TG_MESSAGE_LIMIT),
      parts[0].length <= TG_MESSAGE_LIMIT ? quoteEntitiesFor(parts[0]) : undefined,
    );
    for (let i = 1; i < parts.length; i++) {
      const delay =
        deps.splitDelayMs !== undefined && deps.splitDelayMs !== null
          ? Number(deps.splitDelayMs)
          : 400 + Math.random() * 300;
      if (delay > 0) await sleepFn(delay);
      let restPart = parts[i];
      // 分条同样要折叠：尾条合并了剩余全部行数时行数爆表，整条能装下一条消息才折，
      // 真要分片的条不折（同单条路径的理由，只折第一片会把后文藏错地方）。
      const partEntities = restPart.length <= TG_MESSAGE_LIMIT ? quoteEntitiesFor(restPart) : undefined;
      let firstChunk = true;
      while (restPart.length > 0) {
        const chunk = restPart.slice(0, TG_MESSAGE_LIMIT);
        restPart = restPart.slice(TG_MESSAGE_LIMIT);
        // 每条都带引用（v0.0.3 恢复）：v0.0.1 去掉后续条引用后，群里刷得快时
        // 后续条被别人的消息冲散、没人看得出在回谁（号主实测反馈），故恢复。
        await sendToPeer(msg.peerId, { message: chunk, replyTo: msg.id, formattingEntities: firstChunk ? partEntities : undefined });
        firstChunk = false;
      }
    }
  }

  /**
   * 追加语音：本群开了「说」、或这一条是「说 xxx」强制发声时，把完整答案文本
   * 经 TTS 合成为一条语音消息追加发送。TTS 未配置或失败时静默跳过、只记日志，
   * 绝不影响已经发出的文字回答。
   */
  async function maybeSpeak(msg, chatId, senderId, text, force) {
    const sayOn = Boolean(config.saySwitch && config.saySwitch[chatId]);
    if (!force && !sayOn) return;
    try {
      const speech = cleanSpeechText(text);
      if (!speech) return;
      const voice = pickVoiceName(config, chatId, senderId);
      const req = buildTtsRequest(config.ttsApiBase, config.ttsApiKey, speech, voice.id);
      let buf = null;
      if (req) {
        const res = await fetchImpl(req.url, req.options);
        if (!res || !res.ok) {
          logger.error(`TTS 请求失败：HTTP ${res ? res.status : "无响应"}`);
          return;
        }
        buf = Buffer.from(await res.arrayBuffer());
      } else {
        // 没配自定义 TTS 接口：用内置 Edge TTS（免 Key）。选中的音色本身是 Edge 音色名就用它，否则默认音色。
        const edgeVoice = /Neural$/.test(voice.id || "") ? voice.id : EDGE_DEFAULT_VOICE;
        buf = await synthesizeEdgeTts(speech, edgeVoice);
      }
      if (!buf || buf.length < 500) {
        logger.error("TTS 返回的音频过短，跳过语音");
        return;
      }
      const tmp = path.join(os.tmpdir(), `tts_${Date.now()}_${Math.floor(Math.random() * 100000)}.mp3`);
      fs.writeFileSync(tmp, buf);
      try {
        await client.sendFile(msg.peerId, { file: tmp, voiceNote: true, replyTo: msg.id });
      } finally {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // 临时文件删不掉不影响主流程。
        }
      }
    } catch (err) {
      logger.error(`发送语音失败：${err.message}`);
    }
  }

  /** 答完后的公共收尾：存上下文（脱敏后的一整条）、记整理计数、限速递增。 */
  function afterAnswer(chatId, senderId, speakerName, question, cleanAnswer) {
    const label = profiles.callName(senderId) || speakerName || "";
    store.push(chatId, senderId, "user", label ? `${label}：${question}` : question);
    store.push(chatId, senderId, "assistant", cleanAnswer);
    noteAnswerAndMaybeConsolidate(chatId, senderId);
    if (slowdownSet.has(senderId) && roleOf(senderId, permConfig()) === "user") {
      const mins = slowdown.recordAnswer(senderId);
      logger.info(`限速用户 ${senderId} 已被回答，进入 ${mins} 分钟冷却`);
    }
  }

  /** 普通用户提问冷却检查（聊天与识图共用）。返回 true 表示还在冷却、要忽略。 */
  function isCoolingDown(senderId) {
    const now = Date.now();
    const last = lastAskAt.get(senderId) || 0;
    if (config.cooldownSeconds > 0 && now - last < config.cooldownSeconds * 1000) return true;
    lastAskAt.set(senderId, now);
    return false;
  }

  /** 发占位消息；发不出去返回 null（调用方记日志收尾）。 */
  async function sendPlaceholder(msg, chatId, text = PLACEHOLDER_TEXT) {
    try {
      return await sendToPeer(msg.peerId, { message: text, replyTo: msg.id });
    } catch (err) {
      logger.error(`发送占位消息失败（chat=${chatId}）：${err.message}`);
      return null;
    }
  }

  /** 识图问答：下载照片 -> 从识图池按权重挑条目 -> 用该 API 的连接以条目模型发带图请求。 */
  /**
   * 识图调用核心：下载图片、组装消息、轮询识图池，返回 { answer }（已清洗）或
   * { error }（pool-empty / download-failed / all-failed）。只负责问出答案，
   * 发送由调用方处理——识图直答与「识图+生图」组合流程共用这一份。
   */
  async function queryVisionAnswer(msg, chatId, senderId, speakerName, photoMsg, question, speakerUsername, onPick) {
    const items = flattenVisionPool(config.visionPool).filter((it) => {
      const e = pool.getByName(it.apiName);
      return e && !e.disabled && !e.image;
    });
    if (items.length === 0) return { error: "pool-empty" };

    let buf = null;
    try {
      buf = await client.downloadMedia(photoMsg, { workers: 1 });
    } catch (err) {
      logger.error(`下载照片失败（chat=${chatId}）：${err.message}`);
    }
    if (!buf) return { error: "download-failed" };

    const dataUrl = `data:image/jpeg;base64,${Buffer.from(buf).toString("base64")}`;
    const history = store.get(chatId, senderId);
    const messages = [
      { role: "system", content: buildSystemParts(senderId, speakerName, chatId, speakerUsername) },
      ...history,
      {
        role: "user",
        content: [
          { type: "text", text: question },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ];

    const tried = new Set();
    /** @type {Set<string>} 预留失败（限额已满/失败冷却中）的 API 名：本轮整体跳过 */
    const blockedApis = new Set();
    let answer = null;
    while (!answer) {
      const candidates = items.filter(
        (it) => !tried.has(`${it.apiName}::${it.model}`) && !blockedApis.has(it.apiName),
      );
      if (candidates.length === 0) break;
      const pick = pickVisionEntry(candidates);
      const entry = pool.getByName(pick.apiName);
      // 与聊天同一套闸门：先预留每日名额（同时查限额与失败冷却），预留成功才真正调用，
      // 成功用 markSuccess 结算、失败用 markFailure 释放并进冷却（审计 K062-03）。
      if (!pool.reserve(entry)) {
        blockedApis.add(pick.apiName);
        continue;
      }
      // 识图模型标注在占位上（号主定版）：每次真开始调一个模型就回调一次，
      // 调用方把占位改成「（思考中...）-模型名」；失败换下一个时随之更新。
      if (onPick) {
        try {
          onPick(pick.model);
        } catch {
          // 标注回调出错不影响识图本身。
        }
      }
      tried.add(`${pick.apiName}::${pick.model}`);
      try {
        let seenUsage = null;
        const text = await pool.visionChat(entry, pick.model, messages, (u) => {
          seenUsage = u;
        });
        answer = text;
        pool.markSuccess(entry);
        usageStats.record(pick.model, seenUsage);
      } catch (err) {
        logger.error(`识图失败（${pick.apiName} / ${pick.model}）：${err.message}`);
        pool.markFailure(entry, err);
      }
    }

    if (!answer) return { error: "all-failed" };
    return { answer: scrubSecrets(answer, collectSecrets(config)) };
  }

  /** 识图失败时把占位消息改成对应的失败文案（识图直答与组合流程共用）。 */
  async function editVisionFailure(msg, placeholder, error) {
    const text =
      error === "pool-empty"
        ? "识图池是空的，发图提问暂时没模型可用。先让号主用 /ai 加识图 建池。"
        : error === "download-failed"
          ? "图片下载失败，请重发一次。"
          : "抱歉，识图模型暂时都不可用，请稍后再试。";
    try {
      await client.editMessage(msg.peerId, { message: placeholder.id, text });
    } catch (err) {
      logger.error(`发送识图失败提示出错：${err.message}`);
    }
  }

  async function handleVisionChat(msg, chatId, senderId, speakerName, parsed, photoMsg, speakerUsername) {
    const question = parsed.question || "这张图片是什么？请描述一下。";
    if (isCoolingDown(senderId)) return;

    const hasVision = flattenVisionPool(config.visionPool).some((it) => {
      const e = pool.getByName(it.apiName);
      return e && !e.disabled && !e.image;
    });
    if (!hasVision) {
      await reply(msg, "识图池是空的，发图提问暂时没模型可用。先让号主用 /ai 加识图 建池。");
      return;
    }

    const placeholder = await sendPlaceholder(msg, chatId);
    if (!placeholder) return;

    const res = await queryVisionAnswer(msg, chatId, senderId, speakerName, photoMsg, question, speakerUsername, (model) => {
      const tag = displayModelName(model);
      if (tag) editPlaceholderText(msg.peerId, placeholder.id, `${PLACEHOLDER_TEXT}-${tag}`).catch(() => {});
    });
    if (res.error) {
      await editVisionFailure(msg, placeholder, res.error);
      return;
    }

    const clean = res.answer;
    afterAnswer(chatId, senderId, speakerName, question, clean);
    try {
      await sendAnswer(msg, placeholder, clean, chatId);
    } catch (err) {
      logger.error(`发送识图答案失败（chat=${chatId}）：${err.message}`);
    }
    await maybeSpeak(msg, chatId, senderId, clean, false);
  }

  /**
   * 识图+生图组合（带图、又明确要生图）：先识图拿到画面描述并发给用户，再直接
   * 拿描述走生图执行端出图——全程确定性，不经聊天模型裁量。走过两版弯路：
   * v0.1.1 之前这类消息被识图通道整个吞掉，识图模型没有生图工具、只会回「没有
   * 可调用的生图工具」；v0.1.1 改成把描述注入聊天让模型自己调 generate_image，
   * 模型却用人设话术拖延、编造「工具说冷却中」（同期日志里生图接口零调用）。
   * 用户把两步都说死了（描述 + 按描述生成），就由代码把两步做完。
   */
  async function handleVisionThenGen(msg, chatId, senderId, speakerName, parsed, photoMsg, speakerUsername) {
    if (isCoolingDown(senderId)) return;
    const placeholder = await sendPlaceholder(msg, chatId);
    if (!placeholder) return;
    const res = await queryVisionAnswer(
      msg,
      chatId,
      senderId,
      speakerName,
      photoMsg,
      "请详细描述这张图片的画面内容（主体、人物外观、服装、表情、场景、风格、色调），只描述画面本身，不要提及截图、边框、手机或聊天软件界面。",
      speakerUsername,
      (model) => {
        const tag = displayModelName(model);
        if (tag) editPlaceholderText(msg.peerId, placeholder.id, `${PLACEHOLDER_TEXT}-${tag}`).catch(() => {});
      },
    );
    if (res.error) {
      await editVisionFailure(msg, placeholder, res.error);
      return;
    }
    const description = res.answer;
    afterAnswer(chatId, senderId, speakerName, parsed.question || "看看这张图并按描述生成图片", description);
    try {
      await sendAnswer(msg, placeholder, description, chatId);
    } catch (err) {
      logger.error(`发送识图描述失败（chat=${chatId}）：${err.message}`);
    }
    const genImpl = makeImageGenToolImpl(msg, chatId, senderId, speakerName, parsed.question, null, { skipAfterAnswer: true });
    await genImpl(description);
  }

  /** 生图问答：命中生图说法时走生图提供方，生成结果以图片回复。 */
  /** 生图接口调用：构造请求 -> （5xx/无响应时隔 3 秒重试一次）-> 解析 -> 下载成 Buffer。
   * 失败抛 Error：以「HTTP 」开头 = 接口不可用；「返回里没有图片」= 接口没给图；
   * 「图片内容不完整」= 下载失败或内容异常。正则快线与 generate_image 工具共用。 */
  async function fetchGeneratedImageBuffer(provider, prompt) {
    const def = (config.providers || []).find((p) => p && p.name === provider.name) || provider;
    const req = buildImageGenRequest(def, prompt);
    let res = await fetchImpl(req.url, req.options).catch(() => null);
    if (!res || !res.ok) {
      const status = res ? res.status : 0;
      if (!res || status >= 500) {
        // 中转站偶发 502/网关无响应（2026-11-23 群内实测 tokennova 首发 502、
        // 同参数直连却成功）：隔 3 秒自动重试一次，再失败才判失败。
        logger.error(`生图请求失败（${provider.name}）：HTTP ${status || "无响应"}，重试一次`);
        await sleepFn(3000);
        res = await fetchImpl(req.url, req.options).catch(() => null);
      }
    }
    if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : "无响应"}`);
    const data = await res.json();
    const parsedRes = parseImageGenResponse(data);
    if (!parsedRes) throw new Error("返回里没有图片");
    if (parsedRes.b64) return Buffer.from(parsedRes.b64, "base64");
    if (parsedRes.url) {
      const imgRes = await fetchImpl(parsedRes.url);
      if (imgRes && imgRes.ok) return Buffer.from(await imgRes.arrayBuffer());
    }
    throw new Error("图片内容不完整");
  }

  async function handleImageGen(msg, chatId, senderId, speakerName, parsed) {
    const provider = pool.firstImageProvider();
    if (!provider) {
      await reply(msg, "当前没有可用的生图 API。先让号主用 /ai 加生图api 添加。");
      return;
    }
    const prompt = extractImagePrompt(parsed.question);
    if (!prompt) {
      await reply(msg, "请告诉我你想生成什么图片，例如：画一张 一只猫。");
      return;
    }
    if (isCoolingDown(senderId)) return;

    // 与聊天/识图同一套闸门：先预留每日名额（限额/失败冷却），成功结算、失败释放（审计 K062-03/04）。
    if (!pool.reserve(provider)) {
      await reply(msg, "生图模型暂时不可用（已达每日上限或冷却中），请稍后再试。");
      return;
    }

    const genTag = displayModelName(provider.model);
    const placeholder = await sendPlaceholder(msg, chatId, genTag ? `（生图中...）-${genTag}` : "（生图中...）");
    if (!placeholder) {
      pool.release(provider);
      return;
    }

    let reservationHeld = true;
    const releaseReservation = () => {
      if (reservationHeld) {
        reservationHeld = false;
        pool.release(provider);
      }
    };
    const fail = async (text) => {
      releaseReservation();
      try {
        await client.editMessage(msg.peerId, { message: placeholder.id, text });
      } catch (err) {
        logger.error(`发送生图失败提示出错：${err.message}`);
      }
    };

    try {
      const buf = await fetchGeneratedImageBuffer(provider, prompt);
      if (!buf || buf.length < 500) {
        logger.error(`生图图片内容异常（${provider.name}）`);
        return fail("生图失败了，拿到的图片内容不完整。");
      }
      const tmp = path.join(os.tmpdir(), `img_${Date.now()}_${Math.floor(Math.random() * 100000)}.png`);
      fs.writeFileSync(tmp, buf);
      try {
        await client.sendFile(msg.peerId, { file: tmp, replyTo: msg.id });
      } finally {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // 临时文件删不掉不影响主流程。
        }
      }
      try {
        await client.deleteMessages(msg.peerId, [placeholder.id], { revoke: true });
      } catch {
        // 占位删不掉就留着，不影响图片本身。
      }
      pool.markSuccess(provider);
      reservationHeld = false;
      usageStats.record(provider.model, null);
      afterAnswer(chatId, senderId, speakerName, parsed.question, "（已按要求生成图片）");
    } catch (err) {
      if (String(err.message).startsWith("HTTP ")) {
        logger.error(`生图请求失败（${provider.name}）：${err.message}`);
        return fail("生图失败了，接口暂时不可用，请稍后再试。");
      }
      if (err.message === "返回里没有图片") {
        logger.error(`生图返回里没有图片（${provider.name}）`);
        return fail("生图失败了，接口没返回图片。");
      }
      if (err.message === "图片内容不完整") {
        logger.error(`生图图片内容异常（${provider.name}）`);
        return fail("生图失败了，拿到的图片内容不完整。");
      }
      logger.error(`生图失败（${provider.name}）：${err.message}`);
      return fail("生图失败了，请稍后再试。");
    }
  }

  /** generate_image 工具的执行端工厂：模型判定用户想生图时经 ctx 调用，流程与正则快线
   * 一致（选提供方、冷却/名额闸门、生图中占位、生成、发图、结算），返回一句话结果给模型。
   * chatPlaceholder 是聊天管线先发的「（思考中...）」占位：传了就把那一条直接改成
   * 「（生图中...）」，不再另发第二条占位（2026-11-24 群内实测两条占位并排，号主问
   * 「哪来的思考中」）；生成结束后不删不改它，最终回复由聊天管线编辑这同一条占位
   * 落地——顺序天然就是生完图再回。没传占位时才自发一条（自发自删，同旧行为）。 */
  function makeImageGenToolImpl(msg, chatId, senderId, speakerName, question, chatPlaceholder, options = {}) {
    return async (prompt) => {
      const p = String(prompt || "").trim();
      if (!p) return "没给画面描述，没生成。";
      const provider = pool.firstImageProvider();
      if (!provider) return "当前没有可用的生图 API，没法生成。请如实告诉用户：需要号主先用 /ai 加生图api 添加。";
      if (isCoolingDown(senderId)) return "用户操作太频繁、正在冷却中，这次没生成。如实告诉用户这次没生成。";
      if (!pool.reserve(provider)) return "生图模型暂时不可用（已达每日上限或冷却中），这次没生成。如实告诉用户这次没生成、请过几分钟再喊你重试，不要承诺稍后自动补画。";
      let placeholder = chatPlaceholder || null;
      let ownPlaceholder = false;
      // 生图模型同样标在占位上（号主定版）：「（生图中...）-模型名」，不写进图片说明。
      const genTag = displayModelName(provider.model);
      const genPlaceholderText = genTag ? `（生图中...）-${genTag}` : "（生图中...）";
      if (placeholder) {
        try {
          await client.editMessage(msg.peerId, { message: placeholder.id, text: genPlaceholderText });
        } catch {
          // 占位改不动就留着「思考中」，不影响生成本身。
        }
      } else {
        placeholder = await sendPlaceholder(msg, chatId, genPlaceholderText);
        ownPlaceholder = true;
        if (!placeholder) {
          pool.release(provider);
          return "生图占位消息发送失败，这次没生成。";
        }
      }
      let settled = false;
      try {
        const buf = await fetchGeneratedImageBuffer(provider, p);
        if (!buf || buf.length < 500) throw new Error("图片内容不完整");
        const tmp = path.join(os.tmpdir(), `img_${Date.now()}_${Math.floor(Math.random() * 100000)}.png`);
        fs.writeFileSync(tmp, buf);
        try {
          await client.sendFile(msg.peerId, { file: tmp, replyTo: msg.id });
        } finally {
          try {
            fs.unlinkSync(tmp);
          } catch {
            // 临时文件删不掉不影响主流程。
          }
        }
        if (ownPlaceholder) {
          try {
            await client.deleteMessages(msg.peerId, [placeholder.id], { revoke: true });
          } catch {
            // 占位删不掉就留着，不影响图片本身。
          }
        }
        pool.markSuccess(provider);
        settled = true;
        usageStats.record(provider.model, null);
        if (!options.skipAfterAnswer) afterAnswer(chatId, senderId, speakerName, question, "（已按要求生成图片）");
        return "图片已经生成并发到当前会话里了。回复用户时简短确认即可，不要再说自己不会画图、发不了图。";
      } catch (err) {
        if (!settled) pool.release(provider);
        logger.error(`生图失败（${provider.name}）：${err.message}`);
        if (ownPlaceholder) {
          try {
            await client.editMessage(msg.peerId, { message: placeholder.id, text: "生图失败了，请稍后再试。" });
          } catch {
            // 失败提示发不出不影响主流程。
          }
          return `生图失败了（${err.message}），已经在会话里发了失败提示。`;
        }
        // 共用聊天占位时不抢着改它：最终回复（或全模型失败兜底）会编辑这条占位收尾。
        return `生图失败了（${err.message}）。回复用户时如实说明失败，不要假装生成成功，也不要承诺稍后自动补画，请让用户过几分钟再喊你重试。`;
      }
    };
  }

  async function handleChat(msg, chatId, senderId, speakerName, parsed, speakerUsername, extraNote = "", presetPlaceholder = null) {
    if (!parsed.question) {
      // 只 @ 不说话（光喊一声）：不回脚本味的固定提示句——按号主定版（v0.6.6 起会话类
      // 不发罐头回复），替成一句「在吗」当问题走模型，让它用人设自然接话。
      parsed = { ...parsed, question: "在吗" };
    }
    // 普通用户冷却：间隔太短的提问直接忽略，防止刷屏烧额度。
    if (isCoolingDown(senderId)) return;

    // 机械刷量判定（v0.0.5）：判定在代码层（mechanicalBulkRequest），但回绝的话由
    // 模型用人设口吻说——判定结果在下面组装消息时以本轮特别指令注入系统提示。
    // v0.0.4 曾用写死的罐头句直接回，被号主指出又是脚本回复、违反定版，故改掉。
    const bulkHit = mechanicalBulkRequest(parsed.question);

    // 先发占位消息；发不出去（如被群禁言 USER_BANNED_IN_CHANNEL）就记日志返回，不要硬撑。
    // 组合流程（识图+生图）会把自己已发的占位传进来复用，避免连发两条占位。
    const placeholder = presetPlaceholder || (await sendPlaceholder(msg, chatId));
    if (!placeholder) return;

    // 「说 xxx」：剥掉前缀并强制这一条追加语音（本群没开说时也发）。
    let question = parsed.question;
    let forceVoice = false;
    const sayMatch = question.match(/^说\s+([\s\S]+)$/);
    if (sayMatch && !/^说(得好|得|明|不|不定|白|实话|啥|什么)/.test(question)) {
      forceVoice = true;
      question = sayMatch[1].trim() || question;
    }

    // 裸工具命令直达（v0.9.18）：「掷骰子」「塔罗牌」这类口令直接执行工具、一条消息
    // 发结果，不经模型裁量（经模型时它常先解释、发链接、反问要不要抽，体验差；原项目
    // 机器人是即问即抽）。执行失败就落回下面的正常管线。
    const directCmd = directToolCommand(question);
    if (directCmd) {
      try {
        const directCtx = { chatId, senderId, senderName: speakerName, timezone: config.timezone, logger, outbox: [], store: toolStore, imageSearch: imageSearchImpl, webSearch: webSearchImpl, imageGen: makeImageGenToolImpl(msg, chatId, senderId, speakerName, question, placeholder), client };
        const directResult = await executeTool(directCmd.name, directCmd.args, directCtx);
        if (directResult) {
          const cleanDirect = scrubSecrets(String(directResult), collectSecrets(config));
          afterAnswer(chatId, senderId, speakerName, parsed.question, cleanDirect);
          await editPlaceholderText(msg.peerId, placeholder.id, cleanDirect.slice(0, TG_MESSAGE_LIMIT));
          return;
        }
      } catch (err) {
        logger.error(`裸工具命令直达失败（${directCmd.name}）：${err.message}`);
      }
    }

    // 联网搜索：问题适合搜时先搜再把结果拼进问题让模型作答。
    // 后端二选一：配了 key 走 Serper/Tavily 接口；searchProvider=lightpanda 走本机 Lightpanda 抓 Brave/Bing（免 key）。
    // 话题兜底：用户只说「去搜」这类指令、没带主题时，从最近的历史往前找第一条
    // 有实质内容的用户消息当主题——只拿上一条会被连续指令带偏（连发「去搜」
    // 「去浏览器搜呀」时上一条也是指令、清洗后为空，主题在更早那条里）。
    let fallbackQuery = "";
    for (const m of [...store.get(chatId, senderId)].reverse()) {
      if (m.role !== "user") continue;
      let c = String(m.content || "");
      const lm = c.match(/^[^：:\n]{1,12}[：:]([\s\S]+)$/);
      if (lm) c = lm[1];
      if (cleanSearchQuery(c)) {
        fallbackQuery = c;
        break;
      }
    }
    const plan = planSearch(question, { hasKey: Boolean(config.searchApiKey), hasPhoto: false, provider: config.searchProvider, fallbackQuery, hasHistory: store.get(chatId, senderId).length > 0 });
    // AI 意图改写：识别平台/对象后改写查询词（失败回落清洗结果，不阻塞）。
    if (plan) plan.query = await rewriteSearchQuery(question, plan.query);
    if (plan) {
      try {
        if (plan.mode === "lightpanda") {
          const cacheKey = `lightpanda:${plan.query.toLowerCase()}`;
          const cached = searchCache.get(cacheKey);
          if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) {
            question = formatSearchContext(plan.mode, cached.text, question);
          } else {
            // 引擎顺序：Yahoo 优先（Bing 索引、机房 IP 不设墙），Brave 次之
            // （自有索引好但高频抓取会弹 PoW 验证），Bing 兜底（结果质量不稳定）。
            let result = { text: "", urls: [] };
            for (const attempt of [
              async () => parseYahooMarkdown(await lightpandaFetch(config.lightpandaBin, buildYahooSearchUrl(plan.query))),
              async () => parseBraveMarkdown(await lightpandaFetch(config.lightpandaBin, buildBraveSearchUrl(plan.query))),
              async () => parseBingMarkdown(await lightpandaFetch(config.lightpandaBin, buildBingSearchUrl(plan.query))),
            ]) {
              try {
                result = await attempt();
              } catch {
                result = { text: "", urls: [] };
              }
              if (result.text) break;
            }
            if (result.text) {
              question = formatSearchContext(plan.mode, result.text, question);
              if (searchCache.size > 100) searchCache.clear();
              searchCache.set(cacheKey, { text: result.text, at: Date.now() });
            } else logger.error("搜索失败：Lightpanda 三条引擎都未解析出结果");
          }
        } else {
          const req =
            plan.mode === "tavily"
              ? buildTavilyRequest(config.searchApiBase2, config.searchApiKey, plan.query)
              : buildSerperRequest(config.searchApiBase, config.searchApiKey, plan.query);
          const res = await fetchImpl(req.url, req.options);
          if (res && res.ok) {
            const data = await res.json();
            const result = plan.mode === "tavily" ? parseTavilyResults(data) : parseSerperResults(data);
            if (result.text) question = formatSearchContext(plan.mode, result.text, question);
          } else {
            logger.error(`搜索失败：HTTP ${res ? res.status : "无响应"}`);
          }
        }
      } catch (err) {
        logger.error(`搜索失败：${err.message}`);
      }
    }

    const history = store.get(chatId, senderId);
    const messages = [
      { role: "system", content: buildSystemParts(senderId, speakerName, chatId, speakerUsername, [bulkRefusalNote(bulkHit), extraNote].filter(Boolean).join("\n")) },
      ...history,
      { role: "user", content: question },
    ];

    const tried = new Set();
    let preferred = parsed.providerName;
    let answer = null;
    let usedEntry = null;
    let lastEditAt = 0;

    // 流式编辑代次管理（审计 K062-09）：流式阶段的部分文本 edit 是异步落定的，
    // 可能在最终答案发出之后才真正落地、把占位消息覆盖回旧的部分文本。
    // 每次发起 edit 记一个代次；收尾时关通道并记下最终占位文本与最终代次，
    // 迟到的旧 edit 一旦落定（settle 时发现自己代次已过时），立刻补发一次最终文本纠正回来。
    // 注意不能在发最终答案前死等在途 edit 落定：网络层可能长时间挂起，会把回答卡死。
    let editGen = 0;
    let streamClosed = false;
    let finalGen = 0;
    let finalPlaceholderText = null;
    const trackStreamingEdit = (text) => {
      const gen = ++editGen;
      client
        .editMessage(msg.peerId, { message: placeholder.id, text })
        .catch(() => {})
        .then(() => {
          if (streamClosed && gen < finalGen && finalPlaceholderText !== null) {
            return client
              .editMessage(msg.peerId, { message: placeholder.id, text: finalPlaceholderText })
              .catch(() => {});
          }
        });
    };

    const secrets = collectSecrets(config);
    // 工具门：问题可能需要内置工具（天气/汇率/热榜/换算等）时，先走工具调用管线；
    // 提供方不支持工具时 chatWithTools 返回 null，再回退到原来的流式聊天。
    // 续聊工具门（v0.9.18）：「抽」这类短回复本身不带工具关键词，但近几条上文刚聊到
    // 塔罗/骰子等工具话题时，应走工具管线让模型接上文真调工具（抽牌），而不是普通闲聊。
    const shortMsg = String(parsed.question || "").trim();
    const recentGate =
      shortMsg.length <= 4 &&
      store.get(chatId, senderId).slice(-4).some((m) => toolGate(String(m.content || "")));
    const useTools = toolGate(parsed.question) || recentGate;
    const toolOutbox = [];
    while (!answer) {
      const entry = pool.pick(tried, preferred);
      preferred = null; // 优先项只用一次，之后按权重挑
      if (!entry) break;
      tried.add(entry.name);
      // 模型标注（号主定版）：不写进回复内容，而是标在占位上——「（思考中...）-模型名」，
      // 渠道前缀剥掉只留本体名。走 trackStreamingEdit 的代次通道：迟到落定会被最终
      // 答案纠正回来，不会把答案覆盖回占位；换提供方重试时随之换成新模型名。
      const attemptTag = displayModelName(entry.model);
      if (attemptTag) trackStreamingEdit(`${PLACEHOLDER_TEXT}-${attemptTag}`);
      try {
        let seenUsage = null;
        let text = null;
        if (useTools) {
          text = await chatWithTools(
            entry,
            messages,
            { chatId, senderId, senderName: speakerName, timezone: config.timezone, logger, outbox: toolOutbox, store: toolStore, imageSearch: imageSearchImpl, webSearch: webSearchImpl, imageGen: makeImageGenToolImpl(msg, chatId, senderId, speakerName, question, placeholder), client },
            (u) => {
              seenUsage = u;
            },
          );
        }
        if (text === null) {
          text = await pool.chat(
            entry,
            messages,
            (partial) => {
              const t = Date.now();
              if (t - lastEditAt >= EDIT_INTERVAL_MS && partial.trim()) {
                lastEditAt = t;
                // 流式编辑也先脱敏：部分文本里可能已出现完整 key，不能原样发出去。
                const shown = scrubSecrets(partial, secrets);
                trackStreamingEdit(shown.slice(0, TG_MESSAGE_LIMIT));
              }
            },
            (u) => {
              seenUsage = u;
            },
          );
        }
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
      // 同样收尾：迟到的流式 edit 落定后要纠正回这句失败提示，而不是停在部分文本上。
      streamClosed = true;
      finalGen = ++editGen;
      finalPlaceholderText = "抱歉，所有模型都暂时不可用，请稍后再试。";
      try {
        await editPlaceholderText(msg.peerId, placeholder.id, finalPlaceholderText);
      } catch (err) {
        logger.error(`发送失败提示出错：${err.message}`);
      }
      return;
    }

    // 文本工具调用抢救：有的提供方会把工具调用写成 <tool_call>{...}</tool_call> 文本而不是原生
    // function call（工具门没命中、走普通聊天时尤其容易，如接上文报出城市名）。原样发出去会把标记
    // 怼到用户脸上：这里识别出来真执行，再让模型拿结果重答一次；重答还带标记就剥掉标记，
    // 最差也只发工具原文结果，绝不发标记本身。
    {
      const leaked = extractTextToolCalls(answer);
      if (leaked.length > 0 && usedEntry) {
        const toolCtx = { chatId, senderId, senderName: speakerName, timezone: config.timezone, logger, outbox: toolOutbox, store: toolStore, imageSearch: imageSearchImpl, webSearch: webSearchImpl, imageGen: makeImageGenToolImpl(msg, chatId, senderId, speakerName, question, placeholder), client };
        const resultLines = [];
        for (const call of leaked) {
          try {
            resultLines.push(await executeTool(call.name, call.args, toolCtx));
          } catch (err) {
            resultLines.push(`工具 ${call.name} 执行失败：${err.message}`);
          }
        }
        let rescued = null;
        try {
          rescued = await pool.chat(
            usedEntry,
            [
              ...messages,
              {
                role: "user",
                content: `【工具执行结果】\n${resultLines.join("\n")}\n请根据以上结果直接回答我最初的问题，不要再输出 <tool_call> 标记或 JSON。`,
              },
            ],
            () => {},
            (u) => usageStats.record(usedEntry.model, u),
          );
        } catch (err) {
          logger.error(`工具结果重答失败：${err.message}`);
        }
        if (rescued && extractTextToolCalls(rescued).length === 0) {
          answer = rescued;
        } else if (rescued) {
          answer = stripTextToolCalls(rescued) || resultLines.join("\n");
        } else {
          answer = resultLines.join("\n");
        }
      }
    }

    // 出口脱敏：最终回复与存入上下文的文本都先过滤（配置 key 逐字打码 + sk- 长串打码），
    // 防止模型把 key 样式的字符串编进回复里吓人。
    const clean = scrubSecrets(answer, secrets);

    // 流式收尾：关通道并记下最终占位文本（与 sendAnswer 的分条判定保持一致），
    // 供 trackStreamingEdit 的代次纠正使用（审计 K062-09）。
    streamClosed = true;
    finalGen = ++editGen;
    {
      const finalParts = decideSplit(clean, { personaMode: isPersonaMode(), maxParts: splitMaxPartsFor(msg, chatId) });
      finalPlaceholderText = (finalParts.length <= 1 ? clean : finalParts[0]).slice(0, TG_MESSAGE_LIMIT);
    }

    // 保存上下文（问题 + 脱敏后的回答），下次提问能接上话。
    afterAnswer(chatId, senderId, speakerName, parsed.question, clean);

    // 最终答案：人设模式闲聊分条发、其余整条发（sendAnswer 内部判定）。
    try {
      await sendAnswer(msg, placeholder, clean, chatId);
    } catch (err) {
      logger.error(`发送最终答案失败（chat=${chatId}，模型=${usedEntry.name}）：${err.message}`);
    }

    // 工具附件（如二维码图片）：随答案一起发到当前会话。
    for (const item of toolOutbox) {
      if (!item || item.type !== "photo" || !item.buffer) continue;
      const tmp = path.join(os.tmpdir(), `tool_${Date.now()}_${Math.floor(Math.random() * 100000)}${path.extname(item.filename || "") || ".png"}`);
      try {
        fs.writeFileSync(tmp, item.buffer);
        await client.sendFile(msg.peerId, { file: tmp, replyTo: msg.id });
      } catch (err) {
        logger.error(`发送工具附件失败：${err.message}`);
      } finally {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // 临时文件删不掉不影响主流程。
        }
      }
    }

    // 追加语音（本群开了说、或这一条是「说 xxx」）：用完整文本合成一条，不受分条影响。
    await maybeSpeak(msg, chatId, senderId, clean, forceVoice);
  }

  /**
   * 公开命令（任何人可用、不走模型）：触发后的问题恰好是 /ai 账单、/ai 模型、/ai 人设 时命中。
   * 号主在群里 @机器人发这些会先被号主命令路径接走（执行的是号主版），走到这里的都是公开版。
   * @returns {Promise<boolean>} 是否已处理
   */
  async function handlePublicQuery(msg, question) {
    if (question === "/ai 账单") {
      const snap = usageStats.snapshot();
      await reply(
        msg,
        `今日用量：\n${pool.usageReport()}\nToken（今日）：输入 ${snap.totals.prompt} / 输出 ${snap.totals.completion} / 合计 ${snap.totals.total}`,
      );
      return true;
    }
    if (question === "/ai 模型") {
      const name = config.defaultProvider || "default";
      const entry = name ? pool.getByName(name) : null;
      await reply(msg, entry ? `当前默认提供方：${entry.name}（模型 ${entry.model}）` : `当前默认提供方：${name || "default"}`);
      return true;
    }
    if (question === "/ai 人设") {
      if (config.systemPromptIsDefault) {
        await reply(msg, "当前用的是默认人设：一个友好的 AI 助手，回答简洁、准确。");
      } else {
        const p = config.systemPrompt;
        await reply(msg, `当前人设：\n${p.length > 1000 ? `${p.slice(0, 1000)}…` : p}`);
      }
      return true;
    }
    return false;
  }

  return async function handler(event) {
    try {
      const msg = event && event.message;
      if (!msg) return;
      if (msg.out) return; // 忽略自己发出的消息

      const text = msg.message || "";
      const hasPhoto = msgHasPhoto(msg);
      if (!text && !hasPhoto) return; // 纯媒体（无图无字）不处理

      const chatId = (
        msg.chatId ||
        msg.peerId?.channelId ||
        msg.peerId?.chatId ||
        msg.peerId?.userId ||
        ""
      ).toString();
      // 私聊的判定：peer 是单个用户（userId）且不带群/频道 ID。
      const isPrivateChat = Boolean(msg.peerId?.userId) && !msg.peerId?.chatId && !msg.peerId?.channelId;
      let senderId = msg.senderId ? msg.senderId.toString() : "";
      // 匿名发言（群管理员开匿名、以群身份发言等）：Telegram 不给发送者 ID（from_id 为空），
      // 以前在这里直接丢弃，表现为「马甲用户不回复」。群里给一个按群合成的匿名身份、
      // 当普通用户处理（无任何权限）；私聊没有这种情况，照旧丢弃。
      let anonymousSender = false;
      if (!senderId) {
        if (isPrivateChat) return;
        // 带签名的匿名发言按签名区分（各管理通常签不同名字）；没签名的共用一个匿名身份。
        // 签名是自由文本、可改可冒充，只作软区分，不当身份凭证。
        const sig = String(msg.postAuthor || "").trim().slice(0, 64);
        senderId = sig ? `anon:${chatId}:${sig}` : `anon:${chatId}`;
        anonymousSender = true;
      }

      if (blacklist.has(senderId)) return;

      // 忽略名单（本地 config.ignoreSenderIds）：名单内账号的消息一律不处理。
      // 主要用途：同群的另一个机器人号——两个号永不互相搭理，杜绝互相触发死循环。
      if ((config.ignoreSenderIds || []).map(String).includes(senderId)) return;

      // 防死循环（回声免疫）：机器人自己发过的固定文案被原样送回（非号主）时忽略。
      if (text && roleOf(senderId, permConfig()) !== "owner" && recentSentTexts.includes(text.trim())) {
        logger.info(`回声免疫：忽略与机器人已发文案完全相同的消息（chat=${chatId}）`);
        return;
      }

      // 发言者对象懒加载（名字、用户名共用同一次取，只取一次）：用户名要喂给模型，
      // 它才知道怎么 @ 对方——否则它会以为自己不知道用户名、还让对方手动发（v0.9.18 群内实测）。
      let senderObjPromise = null;
      const getSenderObj = () => {
        if (!senderObjPromise) {
          senderObjPromise = (async () => {
            // 匿名发言没有真实发送者对象。
            if (anonymousSender) return null;
            try {
              if (typeof event.getSender === "function") return await event.getSender();
            } catch {
              // 取不到不影响主流程。
            }
            return null;
          })();
        }
        return senderObjPromise;
      };
      const getSpeakerName = async () => {
        if (anonymousSender) return String(msg.postAuthor || "").trim() || "匿名成员";
        const sender = await getSenderObj();
        if (sender) return String([sender.firstName, sender.lastName].filter(Boolean).join(" ") || sender.username || "").trim();
        return "";
      };
      const getSpeakerUsername = async () => {
        const sender = await getSenderObj();
        return sender && sender.username ? String(sender.username).trim() : "";
      };

      // 称呼捕捉：任何人亲口在自己消息里说「叫我 X」，就把 X 记进他的档案（持久化）。
      if (text) {
        const cn = extractCallName(text);
        if (cn) profiles.setCallName(senderId, cn);
      }

      // 号主专属流程：命令解析在最前；两步选择（pending）的数字/全文回复紧随其后，
      // 都排在全局暂停门禁之前——暂停时号主照样能管理。
      // 群里「@机器人 /ai 命令」也要认：消息不以 /ai 开头时，剥掉开头的 @用户名 提及再解析
      // （仅号主；管理员与普通用户 @ 后发 /ai 命令不升成命令，按普通问题处理）。
      if (canRunOwnerCommand(senderId, permConfig())) {
        const body = parseOwnerCommand(text) ?? parseMentionOwnerCommand(text, config.myUsername);
        if (body !== null) {
          pending.clear(chatId, senderId);
          sensitiveTombstones.delete(`${chatId}:${senderId}`);
          await handleOwnerCommand(msg, chatId, senderId, body);
          return;
        }
        const tbKey = `${chatId}:${senderId}`;
        const pk = pending.peek(chatId, senderId);
        if (pk) {
          const trimmed = text.trim();
          // 这一步等全文的 pending（换key/换搜索key 的第二步、加识图第二步、
          // 加音色的两步、加人格第二步）：非命令文本整条就是要填的内容。
          const expectsText = !pk.expired && isSensitiveTextPending(pk.entry);
          if (pk.expired) {
            pending.clear(chatId, senderId);
            if (/^\d+$/.test(trimmed)) {
              await reply(msg, "已超时，请重新发命令。");
              return;
            }
            if (isSensitiveTextPending(pk.entry)) {
              // 敏感文本 pending 过期：这条消息极可能就是迟到的 key/凭证，绝不能回落成
              // 普通聊天（私聊会被发给模型，群聊会被写进记录再进别人的系统上下文）。
              // 当场吞掉（在写群记录之前 return），并留 10 分钟墓碑：防凭证被拆成
              // 两条发，第二条也吞掉（审计 K062-01）。
              sensitiveTombstones.set(tbKey, Date.now() + TOMBSTONE_TTL_MS);
              logger.info(
                `敏感待办已过期，迟到消息已忽略（chat=${chatId} user=${senderId} kind=${pk.entry.kind} step=${pk.entry.step}）`,
              );
              await reply(msg, TOMBSTONE_NOTICE);
              return;
            }
            // 过期且不是数字、也不是敏感文本待办：已清掉，按普通消息继续往下走。
          } else if (expectsText) {
            pending.consume(chatId, senderId);
            await executePending(msg, chatId, senderId, pk.entry, trimmed);
            return;
          } else if (pk.entry.step === 2 && pk.entry.kind === "换模型") {
            // 换模型第二步既收数字（从列表里选）也收全文（直接发模型名），整条都交给它处理。
            // 不进敏感名单：模型名不是凭证，过期后迟到的文本按普通消息走即可，不用墓碑吞掉。
            pending.consume(chatId, senderId);
            await executePending(msg, chatId, senderId, pk.entry, trimmed);
            return;
          } else if (/^\d+$/.test(trimmed)) {
            pending.consume(chatId, senderId);
            await executePending(msg, chatId, senderId, pk.entry, trimmed);
            return;
          } else if (
            (pk.entry.step === 2 && pk.entry.kind === "限额") ||
            (pk.entry.step === 2 && pk.entry.kind === "识图权重")
          ) {
            const what = pk.entry.kind === "限额" ? "限额要发纯数字（0 = 不限）。" : "这一步要发纯数字（权重）。";
            await reply(msg, `${what}请单独发一个数字；不想改了就等 60 秒过期。`);
            return;
          }
          // 其余情况（等数字时发了别的内容）：不清 pending，按普通消息继续往下走。
        } else {
          // 没有进行中的 pending 时才查墓碑（有新 pending 说明流程已重启，命令路径也会清墓碑）：
          // 墓碑期内吞掉该用户的下一条非命令消息并清墓碑——只记日志、回固定提示，
          // 绝不写群记录、绝不发给模型（审计 K062-01）。
          const tbUntil = sensitiveTombstones.get(tbKey);
          if (tbUntil !== undefined) {
            sensitiveTombstones.delete(tbKey);
            if (Date.now() <= tbUntil) {
              logger.info(`墓碑期内，消息已忽略（chat=${chatId} user=${senderId}）`);
              await reply(msg, TOMBSTONE_NOTICE);
              return;
            }
          }
        }
      }

      // 群聊天记录：开启记录的群里，所有人的文本消息都记下来（号主命令已在上面处理完，
      // 不会记进行录；机器人的回复是 out 消息、更早就返回了，也不会记）。
      if (!isPrivateChat && text && recordsEnabledFor(chatId)) {
        const name = await getSpeakerName();
        records.record(chatId, { name: name || "群友", senderId, text });
      }

      // 全局暂停门禁：创建者用 /ai 关闭 后，谁的提问都不回、不调模型（省 token）。
      if (shouldPauseBlock(state.isPaused(), senderId, permConfig())) {
        logger.info(`全局暂停中，忽略用户 ${senderId} 的消息（chat=${chatId}）`);
        return;
      }

      // 私聊门禁：privateChat="admins" 时普通用户的私聊静默不回；群聊不受影响。
      if (isPrivateChat && !canUsePrivateChat(senderId, permConfig())) {
        logger.info(`私聊门禁拦截：用户 ${senderId} 不在放行名单（privateChat=admins）`);
        return;
      }

      const role = roleOf(senderId, permConfig());

      let parsed = parseTrigger(text, {
        username: config.myUsername,
        defaultProvider: config.defaultProvider,
        usernameTrigger: config.usernameTrigger,
        role,
      });

      // 被回复的消息（回复续聊判定 + 回复照片提问共用，只取一次）。
      let repliedMsg = null;
      if (msg.replyTo || msg.replyToMsgId != null) {
        try {
          if (typeof msg.getReplyMessage === "function") {
            repliedMsg = await msg.getReplyMessage();
          }
        } catch (err) {
          logger.error(`取被回复消息失败（chat=${chatId}）：${err.message}`);
        }
      }

      // 回复续聊：没命中提及时，若这条消息回复的是机器人自己发出的消息，也算触发，
      // 问题就是消息全文（群聊、私聊都适用）。
      if (!parsed && repliedMsg && isReplyToSelf(repliedMsg, selfId)) {
        parsed = {
          kind: "reply",
          trigger: null,
          providerName: config.defaultProvider || "default",
          question: text.trim(),
        };
      }

      // 私聊直通：私聊里不用 @，任何普通文本（或一张图）都直接当问题。
      if (!parsed && isPrivateChat) {
        parsed = {
          kind: "direct",
          trigger: null,
          providerName: config.defaultProvider || "default",
          question: text.trim(),
        };
      }

      if (!parsed) return;

      // 照片来源：消息本身带图，或被触发时回复的那条带图。
      let photoSource = null;
      if (hasPhoto) photoSource = msg;
      else if (repliedMsg && msgHasPhoto(repliedMsg)) photoSource = repliedMsg;
      if (photoSource && !parsed.question) {
        parsed = { ...parsed, question: "这张图片是什么？请描述一下。" };
      }

      // 帮助拦截：被触发后提取出的问题恰好是「帮助」类写法时，直接回代码写死的
      // 公开版帮助，不发占位符、不调模型（不然模型会现编一份假能力清单）。
      if (!photoSource && isHelpQuery(parsed.question)) {
        await reply(msg, PUBLIC_HELP_TEXT);
        return;
      }


      // 公开命令：@我 后发 /ai 账单、/ai 模型、/ai 人设，任何人可用、不走模型。
      if (!photoSource && (await handlePublicQuery(msg, parsed.question))) {
        return;
      }

      // 音色小命令（公开，不走模型）：音色列表 / 当前音色 / 换音色 <名字>。
      if (!photoSource) {
        const vq = voiceQueryKind(parsed.question);
        if (vq === "list") {
          const names = Object.keys(config.voiceBook || {});
          await reply(msg, names.length > 0 ? `可用音色：\n${names.join("\n")}` : "音色库是空的，请联系号主添加。");
          return;
        }
        if (vq === "current") {
          const personal = (config.voiceByChatUser || {})[`${chatId}_${senderId}`] || "";
          const group = (config.voiceByChat || {})[chatId] || "";
          let line;
          if (personal) line = `你的音色：${personal}`;
          else if (group) line = `本群当前音色：${group}（你还没设自己的，想设就发「换音色 名字」）`;
          else line = "你还没设音色，本群也没设，用的是默认音色。想设就发「换音色 名字」。";
          await reply(msg, line);
          return;
        }
        const vs = parseVoiceSwitch(parsed.question);
        if (vs) {
          if (!(config.voiceBook || {})[vs]) {
            await reply(msg, `没找到音色「${vs}」，发「音色列表」可以看全部。`);
            return;
          }
          const allowed = role === "owner" || Boolean(config.voiceSwitch && config.voiceSwitch[chatId]);
          if (!allowed) {
            await reply(msg, "本群换音色权限未开启，请联系号主。");
            return;
          }
          const map = { ...(config.voiceByChatUser || {}) };
          map[`${chatId}_${senderId}`] = vs;
          if (!saveAndReload({ voiceByChatUser: map })) return reply(msg, "保存失败，请看日志。");
          await reply(msg, `已切换你的音色为：${vs}`);
          return;
        }
      }

      // 命令形文本兜底：提取出的问题以「/ai 」开头，说明对方在发命令，但号主命令
      // 与公开命令都没匹配上（命令不存在或无权用）——固定回一句，绝不把命令原文
      // 丢给模型瞎答（用户 2026-11-15 明令）。
      if (!photoSource && /^\/ai(\s|$)/.test(parsed.question)) {
        await reply(msg, "这条 /ai 后面的命令不存在，或你用不了。发 /ai 帮助 看能用的命令；想聊天就直接 @我 说问题。");
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
      const speakerName = await getSpeakerName();
      const speakerUsername = await getSpeakerUsername();

      // 识图池为空、但用户这句带了真实文字时，不走识图（别用「识图不可用」把文字问题
      // 一起打发），落回下面的普通文字问答；纯图无文字时仍走识图报错（v0.9.11）。
      if (photoSource && !(flattenVisionPool(config.visionPool).length === 0 && String(text || "").trim())) {
        // 带图又明确要生图：走组合流程（先识图描述、再拿描述直接生图），
        // 不能整个吞进识图通道——识图模型没有生图工具，只会回「没有生图工具」。
        // 带图时判定放宽（isLooseImageGenRequest）：「生成同样的图片」这类动词与
        // 图像名词隔着几个字、又没量词的说法严格判定会漏，带着图时语境足够明确。
        if (isImageGenRequest(parsed.question) || isLooseImageGenRequest(parsed.question)) {
          await handleVisionThenGen(msg, chatId, senderId, speakerName, parsed, photoSource, speakerUsername);
          return;
        }
        await handleVisionChat(msg, chatId, senderId, speakerName, parsed, photoSource, speakerUsername);
        return;
      }

      // 生图说法但提示词只剩指代词（「按照这个生成图片」）：指代的是被回复的那条
      // 描述/上一条回答，快线拿「按照这个」当提示词只会生成莫名其妙的图——交给
      // 聊天模型结合上下文调 generate_image（把被回复的原文一并塞进本轮指令）。
      if (isImageGenRequest(parsed.question) && isReferentialImagePrompt(extractImagePrompt(parsed.question))) {
        const repliedText = repliedMsg && typeof repliedMsg.message === "string" ? repliedMsg.message.trim() : "";
        const note = `【本轮特别指令】用户说要按「这个」生成图片，他回复的那条消息里就有现成的画面描述${repliedText ? `：「${repliedText.slice(0, 800)}」` : "（见对话历史里上一条描述）"}。请以这段描述为蓝本调用 generate_image 工具生成一张新图，不要用 find_photo 去网上找现成图，也不要拿「这个」这种指代词当提示词。`;
        await handleChat(msg, chatId, senderId, speakerName, parsed, speakerUsername, note);
        return;
      }

      if (isImageGenRequest(parsed.question)) {
        await handleImageGen(msg, chatId, senderId, speakerName, parsed);
        return;
      }

      await handleChat(msg, chatId, senderId, speakerName, parsed, speakerUsername);
    } catch (err) {
      // 兜底：处理消息时的任何异常都进日志，不能让它无声消失。
      logger.error(`处理消息时出错：${err.stack || err.message || err}`);
    }
  };
}
