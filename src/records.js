// 群聊天记录：开启记录的群里，所有消息都按群存进 records.json（环形，
// 每群最多留 maxPerGroup 条），回答该群问题时把最近 N 条拼成上下文注入，
// 让机器人知道大家刚才在聊什么。落盘容错仿 state.js：文件损坏按空启动，绝不抛错。

import fs from "node:fs";

const DEFAULT_MAX_PER_GROUP = 1000;

export class GroupRecords {
  /**
   * @param {string|null} filePath 持久化文件（如 records.json）；null 表示只用内存
   * @param {object} [options]
   * @param {number} [options.maxPerGroup] 每群最多保留的记录条数（环形截断）
   */
  constructor(filePath, options = {}) {
    this.path = filePath || null;
    this.maxPerGroup =
      Number.isFinite(options.maxPerGroup) && options.maxPerGroup > 0
        ? Math.floor(options.maxPerGroup)
        : DEFAULT_MAX_PER_GROUP;
    /** @type {Map<string, Array<{ts: string, name: string, senderId: string, text: string}>>} */
    this.groups = new Map();
    this._load();
  }

  _load() {
    if (!this.path) return;
    try {
      if (!fs.existsSync(this.path)) return;
      const raw = JSON.parse(fs.readFileSync(this.path, "utf-8"));
      if (!raw || typeof raw !== "object") return;
      for (const [chatId, list] of Object.entries(raw)) {
        if (!Array.isArray(list)) continue;
        const items = list
          .filter((it) => it && typeof it === "object" && typeof it.text === "string")
          .map((it) => ({
            ts: String(it.ts || ""),
            name: String(it.name || ""),
            senderId: String(it.senderId || ""),
            text: String(it.text),
          }));
        if (items.length > 0) this.groups.set(String(chatId), items.slice(-this.maxPerGroup));
      }
    } catch {
      // 文件损坏/不可读：按空记录启动，不要被坏文件锁死。
      this.groups.clear();
    }
  }

  _save() {
    if (!this.path) return;
    try {
      const obj = {};
      for (const [chatId, list] of this.groups) obj[chatId] = list;
      fs.writeFileSync(this.path, JSON.stringify(obj, null, 2) + "\n", "utf-8");
    } catch {
      // 写盘失败不抛错，记录退化为内存版。
    }
  }

  /**
   * 记一条群消息。空白文本不记。
   * @param {string|number} chatId
   * @param {{name?: string, senderId?: string|number, text: string, ts?: string}} entry
   * @returns {boolean} 是否记上了
   */
  record(chatId, entry) {
    const text = String((entry && entry.text) || "").replace(/\s+/g, " ").trim();
    if (!text) return false;
    const key = String(chatId);
    const list = this.groups.get(key) || [];
    list.push({
      ts: entry.ts || new Date().toISOString(),
      name: String(entry.name || ""),
      senderId: String(entry.senderId || ""),
      text,
    });
    while (list.length > this.maxPerGroup) list.shift();
    this.groups.set(key, list);
    this._save();
    return true;
  }

  /** 取某群最近 n 条记录（时间正序）。 */
  recent(chatId, n) {
    const list = this.groups.get(String(chatId)) || [];
    const count = Number.isFinite(n) && n > 0 ? Math.floor(n) : list.length;
    return list.slice(-count);
  }

  /** 有记录的群 ID 列表。 */
  chats() {
    return [...this.groups.keys()];
  }

  /** 某群已记录的条数。 */
  count(chatId) {
    return (this.groups.get(String(chatId)) || []).length;
  }

  /** 清掉某群的全部记录（关闭记录时不清，留着供查看；这个方法供测试/维护用）。 */
  clear(chatId) {
    const had = this.groups.delete(String(chatId));
    if (had) this._save();
    return had;
  }
}

/**
 * 把记录拼成注入模型的文本：一行一条「名字：内容」。
 * 只给名字不给数字 ID（给模型的文本里不出现用户 ID，是定版规矩）。
 * @param {Array<{name: string, text: string}>} items
 * @returns {string} 空记录返回空串
 */
export function renderRecords(items) {
  if (!Array.isArray(items) || items.length === 0) return "";
  return items.map((it) => `${it.name || "群友"}：${it.text}`).join("\n");
}
