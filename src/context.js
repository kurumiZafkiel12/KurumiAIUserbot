// 对话上下文：按「会话 + 用户」分别保存最近若干条消息，超长自动截断。

export class ConversationStore {
  /**
   * @param {number} maxMessages 每组最多保留的消息条数（user 与 assistant 合计）
   */
  constructor(maxMessages = 20) {
    this.maxMessages = maxMessages > 0 ? Math.floor(maxMessages) : 20;
    /** @type {Map<string, Array<{role: string, content: string}>>} */
    this.store = new Map();
  }

  key(chatId, userId) {
    return `${chatId}:${userId}`;
  }

  /** 取一段历史的副本（不含 system）。 */
  get(chatId, userId) {
    const list = this.store.get(this.key(chatId, userId));
    return list ? [...list] : [];
  }

  /** 追加一条消息并截断到上限。 */
  push(chatId, userId, role, content) {
    const k = this.key(chatId, userId);
    const list = this.store.get(k) || [];
    list.push({ role, content });
    while (list.length > this.maxMessages) list.shift();
    this.store.set(k, list);
  }

  /** 清空某一组上下文，返回是否原本有内容。 */
  clear(chatId, userId) {
    return this.store.delete(this.key(chatId, userId));
  }

  /** 清空全部上下文（号主命令用）。 */
  clearAll() {
    const n = this.store.size;
    this.store.clear();
    return n;
  }
}
