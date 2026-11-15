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
      return true;
    }
    return false;
  }

  /**
   * 今天是否还能再用一次。
   * @param {Date} now
   */
  canUse(now = new Date()) {
    this.rolloverIfNeeded(now);
    if (this.limit <= 0) return true;
    return this.count < this.limit;
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
