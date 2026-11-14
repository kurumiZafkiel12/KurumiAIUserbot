// 配置加载：.env（必填项） + config.json（可选，多模型/触发词绑定/限额等）。
// config.json 的字段详解见 docs/CONFIG.md。

import fs from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { DEFAULT_PROVIDER } from "./triggers.js";

loadDotenv();

const CONFIG_PATH = path.resolve("config.json");

const DEFAULT_SYSTEM_PROMPT =
  "你是一个友好的 AI 助手，在 Telegram 里回答问题。回答简洁、准确，用提问者的语言回复。";

function readConfigJson() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch (err) {
    throw new Error(`config.json 解析失败：${err.message}。请检查 JSON 格式，或删掉该文件只用 .env 运行。`);
  }
}

/** 把运行期产生的配置（目前是黑名单）合并写回 config.json。 */
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

/**
 * 加载全部配置。缺少必填项时抛出带中文说明的错误，由入口打印后退出。
 */
export function loadConfig() {
  const apiIdRaw = (process.env.TELEGRAM_API_ID || "").trim();
  const apiHash = (process.env.TELEGRAM_API_HASH || "").trim();

  if (!apiIdRaw || !apiHash) {
    throw new Error(
      "缺少 Telegram 应用凭证：请在 .env 里填写 TELEGRAM_API_ID 和 TELEGRAM_API_HASH。\n" +
        "申请方法：打开 https://my.telegram.org → API development tools → 创建应用后即可看到 api_id 与 api_hash（详见 README 教程）。",
    );
  }
  const apiId = Number.parseInt(apiIdRaw, 10);
  if (!Number.isFinite(apiId) || apiId <= 0) {
    throw new Error(`TELEGRAM_API_ID 格式不对：应是纯数字，当前填的是 “${apiIdRaw}”。`);
  }

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

  const triggerMap =
    json.triggerMap && typeof json.triggerMap === "object" ? { ...json.triggerMap } : {};

  return {
    apiId,
    apiHash,
    myUsername: (process.env.MY_USERNAME || "").trim().replace(/^@/, ""),
    ownerId: (process.env.OWNER_ID || "").trim(),
    timezone: (process.env.TIMEZONE || "Asia/Shanghai").trim(),
    namePrefix: (process.env.NAME_PREFIX || "GPT").trim(),
    nameClock: envBool(process.env.NAME_CLOCK, true),

    systemPrompt: typeof json.systemPrompt === "string" && json.systemPrompt ? json.systemPrompt : DEFAULT_SYSTEM_PROMPT,
    contextSize: Number.isFinite(json.contextSize) && json.contextSize > 0 ? Math.floor(json.contextSize) : 20,
    cooldownSeconds:
      Number.isFinite(json.cooldownSeconds) && json.cooldownSeconds >= 0 ? Number(json.cooldownSeconds) : 5,

    providers,
    triggerMap,
    blacklist: Array.isArray(json.blacklist) ? json.blacklist.map(String) : [],
  };
}
