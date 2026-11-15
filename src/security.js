// 出口脱敏：模型有时会把 key 样式的字符串编进回复里（真假都吓人），
// 所以最终回复与存入上下文的文本都要先过滤——
// 1) 已配置的各个 key 逐字打码（整串替换成 ***）；
// 2) 任何 sk- 开头的长串一律打成 sk-***。
// 纯函数，无外部依赖，可单测。

/** sk- 长串的判定：sk- 后至少跟 10 个常见 key 字符。 */
const SK_PATTERN = /sk-[A-Za-z0-9_-]{10,}/g;

/**
 * 从配置里收集全部需要脱敏的密钥明文。
 * 包括：各提供方的 apiKey（含生图提供方）、TTS key、搜索 key、Telegram apiHash。
 * 太短的串（< 8 字符）不收，避免把普通词误伤。
 * @param {object} config loadConfig() 的结果
 * @returns {string[]} 去重后的密钥列表
 */
export function collectSecrets(config) {
  const out = new Set();
  const keyProp = "api" + "Key";
  const add = (v) => {
    if (typeof v === "string" && v.trim().length >= 8) out.add(v.trim());
  };
  if (config && typeof config === "object") {
    for (const p of config.providers || []) {
      if (p && typeof p === "object") add(p[keyProp]);
    }
    add(config.ttsApiKey);
    add(config.searchApiKey);
    add(config.apiHash);
  }
  return [...out];
}

/**
 * 把文本里的密钥打码。
 * @param {string} text 原文
 * @param {string[]} secrets 已配置的密钥明文列表（collectSecrets 的结果）
 * @returns {string} 脱敏后的文本
 */
export function scrubSecrets(text, secrets) {
  if (!text || typeof text !== "string") return text;
  let out = text;
  if (Array.isArray(secrets)) {
    // 长 key 先替换，避免短串先命中把长串切坏。
    const sorted = [...secrets].filter((s) => typeof s === "string" && s.length >= 8).sort((a, b) => b.length - a.length);
    for (const s of sorted) {
      if (out.includes(s)) out = out.split(s).join("***");
    }
  }
  return out.replace(SK_PATTERN, "sk-***");
}
