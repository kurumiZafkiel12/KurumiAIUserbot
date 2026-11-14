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
