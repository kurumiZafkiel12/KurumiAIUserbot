// 用户档案：给每个用户存两样东西——
// - callName（称呼）：用户亲口交代的「叫我 X」，一旦记住就一直照这个称呼他。
//   别人代他改称呼、或者话里带过一句不算，必须是他本人消息里的明确交代。
// - impression（印象）：后台根据他最近的发言慢慢攒的一两句印象（风格/话题/氛围/公开小事），
//   只用来调整跟他说话的语气和熟络程度，绝不念出来、绝不告诉别人。不记隐私。
// 档案持久化到构造时传入的 JSON 文件；文件损坏按空档案处理，绝不抛错。

import fs from "node:fs";

// 语气尾缀：跟在称呼后面要剥掉的口头禅，按长度降序，优先剥最长的那个。
const NAME_SUFFIXES = ["就可以了", "就行了", "可以了", "就可以", "就行", "吧", "呀", "啦", "嘛", "哦", "捏"].sort(
  (a, b) => b.length - a.length,
);
// 屏蔽词：出现这些说明那句「叫我…」多半是提问或吐槽（「叫我干嘛」），不是在报称呼。
const BLOCKED_WORDS = ["干嘛", "干啥", "什么", "谁", "啥"];
// 称呼前后可能粘着的引号/括号类字符。
const QUOTE_CHARS = "「」『』“”‘’\"'《》〈〉【】";
const MAX_NAME_LENGTH = 12;

/** 把任意来源的用户 ID 统一成字符串。 */
function normId(userId) {
  if (userId === undefined || userId === null) return "";
  return String(userId).trim();
}

/** 反复剥掉文本两端的引号/空白，直到剥不动为止。 */
function stripQuotes(text) {
  let t = String(text || "").trim();
  for (;;) {
    const next = t.replace(new RegExp(`^[${QUOTE_CHARS}\\s]+`), "").replace(new RegExp(`[${QUOTE_CHARS}\\s]+$`), "");
    if (next === t) return t;
    t = next;
  }
}

/**
 * 从一句话里提取「叫我 X」交代的称呼。纯函数，可单测。
 *
 * 规则（宁可漏记，不可记错）：
 * - 取**最后一个**「叫我」后面的内容：「不要叫我 A，叫我 B」记的是 B。
 * - 唯一的「叫我」被「不要 / 别」否定时不记（「不要叫我小明」是在拒绝，不是在报称呼）。
 * - 内容先断到第一个标点/空白为止，再剥引号、循环剥语气尾缀（「叫我小明吧」→ 小明）。
 * - 结果命中屏蔽词（干嘛/什么/谁…）返回 null；长度须在 1–12 个字符之间。
 *
 * @param {string} text 消息原文
 * @returns {string|null} 提取到的称呼；没有明确交代时返回 null
 */
export function extractCallName(text) {
  if (!text || typeof text !== "string") return null;
  const idx = text.lastIndexOf("叫我");
  if (idx < 0) return null;

  // 否定检查：紧挨在「叫我」前面的「不要」或「别」表示拒绝这个称呼。
  const before = text.slice(Math.max(0, idx - 2), idx);
  if (before.endsWith("不要") || before.endsWith("别")) return null;

  let rest = text.slice(idx + 2).trim();
  if (!rest) return null;

  // 称呼就是紧跟的一个词：断到第一个标点或空白为止（后面的多半是别的话了）。
  rest = rest.split(/[\s，。！？!?；;、：:]/)[0];
  rest = stripQuotes(rest);

  // 屏蔽词要在剥尾缀之前和每一轮之后都查：「叫我干嘛呀」先剥掉「呀」剩「干嘛」，
  // 若不逐轮查，「干嘛」自己的尾字「嘛」会被下一轮当尾缀剥掉，漏成一个「干」字。
  const isBlockedExact = (s) => BLOCKED_WORDS.includes(s);
  if (isBlockedExact(rest)) return null;
  // 循环剥尾缀：「小明就可以了」→「小明可以」→ 还得再剥一轮才到「小明」。
  for (;;) {
    const hit = NAME_SUFFIXES.find((s) => rest.endsWith(s) && rest.length > s.length);
    if (!hit) break;
    rest = rest.slice(0, rest.length - hit.length);
    if (isBlockedExact(rest)) return null;
  }
  rest = stripQuotes(rest);
  if (!rest) return null;

  // 屏蔽词：等于或以屏蔽词开头（「干嘛呢」）都不是称呼。
  if (BLOCKED_WORDS.some((w) => rest === w || rest.startsWith(w))) return null;

  if (rest.length < 1 || rest.length > MAX_NAME_LENGTH) return null;
  return rest;
}

export class UserProfiles {
  /**
   * @param {string|null} filePath 持久化文件路径（如 profiles.json）；null 表示只用内存不落盘
   */
  constructor(filePath) {
    this.path = filePath || null;
    /** @type {Map<string, {callName: string, impression: string}>} */
    this.users = new Map();
    this._load();
  }

  _load() {
    if (!this.path) return;
    try {
      if (!fs.existsSync(this.path)) return;
      const data = JSON.parse(fs.readFileSync(this.path, "utf-8"));
      if (!data || typeof data !== "object") return;
      for (const [userId, rec] of Object.entries(data)) {
        if (!rec || typeof rec !== "object") continue;
        const callName = typeof rec.callName === "string" ? rec.callName.trim() : "";
        const impression = typeof rec.impression === "string" ? rec.impression.trim() : "";
        if (callName || impression) this.users.set(String(userId), { callName, impression });
      }
    } catch {
      // 文件损坏/不可读：按空档案启动。
      this.users = new Map();
    }
  }

  _save() {
    if (!this.path) return;
    try {
      const obj = {};
      for (const [userId, rec] of this.users) obj[userId] = rec;
      fs.writeFileSync(this.path, JSON.stringify(obj, null, 2) + "\n", "utf-8");
    } catch {
      // 写盘失败不抛错，档案退化为内存版。
    }
  }

  _record(userId) {
    const id = normId(userId);
    if (!id) return null;
    let rec = this.users.get(id);
    if (!rec) {
      rec = { callName: "", impression: "" };
      this.users.set(id, rec);
    }
    return rec;
  }

  /** 取某人的称呼；没设过返回空字符串。 */
  callName(userId) {
    const rec = this.users.get(normId(userId));
    return rec ? rec.callName : "";
  }

  /**
   * 记住某人的称呼并落盘。
   * @returns {boolean} 是否写入（空称呼不写）
   */
  setCallName(userId, name) {
    const value = String(name || "").trim();
    if (!value) return false;
    const rec = this._record(userId);
    if (!rec) return false;
    if (rec.callName === value) return true;
    rec.callName = value;
    this._save();
    return true;
  }

  /** 取对某人的印象；还没有返回空字符串。 */
  impression(userId) {
    const rec = this.users.get(normId(userId));
    return rec ? rec.impression : "";
  }

  /**
   * 更新对某人的印象并落盘（后台整理任务用）。空文本不覆盖旧印象。
   * @returns {boolean} 是否写入
   */
  setImpression(userId, text) {
    const value = String(text || "").trim();
    if (!value) return false;
    const rec = this._record(userId);
    if (!rec) return false;
    if (rec.impression === value) return true;
    rec.impression = value;
    this._save();
    return true;
  }
}
