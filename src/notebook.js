// 事实记事本：按会话（chatId）保存一份「值得长期记住的事」的清单。
// 滚动上下文只有最近若干条，聊过的事很快被冲掉；记事本跨重启持久化，
// 每轮组装系统提示时把当前会话的记事本注入给模型，让它「记得住事」。
//
// 设计约定：
// - 每条事实是一句简短的话，尽量带归属（如「小明：喜欢吃辣」「小明说下周去东京」），
//   它们是「某人说过的话」的记录，不等于已核实的真理。
// - 机器人自己的言行不入册：以机器人为主语的条目一律过滤（botNames 命中）。
// - 每会话上限 maxPerChat（默认 25）条，超了丢最旧的。
// - 持久化到构造时传入的 JSON 文件；文件不存在/内容损坏都按空记事本处理，绝不抛错。

import fs from "node:fs";

// 内置的机器人自称：条目以这些词作主语（后跟冒号）时视为「机器人自己的事」，过滤掉。
const DEFAULT_SELF_NAMES = ["机器人", "助手", "AI", "ai"];

/** 规范化会话 key：统一成字符串。 */
function normChatId(chatId) {
  if (chatId === undefined || chatId === null) return "";
  return String(chatId);
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 这条事实是不是「以机器人自己为主语」。
 * 判据：文本以某个机器人名字开头且紧跟冒号（中英文冒号都算），如「大肥鱼：今天吃了饭」。
 * @param {string} text 已清洗的事实文本
 * @param {string[]} selfNames 机器人名字列表（构造 Notebook 时合并传入的名字与内置自称）
 */
export function isSelfFact(text, selfNames = DEFAULT_SELF_NAMES) {
  const t = String(text || "").trim();
  if (!t) return false;
  for (const name of selfNames || []) {
    const n = String(name || "").trim();
    if (!n) continue;
    if (new RegExp(`^${escapeRegExp(n)}\\s*[：:]`).test(t)) return true;
  }
  return false;
}

/**
 * 清洗一条事实文本：剥掉行首的项目符号（-、·、•、*）与空白。
 * 返回空字符串表示这行没内容（空行、纯符号行）。
 */
export function cleanFactLine(line) {
  let t = String(line ?? "").trim();
  // 反复剥：模型输出偶尔会写成「- - 事实」这种叠符号。
  for (;;) {
    const next = t.replace(/^[-·•*]\s*/, "").trim();
    if (next === t) break;
    t = next;
  }
  return t;
}

/**
 * 把一批原始行清洗成合格的事实列表：去空行、过滤机器人自述条目、去重、截断到上限。
 * 纯函数，可单测。
 * @returns {string[]} 清洗后的事实（保持输入顺序）
 */
export function sanitizeFacts(lines, { max = 25, selfNames = DEFAULT_SELF_NAMES } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(lines) ? lines : []) {
    const t = cleanFactLine(raw);
    if (!t) continue;
    if (isSelfFact(t, selfNames)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : 25;
  return out.length > cap ? out.slice(out.length - cap) : out;
}

export class Notebook {
  /**
   * @param {string|null} filePath 持久化文件路径（如 facts.json）；null 表示只用内存不落盘
   * @param {object} [options] { maxPerChat = 25, botNames = [] } botNames 是机器人自己的名字/称呼，
   *   用于过滤「以机器人为主语」的条目（会与内置自称合并）
   */
  constructor(filePath, options = {}) {
    this.path = filePath || null;
    this.maxPerChat =
      Number.isFinite(options.maxPerChat) && options.maxPerChat > 0
        ? Math.floor(options.maxPerChat)
        : 25;
    const extra = Array.isArray(options.botNames) ? options.botNames : [];
    this.selfNames = [...new Set([...extra.map((s) => String(s).trim()).filter(Boolean), ...DEFAULT_SELF_NAMES])];
    /** @type {Map<string, string[]>} chatId -> 事实列表 */
    this.chats = new Map();
    /**
     * @type {Map<string, number>} 每会话的版本号：任何实际变更（加/替换/删/清空）都 +1。
     * 后台整理任务开始时记下版本、回写前比对，变了就丢弃本次结果——防整理拿着旧快照
     * 把用户刚清空/修改的内容又恢复出来（审计 K062-12）。版本只存内存、不落盘。
     */
    this.versions = new Map();
    this._load();
  }

  /** 某会话记事本的当前版本号（从未变更过为 0）。 */
  version(chatId) {
    return this.versions.get(normChatId(chatId)) || 0;
  }

  _bumpVersion(id) {
    this.versions.set(id, (this.versions.get(id) || 0) + 1);
  }

  _load() {
    if (!this.path) return;
    try {
      if (!fs.existsSync(this.path)) return;
      const data = JSON.parse(fs.readFileSync(this.path, "utf-8"));
      if (!data || typeof data !== "object") return;
      for (const [chatId, lines] of Object.entries(data)) {
        const clean = sanitizeFacts(lines, { max: this.maxPerChat, selfNames: this.selfNames });
        if (clean.length > 0) this.chats.set(String(chatId), clean);
      }
    } catch {
      // 文件损坏/不可读：按空记事本启动，不能让记事本拖垮主程序。
      this.chats = new Map();
    }
  }

  _save() {
    if (!this.path) return;
    try {
      const obj = {};
      for (const [chatId, lines] of this.chats) obj[chatId] = lines;
      fs.writeFileSync(this.path, JSON.stringify(obj, null, 2) + "\n", "utf-8");
    } catch {
      // 写盘失败（磁盘满、权限等）不抛错：记事本退化为内存版，下次再试。
    }
  }

  /** 取某会话的事实清单副本。没有返回空数组。 */
  facts(chatId) {
    const list = this.chats.get(normChatId(chatId));
    return list ? [...list] : [];
  }

  /**
   * 往某会话追加事实：清洗、去重、过滤机器人自述、超上限丢最旧。
   * @returns {number} 实际新增的条数
   */
  addFacts(chatId, lines) {
    const id = normChatId(chatId);
    if (!id) return 0;
    const cur = this.chats.get(id) || [];
    const merged = sanitizeFacts([...cur, ...(Array.isArray(lines) ? lines : [])], {
      max: this.maxPerChat,
      selfNames: this.selfNames,
    });
    // 新增数 = 合并后多出来的、且不在原清单里的条数（截断丢旧条时也按这个口径算）。
    const before = new Set(cur);
    const added = merged.filter((f) => !before.has(f)).length;
    if (merged.length !== cur.length || added > 0) {
      this.chats.set(id, merged);
      this._bumpVersion(id);
      this._save();
    }
    return added;
  }

  /**
   * 用整理后的完整清单替换某会话的记事本（后台整理任务用）。
   * 清洗后为空时**不覆盖**已有内容——模型偶尔会输出空结果，不能把记事本清空。
   * @returns {boolean} 是否真的替换了
   */
  replace(chatId, lines) {
    const id = normChatId(chatId);
    if (!id) return false;
    const clean = sanitizeFacts(lines, { max: this.maxPerChat, selfNames: this.selfNames });
    if (clean.length === 0) return false;
    this.chats.set(id, clean);
    this._bumpVersion(id);
    this._save();
    return true;
  }

  /**
   * 按序号删一条（序号从 1 起，与「记事本」命令展示的编号一致）。
   * @returns {string|null} 被删的那条；序号无效返回 null
   */
  removeAt(chatId, index) {
    const id = normChatId(chatId);
    const list = this.chats.get(id);
    const n = Number(index);
    if (!list || !Number.isInteger(n) || n < 1 || n > list.length) return null;
    const [removed] = list.splice(n - 1, 1);
    if (list.length === 0) this.chats.delete(id);
    this._bumpVersion(id);
    this._save();
    return removed;
  }

  /** 清空某会话的记事本。@returns {number} 原有条数 */
  clear(chatId) {
    const id = normChatId(chatId);
    const list = this.chats.get(id);
    if (!list) return 0;
    this.chats.delete(id);
    this._bumpVersion(id);
    this._save();
    return list.length;
  }

  /**
   * 渲染成注入系统提示的文本：每条一行、以「- 」开头。
   * 空记事本返回空字符串（调用方据此决定要不要注入这一段）。
   */
  render(chatId) {
    return this.facts(chatId)
      .map((f) => `- ${f}`)
      .join("\n");
  }
}
