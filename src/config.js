// 配置加载：.env（必填项） + config.json（可选，多模型/限额等）。
// config.json 的字段详解见 docs/CONFIG.md。

import fs from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { DEFAULT_PROVIDER } from "./triggers.js";
import { normalizeAdminIds, normalizeGuestIds } from "./permissions.js";
import { normalizeVisionPool } from "./vision.js";
import { DEFAULT_SERPER_BASE, DEFAULT_TAVILY_BASE } from "./search.js";
import { rootPath } from "./rootdir.js";

// .env 与 config.json 都锚定项目根目录（v0.9.1）：从任何目录启动都读同一份，
// 不再受进程启动目录影响（此前按 cwd 读，换个目录启动就像没保存过）。
loadDotenv({ path: rootPath(".env") });

export const CONFIG_PATH = rootPath("config.json");

export const DEFAULT_SYSTEM_PROMPT =
  "你是一个友好的 AI 助手，在 Telegram 里回答问题。回答简洁、准确，用提问者的语言回复。";

/** 把 config.json 里的字符串数组字段规范化：转字符串、去空、去重。 */
function stringArray(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const item of value) {
    const s = String(item ?? "").trim();
    if (s) seen.add(s);
  }
  return [...seen];
}

function readConfigJson() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch (err) {
    throw new Error(`config.json 解析失败：${err.message}。请检查 JSON 格式，或删掉该文件只用 .env 运行。`);
  }
}

/** 把运行期产生的配置（黑名单、管理员名单）合并写回 config.json。 */
export function saveConfigJson(patch) {
  const current = readConfigJson();
  const next = { ...current, ...patch };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n", "utf-8");
  return next;
}

function envBool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

/** 把 config.json 里的「字符串 -> 字符串」对象字段规范化（音色库、人格、每群条数等）。 */
function stringMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const key = String(k || "").trim();
    if (key && typeof v === "string") out[key] = v;
  }
  return out;
}

/** 把 config.json 里的「字符串 -> 布尔」对象字段规范化（每群开关）。 */
function boolMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const key = String(k || "").trim();
    if (key) out[key] = v === true;
  }
  return out;
}

/** 把 config.json 里的「字符串 -> 正数」对象字段规范化（每群记录条数）。 */
function numberMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const key = String(k || "").trim();
    const n = Number(v);
    if (key && Number.isFinite(n) && n > 0) out[key] = Math.floor(n);
  }
  return out;
}

/**
 * 加载全部配置。缺少必填项时抛出带中文说明的错误，由入口打印后退出。
 */
// 内置 Telegram Desktop 公开凭证：官方桌面客户端开源代码里公开的 api_id / api_hash，
// 登录时 .env 没填凭证就用它——用户只输手机号即可，不用再去 my.telegram.org 申请。
const BUILTIN_API_ID = 2040;
const BUILTIN_API_HASH = "b18441a1ff607e10a989891a5462e627";

