// 每日用量计数：按本地日期切分，跨天自动清零。
// 这是一个无外部依赖的纯逻辑模块，方便单元测试。
// 注意：所有计数状态都在类内部明确声明并初始化——
// 绝不要在别处引用未定义的计数变量（同类项目曾因此在“答案已生成、发送前”崩溃）。

/**
 * 把日期格式化成 YYYY-MM-DD（本地时区），作为“今天”的键。
 * @param {Date} date
 * @returns {string}
 */
export function todayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export class DailyCounter {
  /**
   * @param {number} limit 每日上限；0 或负数表示不限量
   */
  constructor(limit = 0) {
    this.limit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
    this.day = todayKey();
    this.count = 0;
    /** 已预留未结算的名额（选路时同步占位，防并发突破上限，审计 K062-04）。 */
    this.reserved = 0;
  }

  /**
   * 如果日期已跨天，清零计数。返回是否发生了清零。
   * @param {Date} now
   */
  rolloverIfNeeded(now = new Date()) {
    const key = todayKey(now);
    if (key !== this.day) {
      this.day = key;
      this.count = 0;
      this.reserved = 0;
      return true;
    }
    return false;
  }

  /**
   * 今天是否还能再用一次（已用 + 在途预留 一起算）。
   * @param {Date} now
   */
  canUse(now = new Date()) {
    this.rolloverIfNeeded(now);
    if (this.limit <= 0) return true;
    return this.count + this.reserved < this.limit;
  }

  /**
   * 记一次用量，返回记完后的今日计数。
   * @param {Date} now
   */
  record(now = new Date()) {
    this.rolloverIfNeeded(now);
    this.count += 1;
    return this.count;
  }

  /**
   * 同步预留一个名额：选路时调用，同一 tick 内立即生效，
   * 并发请求再来选路时 canUse 会把在途预留算进去，杜绝 check-then-act 竞态。
   * @returns {boolean} 预留成功（额度够）与否
   */
  reserve(now = new Date()) {
    this.rolloverIfNeeded(now);
    if (this.limit > 0 && this.count + this.reserved >= this.limit) return false;
    this.reserved += 1;
    return true;
  }

  /** 结算一次预留为正式用量（调用成功时）。没有在途预留时等同 record（兼容直接结算的调用方）。 */
  commit(now = new Date()) {
    this.rolloverIfNeeded(now);
    if (this.reserved > 0) this.reserved -= 1;
    this.count += 1;
    return this.count;
  }

  /** 释放一次预留（调用失败时）：不计用量、不留痕。 */
  release(now = new Date()) {
    this.rolloverIfNeeded(now);
    if (this.reserved > 0) this.reserved -= 1;
  }

  /**
   * 从另一个计数器继承今日已用数（热重载重建提供方池时保留额度，审计 K062-02）。
   * 只继承同一天的 count；在途预留不继承（在途请求会各自在旧条目上结算）。
   */
  inheritFrom(other, now = new Date()) {
    if (!other) return;
    this.rolloverIfNeeded(now);
    if (other.day === this.day) {
      this.count = other.count;
    }
  }

  /**
   * 今天剩余可用次数；不限量时返回 Infinity。
   * @param {Date} now
   */
  remaining(now = new Date()) {
    this.rolloverIfNeeded(now);
    if (this.limit <= 0) return Infinity;
    return Math.max(0, this.limit - this.count);
  }

  /** 当前状态快照（用于用量报告）。 */
  snapshot(now = new Date()) {
    this.rolloverIfNeeded(now);
    return { day: this.day, count: this.count, limit: this.limit };
  }
}

/** 限速递增阶梯（分钟）：每被成功回答一次，冷却按这个表往上走，封顶最后一档。 */
export const SLOWDOWN_STAGES_MINUTES = [5, 10, 30, 60];

/**
 * 递增限速跟踪：名单管理在 handlers/config 那边，这里只管「冷却到什么时候」。
 * 语义：被限速的用户每次被成功回答后，进入一段冷却；冷却时长按
 * 5 → 10 → 30 → 60 分钟递增，封顶 60。冷却内再问的一律由调用方静默忽略。
 * 纯内存（重启后冷却清零，名单本身落盘在 config 里，不受影响）。
 */
export class SlowdownTracker {
  constructor() {
    /** @type {Map<string, {stage: number, blockedUntil: number}>} */
    this.users = new Map();
  }

  /** 这个用户现在是不是还在冷却里。 */
  isBlocked(userId, now = Date.now()) {
    const rec = this.users.get(String(userId));
    if (!rec) return false;
    return rec.blockedUntil > now;
  }

  /**
   * 记一次成功回答：进入下一档冷却。
   * @returns {number} 本次冷却的分钟数
   */
  recordAnswer(userId, now = Date.now()) {
    const id = String(userId);
    const rec = this.users.get(id) || { stage: 0, blockedUntil: 0 };
    const minutes = SLOWDOWN_STAGES_MINUTES[Math.min(rec.stage, SLOWDOWN_STAGES_MINUTES.length - 1)];
    rec.blockedUntil = now + minutes * 60_000;
    rec.stage = Math.min(rec.stage + 1, SLOWDOWN_STAGES_MINUTES.length - 1);
    this.users.set(id, rec);
    return minutes;
  }

  /** 清掉某个用户的冷却与档位（解除限速时用）。 */
  reset(userId) {
    this.users.delete(String(userId));
  }
}
