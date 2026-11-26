// 模型提供方池：多个 OpenAI 兼容接口统一管理。
// - 按权重随机挑选（权重越高越常被选）
// - 每个提供方有独立的每日用量计数（DailyCounter，跨天自动清零）
// - 调用失败后进入冷却期，冷却内不参与挑选；处理层会依次尝试下一个提供方

import OpenAI from "openai";
import { DailyCounter } from "./limits.js";

const FAILURE_COOLDOWN_MS = 30_000;

/**
 * 展示用模型名：剥掉中转站的渠道前缀（[满血F]、[premium]、[次]、[官逆B] 这类
 * 方括号标签），只留模型本体名。回复末尾标注模型时用——号主只要名字，不要渠道。
 */
export function displayModelName(model) {
  let s = String(model || "").trim();
  while (/^\[[^\]]{1,24}\]/.test(s)) s = s.replace(/^\[[^\]]{1,24}\]\s*/, "").trim();
  return s;
}
// 单次回复的输出 token 上限：没有上限时「从1数到10000」这类请求会一直生成到模型
// 自身的硬顶，烧 token、刷屏、还污染上下文（2026-11-24 hyw 群实测）。4096 足够覆盖
// 正常长答；接口不认 max_tokens 时 chat/visionChat 都会去掉它重试一次。
const CHAT_MAX_OUTPUT_TOKENS = 4096;

/**
 * 临时 API 客户端：加识图api 时提供方还没存进池子，先拿 baseURL+key 造一个
 * 查它的模型列表、拿测试图实测。构造方式与池内条目一致。
 */
export function createApiClient(baseURL, apiKeyValue) {
  return new OpenAI({ ["api" + "Key"]: apiKeyValue || "not-needed", baseURL });
}

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
        modelAuto: def.modelAuto === true, // 模型名是启动时自动识别的（/ai 状态里标出来）
        baseURL: def.baseURL,
        image: def.image === true, // 生图提供方（/ai 加生图api）：不进聊天池，只用来生图
        vision: def.vision === true, // 识图专用提供方（/ai 加识图api）：不进聊天池，只用来识图
        disabled: def.disabled === true, // 被号主禁用（/ai 禁用api）：不参与挑选
        weight: Number.isFinite(def.weight) && def.weight > 0 ? def.weight : 1,
        client: new OpenAI({ [keyProp]: def[keyProp] || "not-needed", baseURL: def.baseURL }),
        counter: new DailyCounter(def.dailyLimit || 0),
        cooldownUntil: 0, // 时间戳（ms），在此之前不参与挑选
        lastError: "",
      });
    }
    if (this.entries.length === 0) {
      throw new Error("没有任何可用的模型提供方：请至少在 .env 里填好 AI_API_BASE（模型名可留空，启动时自动识别；或在 config.json 配置 customProviders）。");
    }
  }

  /** 按名字查提供方（按名取默认提供方用）。 */
  getByName(name) {
    return this.entries.find((e) => e.name === name) || null;
  }

  /** 当前可用的聊天提供方（未被禁用、不是生图/识图专用提供方、未超每日限额、不在冷却、且不在排除名单里）。 */
  available(exclude = new Set(), now = Date.now()) {
    return this.entries.filter(
      (e) =>
        !e.disabled &&
        !e.image &&
        !e.vision &&
        !exclude.has(e.name) &&
        e.cooldownUntil <= now &&
        e.counter.canUse(new Date(now)),
    );
  }

  /** 全部聊天提供方（不含生图/识图专用提供方），含被禁用的（编号列表/选择用）。 */
  chatEntries() {
    return this.entries.filter((e) => !e.image && !e.vision);
  }

  /** 第一个可用的生图提供方（未禁用、未超限额、不在冷却）；没有返回 null。 */
  firstImageProvider(now = Date.now()) {
    return (
      this.entries.find(
        (e) => e.image && !e.disabled && e.cooldownUntil <= now && e.counter.canUse(new Date(now)),
      ) || null
    );
  }

  /** 还在启用状态的聊天提供方个数（禁用命令判断「是不是最后一个」用；生图/识图专用提供方不算）。 */
  enabledCount() {
    return this.entries.filter((e) => !e.disabled && !e.image && !e.vision).length;
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
        !p.vision &&
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
    entry.lastError = err && err.message ? err.message : String(err);
    // 内容风控类拒绝（如 DeepSeek 的 400 Content Exists Risk）是这一条请求被拒、
    // 不是提供方故障：进冷却会让唯一的提供方停摆 30 秒，旁人的正常消息跟着吃
    // 「所有模型都暂时不可用」（2026-11-24 hyw 群实测），故这类只记错误、不冷却。
    if (/content exists risk|content[_ ]?risk|moderation|content policy/i.test(entry.lastError)) {
      this.logger.warn(`提供方 ${entry.name} 调用被内容风控拒绝（不进冷却）：${entry.lastError}`);
      return;
    }
    entry.cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS;
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
    const attempt = async (withUsageOption, withCap = true) => {
      const params = { model: entry.model, messages, stream: true };
      if (withCap) params.max_tokens = CHAT_MAX_OUTPUT_TOKENS;
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
      try {
        return await attempt(false);
      } catch (err2) {
        // 仍失败且像是接口不认 max_tokens：去掉输出上限再试一次（同样只限没吐过字）。
        if (err2 && !err2.producedPartial && /max_tokens|max_completion_tokens/i.test(err2.message || "")) {
          return attempt(false, false);
        }
        throw err2;
      }
    }
  }

  /**
   * 识图调用：用条目的连接、以指定模型名发一次带图请求（非流式）。
   * messages 里的 user 内容是 [{type:"text",...},{type:"image_url",...}] 形式。
   * @returns {Promise<string>} 回复文本；usage 经 onUsage 回调带出（接口给的话）
   */
  async visionChat(entry, model, messages, onUsage) {
    let res;
    try {
      res = await entry.client.chat.completions.create({ model, messages, stream: false, max_tokens: CHAT_MAX_OUTPUT_TOKENS });
    } catch (err) {
      // 接口不认 max_tokens 时去掉上限重试一次（同 chat 的理由）。
      if (!/max_tokens|max_completion_tokens/i.test((err && err.message) || "")) throw err;
      res = await entry.client.chat.completions.create({ model, messages, stream: false });
    }
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
      const img = e.image ? "（生图）" : e.vision ? "（识图）" : "";
      return `- ${e.name}（${e.model}${e.modelAuto ? "，自动识别" : ""}）：今日 ${limitText}${cooling}${off}${img}`;
    });
    return lines.join("\n");
  }
}
