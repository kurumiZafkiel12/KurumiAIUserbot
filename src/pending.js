// 两步选择框架的待办状态：号主发「（再回 <序号>）」类命令后，先登记一条 pending，
// 号主在同一会话里单独回一个数字（或换key 时回全文）才真正执行。
// 纯内存实现（进程重启即失效，符合「60 秒内回」的短时语义），逻辑可单测。

export const PENDING_TTL_MS = 60_000;

export class PendingSelections {
  /**
   * @param {object} [options]
   * @param {number} [options.ttlMs] 每条 pending 的存活毫秒数，默认 60 秒
   * @param {() => number} [options.nowFn] 取当前时间戳的函数（测试注入用）
   */
  constructor(options = {}) {
    this.ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : PENDING_TTL_MS;
    this.nowFn = typeof options.nowFn === "function" ? options.nowFn : () => Date.now();
    /** @type {Map<string, object>} key -> { kind, step, providerName, expiresAt } */
    this.map = new Map();
  }

  _key(chatId, senderId) {
    return `${chatId}:${senderId}`;
  }

  /**
   * 登记一条 pending（同会话同号主已有 pending 时直接覆盖）。
   * @param {object} entry { kind, step?, providerName? }，expiresAt 由内部按 ttl 计算
   * @returns {object} 存入的条目（含 expiresAt）
   */
  set(chatId, senderId, entry) {
    const stored = { step: 1, providerName: null, ...entry, expiresAt: this.nowFn() + this.ttlMs };
    this.map.set(this._key(chatId, senderId), stored);
    return stored;
  }

  /**
   * 查看某会话某号主的 pending，不删除。
   * @returns {null | { entry: object, expired: boolean }} 没有返回 null；
   *   有但已过期时 entry 照样返回并标 expired=true，调用方据此回「已超时」。
   */
  peek(chatId, senderId) {
    const entry = this.map.get(this._key(chatId, senderId));
    if (!entry) return null;
    return { entry, expired: this.nowFn() > entry.expiresAt };
  }

  /** 取出并删除（消费）。没有返回 null。 */
  consume(chatId, senderId) {
    const key = this._key(chatId, senderId);
    const entry = this.map.get(key);
    if (!entry) return null;
    this.map.delete(key);
    return entry;
  }

  /** 直接清掉某会话某号主的 pending（发新命令时用）。 */
  clear(chatId, senderId) {
    this.map.delete(this._key(chatId, senderId));
  }
}
