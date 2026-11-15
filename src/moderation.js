// 内容门禁的纯逻辑：代码关键词命中、屏蔽群/屏蔽词判定、参数尖括号剥除。
// 无外部依赖，方便单元测试；真正的计数、拉黑、静默动作在 handlers 里做。

/**
 * 在问题里找命中的关键词（不区分大小写的子串匹配）。
 * @param {string} text 问题全文
 * @param {string[]} keywords 关键词列表
 * @returns {string|null} 命中的第一个关键词；没命中返回 null
 */
export function findKeyword(text, keywords) {
  if (!text || typeof text !== "string" || !Array.isArray(keywords)) return null;
  const lower = text.toLowerCase();
  for (const word of keywords) {
    const w = String(word || "").trim();
    if (w && lower.includes(w.toLowerCase())) return w;
  }
  return null;
}

/**
 * 屏蔽判定：会话在屏蔽群名单里，且问题命中任一屏蔽词，才算要拦。
 * 群 ID 按字符串精确比较（Telegram 群 ID 形如 -1001234567890，存的时候什么样就按什么样比）。
 * @param {string|number} chatId
 * @param {string} text 问题全文
 * @param {string[]} groups 屏蔽群 ID 列表
 * @param {string[]} keywords 屏蔽词列表
 */
export function isSensitiveBlocked(chatId, text, groups, keywords) {
  if (!Array.isArray(groups) || groups.length === 0) return false;
  const id = String(chatId ?? "");
  if (!groups.map(String).includes(id)) return false;
  return findKeyword(text, keywords) !== null;
}

/**
 * 剥掉参数外层的一对尖括号：帮助里把参数写成 <用户ID> 是占位符说明，
 * 用户常把尖括号一起打进来（如「/ai 拉黑 <12345>」），入口统一在这里剥掉。
 * 只剥最外层恰好成对的一对；文本中间的尖括号不动。
 * @param {string} value
 * @returns {string}
 */
export function unwrapArg(value) {
  if (typeof value !== "string") return value;
  const t = value.trim();
  if (t.length >= 2 && t.startsWith("<") && t.endsWith(">")) {
    return t.slice(1, -1).trim();
  }
  return t;
}
