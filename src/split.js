// 分条发送：人设模式下的闲聊短答按行拆成多条消息逐条发，像真人打字；
// 专业长答保持整条不切（代码块、列表/标题结构、长段落都算专业形态）。
// 纯函数，可单测。号主命令回复等代码直出内容不经过这里，永不拆。

/** 分条上限：超过这个条数，余下内容合并进最后一条。 */
export const MAX_SPLIT_PARTS = 5;

/** 单条最长：某一行本身就很长时不拆（拆了也是大段墙）。 */
const MAX_PART_LENGTH = 200;

/**
 * 是不是「专业长答」形态（命中任一就不拆）：
 * - 含代码块（``` 围栏）；
 * - 多行列表或标题（至少两行以列表/标题标记开头）；
 * - 总长超过约 300 字且段落结构明显（至少两个空行分段）。
 */
export function isProfessionalText(text) {
  const t = String(text || "");
  if (!t) return false;
  if (t.includes("```")) return true;
  const lines = t.split("\n");
  const structureLines = lines.filter((ln) =>
    /^\s*(?:[-*+]\s+|\d+[.)、]\s+|#{1,6}\s+)/.test(ln),
  ).length;
  if (structureLines >= 2) return true;
  if (t.length > 300) {
    const paras = t.split(/\n\s*\n/).filter((p) => p.trim());
    if (paras.length >= 2) return true;
  }
  return false;
}

/**
 * 决定一条最终回复要拆成几条发。
 * @param {string} text 最终回复全文（已脱敏）
 * @param {object} options
 * @param {boolean} options.personaMode 是否人设模式（设了人设或破甲才算）
 * @returns {string[]} 要发送的消息列表（至少一条，就是全文）
 */
export function decideSplit(text, options = {}) {
  const t = String(text || "").trim();
  if (!t) return [t];
  if (!options.personaMode) return [t];
  if (isProfessionalText(t)) return [t];
  const lines = t.split("\n").map((s) => s.trim()).filter(Boolean);
  if (lines.length < 2) return [t];
  if (lines.some((ln) => ln.length > MAX_PART_LENGTH)) return [t];
  if (lines.length <= MAX_SPLIT_PARTS) return lines;
  const head = lines.slice(0, MAX_SPLIT_PARTS - 1);
  const tail = lines.slice(MAX_SPLIT_PARTS - 1).join("\n");
  return [...head, tail];
}
