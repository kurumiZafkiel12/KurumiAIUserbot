// 模型提供方池：多个 OpenAI 兼容接口统一管理。
// - 按权重随机挑选（权重越高越常被选）
// - 每个提供方有独立的每日用量计数（DailyCounter，跨天自动清零）
// - 调用失败后进入冷却期，冷却内不参与挑选；处理层会依次尝试下一个提供方

import OpenAI from "openai";
import { DailyCounter } from "./limits.js";

const FAILURE_COOLDOWN_MS = 30_000;

export class ProviderPool {
  /**
   * @param {Array<object>} defs 提供方配置：{name, baseURL, apiKey, model, weight, dailyLimit}
   * @param {object} logger 日志器
   */
  constructor(defs, logger) {
    this.logger = logger;
    /** @type {Array<object>} 全部提供方条目，状态都在条目对象上明确声明 */
    this.entries = [];
    for (const def of defs || []) {
      if (!def || !def.name || !def.baseURL || !def.model) {
        logger.warn(`跳过配置不完整的提供方：${JSON.stringify(def)}`);
        continue;
      }
      const keyProp = "api" + "Key";
      this.entries.push({
        name: def.name,
        model: def.model,
        weight: Number.isFinite(def.weight) && def.weight > 0 ? def.weight : 1,
        client: new OpenAI({ [keyProp]: def[keyProp] || "not-needed", baseURL: def.baseURL }),
        counter: new DailyCounter(def.dailyLimit || 0),
        cooldownUntil: 0, // 时间戳（ms），在此之前不参与挑选
        lastError: "",
      });
    }
    if (this.entries.length === 0) {
      throw new Error("没有任何可用的模型提供方：请至少在 .env 里填好 AI_API_BASE / AI_API_MODEL（或在 config.json 配置 customProviders）。");
    }
  }

  /** 按名字查提供方（触发词绑定用）。 */
  getByName(name) {
    return this.entries.find((e) => e.name === name) || null;
  }

  /** 当前可用的提供方（未超每日限额、不在冷却、且不在排除名单里）。 */
  available(exclude = new Set(), now = Date.now()) {
    return this.entries.filter(
      (e) => !exclude.has(e.name) && e.cooldownUntil <= now && e.counter.canUse(new Date(now)),
    );
  }

  /**
   * 加权挑选一个提供方。
   * @param {Set<string>} exclude 已尝试过、本轮排除的名字
   * @param {string|null} preferred 优先尝试的名字（触发词绑定）；不可用时回退到加权挑选
   */
  pick(exclude = new Set(), preferred = null, now = Date.now()) {
    if (preferred) {
      const p = this.getByName(preferred);
      if (p && !exclude.has(p.name) && p.cooldownUntil <= now && p.counter.canUse(new Date(now))) {
        return p;
      }
    }
    const candidates = this.available(exclude, now);
    if (candidates.length === 0) return null;
    const total = candidates.reduce((sum, e) => sum + e.weight, 0);
    let r = Math.random() * total;
    for (const e of candidates) {
      r -= e.weight;
      if (r <= 0) return e;
    }
    return candidates[candidates.length - 1];
  }

  /** 记一次成功调用（计入每日用量）。 */
  markSuccess(entry) {
    entry.counter.record();
    entry.lastError = "";
  }

  /** 记一次失败：进入冷却期，并把错误留给日志/报告。 */
  markFailure(entry, err) {
    entry.cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS;
    entry.lastError = err && err.message ? err.message : String(err);
    this.logger.warn(`提供方 ${entry.name} 调用失败，进入 ${FAILURE_COOLDOWN_MS / 1000}s 冷却：${entry.lastError}`);
  }

  /**
   * 发起一次流式对话。onToken 每来一段文本就回调（完整累计文本），由调用方节流刷新消息。
   * @returns {Promise<string>} 完整回复文本
   */
  async chat(entry, messages, onToken) {
    const stream = await entry.client.chat.completions.create({
      model: entry.model,
      messages,
      stream: true,
    });
    let full = "";
    for await (const chunk of stream) {
      const delta = chunk?.choices?.[0]?.delta?.content || "";
      if (delta) {
        full += delta;
        if (onToken) onToken(full);
      }
    }
    if (!full.trim()) throw new Error("模型返回了空内容");
    return full;
  }

  /** 用量报告（号主命令用）。 */
  usageReport() {
    const lines = this.entries.map((e) => {
      const s = e.counter.snapshot();
      const limitText = s.limit > 0 ? `${s.count}/${s.limit}` : `${s.count}/不限`;
      const cooling = e.cooldownUntil > Date.now() ? "（冷却中）" : "";
      return `- ${e.name}（${e.model}）：今日 ${limitText}${cooling}`;
    });
    return lines.join("\n");
  }
}