export function loadConfig() {
  const apiIdRaw = (process.env.TELEGRAM_API_ID || "").trim();
  const envHash = (process.env.TELEGRAM_API_HASH || "").trim();

  // 凭证策略（v0.9.0 定版）：默认内置凭证、手机号直登；.env 填了 TELEGRAM_API_ID/HASH 就用填的。
  // 注意：同一账号必须一直用同一套凭证登录，中途换凭证可能触发 Telegram 的发码限制。
  const usingBuiltin = !apiIdRaw || !envHash;
  const apiId = usingBuiltin ? BUILTIN_API_ID : Number.parseInt(apiIdRaw, 10);
  if (!usingBuiltin && (!Number.isFinite(apiId) || apiId <= 0)) {
    throw new Error(`TELEGRAM_API_ID 格式不对：应是纯数字，当前填的是 “${apiIdRaw}”。`);
  }
  const apiHash = usingBuiltin ? BUILTIN_API_HASH : envHash;

  const json = readConfigJson();

  // 默认提供方来自 .env；config.json 的 customProviders 追加更多提供方。
  const envProvider = {
    name: DEFAULT_PROVIDER,
    baseURL: (process.env.AI_API_BASE || "https://api.openai.com/v1").trim(),
    apiKey: (process.env.AI_API_KEY || "").trim(),
    model: (process.env.AI_API_MODEL || "gpt-4o-mini").trim(),
    weight: 10,
    dailyLimit: 0,
  };

  const customProviders = Array.isArray(json.customProviders) ? json.customProviders : [];
  const providers = [envProvider, ...customProviders];

  // 每日限额：config.json 的 dailyLimits 可覆盖单个提供方的上限。
  const dailyLimits = json.dailyLimits && typeof json.dailyLimits === "object" ? json.dailyLimits : {};
  for (const p of providers) {
    if (dailyLimits[p.name] !== undefined) p.dailyLimit = Number(dailyLimits[p.name]) || 0;
    else if (p.dailyLimit === undefined) p.dailyLimit = 0;
  }

  // 提供方覆盖：config.json 的 providerOverrides 按名字合并到对应提供方定义上
  // （含 .env 的 default）。号主用 /ai 换key、/ai 禁用api 等命令写这个字段，在线生效。
  const providerOverrides =
    json.providerOverrides && typeof json.providerOverrides === "object" ? json.providerOverrides : {};
  const keyProp = "api" + "Key";
  for (const p of providers) {
    const ov = providerOverrides[p.name];
    if (!ov || typeof ov !== "object") continue;
    if (typeof ov[keyProp] === "string" && ov[keyProp]) p[keyProp] = ov[keyProp];
    if (ov.disabled === true) p.disabled = true;
    else if (ov.disabled === false) p.disabled = false;
  }

  const hasCustomPrompt = typeof json.systemPrompt === "string" && json.systemPrompt.trim() !== "";

  return {
    apiId,
    apiHash,
    apiCredentialSource: usingBuiltin ? "builtin" : "custom",
    myUsername: (process.env.MY_USERNAME || "").trim().replace(/^@/, ""),
    ownerId: (process.env.OWNER_ID || "").trim(),
    timezone: (process.env.TIMEZONE || "Asia/Shanghai").trim(),
    namePrefix: (process.env.NAME_PREFIX || "GPT").trim(),
    nameClock: envBool(process.env.NAME_CLOCK, true),

    systemPrompt: hasCustomPrompt ? json.systemPrompt : DEFAULT_SYSTEM_PROMPT,
    // 当前用的是不是内置默认人设（/ai 人设 展示与 /ai 清除人设 判断用）。
    systemPromptIsDefault: !hasCustomPrompt,
    contextSize: Number.isFinite(json.contextSize) && json.contextSize > 0 ? Math.floor(json.contextSize) : 20,
    cooldownSeconds:
      Number.isFinite(json.cooldownSeconds) && json.cooldownSeconds >= 0 ? Number(json.cooldownSeconds) : 5,

    providers,
    blacklist: Array.isArray(json.blacklist) ? json.blacklist.map(String) : [],
    adminIds: normalizeAdminIds(json.adminIds),
    // 访客名单：privateChat="admins" 时可私聊的普通用户（仅放行私聊，无管理员权限）。
    guestIds: normalizeGuestIds(json.guestIds),
    ignoreSenderIds: normalizeAdminIds(json.ignoreSenderIds),
    // 私聊门禁：默认 "admins"（只有创建者+管理员+访客可私聊，与生产部署一致，
    // 也与号主帮助里的说明一致）；明确写 "all" 才人人可私聊。群聊不受影响。
    privateChat: json.privateChat === "all" ? "all" : "admins",

    // ---- v0.5.0 起的字段 ----
    // 用户名触发开关：false 时普通用户的 @用户名 提及不触发（回复/私聊不受影响）。
    usernameTrigger: json.usernameTrigger !== false,
    // 限速名单（用户数字 ID）：被限速者答后进入递增冷却。
    slowdownUsers: stringArray(json.slowdownUsers),
    // 代码关键词：普通用户的问题命中任一词 → 提醒计数，第 3 次自动拉黑。
    codeKeywords: stringArray(json.codeKeywords),
    // 屏蔽群（群 ID）与屏蔽词：屏蔽群内问题命中屏蔽词 → 静默不回。词对所有屏蔽群生效。
    sensitiveGroups: stringArray(json.sensitiveGroups),
    sensitiveKeywords: stringArray(json.sensitiveKeywords),
    // 默认提供方（/ai 换模型 设）：提问都用它，空 = 用名为 default 的。
    defaultProvider: typeof json.defaultProvider === "string" ? json.defaultProvider.trim() : "",
    // 以下三项是「原始值」回显，供号主命令在现有值基础上改写后整体落盘：
    customProviders,
    providerOverrides,
    dailyLimits,

    // ---- v0.6.0 起的字段 ----
    // 破甲：只存本地 config.json（gitignore，永不进仓库），注入优先级 破甲 > 人设 > 默认风格。
    poJia: typeof json.poJia === "string" ? json.poJia : "",
    // 识图池：{ apiName: [{model, weight}] }，已规范化。
    visionPool: normalizeVisionPool(json.visionPool),
    // TTS：接口地址与 key（config.json 优先，.env 的 TTS_API_BASE / TTS_API_KEY 兜底）。
    ttsApiBase: (typeof json.ttsApiBase === "string" && json.ttsApiBase.trim()) || (process.env.TTS_API_BASE || "").trim(),
    ttsApiKey: (typeof json.ttsApiKey === "string" && json.ttsApiKey.trim()) || (process.env.TTS_API_KEY || "").trim(),
    // 音色库：音色名 -> 音色 ID。人格：音色名 -> 人格提示词。
    voiceBook: stringMap(json.voiceBook),
    voicePersona: stringMap(json.voicePersona),
    // 每群开关：saySwitch = 开启说（回答后追加语音），voiceSwitch = 开启换音色（群友可自选音色）。
    saySwitch: boolMap(json.saySwitch),
    voiceSwitch: boolMap(json.voiceSwitch),
    // 当前音色：voiceByChat 是群级，voiceByChatUser 是个人级（键 "chatId_senderId"）。
    voiceByChat: stringMap(json.voiceByChat),
    voiceByChatUser: stringMap(json.voiceByChatUser),
    // 群聊天记录：开启记录的群 ID 名单 + 每群注入条数（缺省 100）。
    recordGroups: stringArray(json.recordGroups),
    recordContextLimit: numberMap(json.recordContextLimit),
    // 搜索 key：config.json 的 searchApiKey 优先（/ai 换搜索key 写它），.env 的 SEARCH_API_KEY 兜底。
    searchApiKey:
      (typeof json.searchApiKey === "string" && json.searchApiKey.trim()) || (process.env.SEARCH_API_KEY || "").trim(),
    searchApiBase: (process.env.SEARCH_API_BASE || DEFAULT_SERPER_BASE).trim(),
    searchApiBase2: (process.env.SEARCH_API_BASE_2 || DEFAULT_TAVILY_BASE).trim(),
    // 号主改名（/ai 改名）：只存 {first}。号主定版：姓氏位只能是时钟时间，
    // 旧配置里存过的 last 一律忽略、不再读入。
    customName:
      json.customName && typeof json.customName === "object" && typeof json.customName.first === "string" && json.customName.first.trim()
        ? { first: json.customName.first.trim() }
        : null,
  };
}
