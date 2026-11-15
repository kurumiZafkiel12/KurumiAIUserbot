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
        // 只打安全字段（名字/地址/缺失字段名）：def 里带 apiKey，整体序列化会把 key 写进日志，
        // 日志文件又能被 /ai 日志 导出，等于凭证外泄（审计 K062-05）。
        const missing = ["name", "baseURL", "model"].filter((f) => !def || !def[f]);
        logger.warn(
          `跳过配置不完整的提供方：name=${(def && def.name) || "(未填)"}，baseURL=${(def && def.baseURL) || "(未填)"}，缺少字段：${missing.join("/") || "未知"}`,
        );
        continue;
      }
      const keyProp = "api" + "Key";
      this.entries.push({
        name: def.name,
        model: def.model,
        baseURL: def.baseURL,
        image: def.image === true, // 生图提供方（/ai 加生图api）：不进聊天池，只用来生图
        disabled: def.disabled === true, // 被号主禁用（/ai 禁用api）：不参与挑选
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

  /** 按名字查提供方（按名取默认提供方用）。 */
  getByName(name) {
    return this.entries.find((e) => e.name === name) || null;
  }

  /** 当前可用的聊天提供方（未被禁用、不是生图提供方、未超每日限额、不在冷却、且不在排除名单里）。 */
  available(exclude = new Set(), now = Date.now()) {
    return this.entries.filter(
      (e) =>
        !e.disabled &&
        !e.image &&
        !exclude.has(e.name) &&
        e.cooldownUntil <= now &&
        e.counter.canUse(new Date(now)),
    );
  }

  /** 全部聊天提供方（不含生图提供方），含被禁用的（编号列表/选择用）。 */
  chatEntries() {
    return this.entries.filter((e) => !e.image);
  }

  /** 第一个可用的生图提供方（未禁用、未超限额、不在冷却）；没有返回 null。 */
  firstImageProvider(now = Date.now()) {
    return (
      this.entries.find(
        (e) => e.image && !e.disabled && e.cooldownUntil <= now && e.counter.canUse(new Date(now)),
      ) || null
    );
  }

  /** 还在启用状态的聊天提供方个数（禁用命令判断「是不是最后一个」用；生图提供方不算）。 */
  enabledCount() {
    return this.entries.filter((e) => !e.disabled && !e.image).length;
  }

  /**
   * 加权挑选一个提供方。挑中即同步预留一个每日名额（见 DailyCounter.reserve），
   * 并发请求在同一 tick 后再选路时就看得到占用，杜绝突破每日上限（审计 K062-04）。
   * 调用方必须用 markSuccess/markFailure 结算这次预留。
   * @param {Set<string>} exclude 已尝试过、本轮排除的名字
   * @param {string|null} preferred 优先尝试的名字（默认提供方）；不可用时回退到加权挑选
   */
  pick(exclude = new Set(), preferred = null, now = Date.now()) {
    let chosen = null;
    if (preferred) {
      const p = this.getByName(preferred);
      if (
        p &&
        !p.disabled &&
        !p.image &&
        !exclude.has(p.name) &&
        p.cooldownUntil <= now &&
        p.counter.canUse(new Date(now))
      ) {
        chosen = p;
      }
    }
    if (!chosen) {
      const candidates = this.available(exclude, now);
      if (candidates.length === 0) return null;
      const total = candidates.reduce((sum, e) => sum + e.weight, 0);
      let r = Math.random() * total;
      chosen = candidates[candidates.length - 1];
      for (const e of candidates) {
        r -= e.weight;
        if (r <= 0) {
          chosen = e;
          break;
        }
      }
    }
    // 同步预留：canUse 刚验过，正常必成功；万一失败（如并发已占满）按无可用处理。
    if (!chosen.counter.reserve(new Date(now))) return null;
    return chosen;
  }

  /**
   * 为不用 pick 的选路（识图按池挑条目、生图取第一个）预留一个名额：
   * 同时检查禁用、失败冷却与每日限额（在途预留也算），与聊天同一套闸门（审计 K062-03）。
   * @returns {boolean} 是否预留成功；成功后须用 markSuccess/markFailure/release 结算
   */
  reserve(entry, now = Date.now()) {
    if (!entry || entry.disabled) return false;
    if (entry.cooldownUntil > now) return false;
    return entry.counter.reserve(new Date(now));
  }

  /** 释放一次预留（不计用量、不进冷却）：生图失败等不走 markFailure 的路径用。 */
  release(entry) {
    if (entry) entry.counter.release();
  }

  /** 结算一次成功调用：把预留转成正式每日用量。 */
  markSuccess(entry) {
    entry.counter.commit();
    entry.lastError = "";
  }

  /** 记一次失败：释放预留（失败不计用量），进入冷却期，并把错误留给日志/报告。 */
  markFailure(entry, err) {
    entry.counter.release();
    entry.cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS;
    entry.lastError = err && err.message ? err.message : String(err);
    this.logger.warn(`提供方 ${entry.name} 调用失败，进入 ${FAILURE_COOLDOWN_MS / 1000}s 冷却：${entry.lastError}`);
  }

  /**
   * 从旧池继承运行状态（热重载重建池时用，审计 K062-02）：
   * 按提供方名把今日已用计数与未到期的失败冷却继承过来，新池的额度不被清零。
   * 限额本身以新配置为准（DailyCounter.inheritFrom 只搬 count）。
   */
  inheritStateFrom(oldPool) {
    if (!oldPool || !Array.isArray(oldPool.entries)) return;
    for (const entry of this.entries) {
      const old = oldPool.entries.find((e) => e.name === entry.name);
      if (!old) continue;
      entry.counter.inheritFrom(old.counter);
      if (old.cooldownUntil > entry.cooldownUntil) entry.cooldownUntil = old.cooldownUntil;
      if (old.lastError) entry.lastError = old.lastError;
    }
  }

  /**
   * 发起一次流式对话。onToken 每来一段文本就回调（完整累计文本），由调用方节流刷新消息。
   * onUsage 可选：拿到流末尾的 usage（token 统计）时回调一次。
   * 带 stream_options.include_usage 请求 usage；有的接口不认这个选项会直接报错——
   * 只在「还没产出任何文本」时才去掉选项重试一次，绝不重复吐字。
   * @returns {Promise<string>} 完整回复文本
   */
  async chat(entry, messages, onToken, onUsage) {
    const attempt = async (withUsageOption) => {
      const params = { model: entry.model, messages, stream: true };
      if (withUsageOption) params.stream_options = { include_usage: true };
      const stream = await entry.client.chat.completions.create(params);
      let full = "";
      let produced = false;
      let usage = null;
      try {
        for await (const chunk of stream) {
          if (chunk && chunk.usage) usage = chunk.usage;
          const delta = chunk?.choices?.[0]?.delta?.content || "";
          if (delta) {
            produced = true;
            full += delta;
            if (onToken) onToken(full);
          }
        }
      } catch (err) {
        // 已吐过字再断流不能重试（会重复发内容），把 produced 标记带出去让外层决定。
        err.producedPartial = produced;
        throw err;
      }
      if (!full.trim()) throw new Error("模型返回了空内容");
      if (usage && onUsage) {
        try {
          onUsage(usage);
        } catch {
          // 统计回调出错不影响回答本身。
        }
      }
      return full;
    };

    try {
      return await attempt(true);
    } catch (err) {
      if (err && err.producedPartial) throw err;
      // 还没产出任何文本：多半是接口不认 stream_options，去掉选项重试一次。
      return attempt(false);
    }
  }

  /**
   * 识图调用：用条目的连接、以指定模型名发一次带图请求（非流式）。
   * messages 里的 user 内容是 [{type:"text",...},{type:"image_url",...}] 形式。
   * @returns {Promise<string>} 回复文本；usage 经 onUsage 回调带出（接口给的话）
   */
  async visionChat(entry, model, messages, onUsage) {
    const res = await entry.client.chat.completions.create({ model, messages, stream: false });
    const text = (res && res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content) || "";
    if (!String(text).trim()) throw new Error("识图模型返回了空内容");
    if (res.usage && onUsage) {
      try {
        onUsage(res.usage);
      } catch {
        // 统计回调出错不影响回答本身。
      }
    }
    return String(text);
  }

  /** 用量报告（号主命令用）。 */
  usageReport() {
    const lines = this.entries.map((e) => {
      const s = e.counter.snapshot();
      const limitText = s.limit > 0 ? `${s.count}/${s.limit}` : `${s.count}/不限`;
      const cooling = e.cooldownUntil > Date.now() ? "（冷却中）" : "";
      const off = e.disabled ? "（已禁用）" : "";
      const img = e.image ? "（生图）" : "";
      return `- ${e.name}（${e.model}）：今日 ${limitText}${cooling}${off}${img}`;
    });
    return lines.join("\n");
  }
}
