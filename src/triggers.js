// 触发词解析：纯函数，无外部依赖，方便单元测试。
//
// 触发方式有两种：
// 1. 提及机器人用户名：消息中包含 “@<MY_USERNAME>”
// 2. 触发词：@aa ～ @az，每个触发词可在 triggerMap 里绑定一个模型提供方；
//    其中 @ai 是默认触发词，未显式绑定时指向名为 "default" 的提供方（即 .env 里的接口）。

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/** 全部可用触发词，按顺序 @aa、@ab、…、@az。 */
export const TRIGGER_WORDS = LETTERS.split("").map((ch) => `@a${ch}`);

/** 默认触发词。 */
export const DEFAULT_TRIGGER = "@ai";

/** 默认提供方名字（.env 里配置的接口）。 */
export const DEFAULT_PROVIDER = "default";

/**
 * 解析一条消息文本，判断它是否触发了机器人，并提取问题。
 *
 * @param {string} text 消息全文
 * @param {object} options
 * @param {string} [options.username] 机器人用户名（不带 @）
 * @param {Object<string,string>} [options.triggerMap] 触发词 -> 提供方名字
 * @returns {null | {kind: "mention"|"trigger", trigger: string, providerName: string|null, question: string}}
 *   providerName 为 null 表示该触发词尚未绑定任何提供方。
 */
export function parseTrigger(text, options = {}) {
  const { username = "", triggerMap = {} } = options;
  if (!text || typeof text !== "string") return null;

  const mention = username ? `@${username}` : null;

  // 1) 提及用户名：出现在消息任意位置都算触发，问题是去掉提及后的剩余文本。
  if (mention && text.includes(mention)) {
    const question = text.split(mention).join(" ").replace(/\s+/g, " ").trim();
    return {
      kind: "mention",
      trigger: mention,
      providerName: resolveProvider(DEFAULT_TRIGGER, triggerMap),
      question,
    };
  }

  // 2) 触发词：按独立词匹配（前后不能紧跟英文字母或数字，避免把邮箱之类误判）。
  for (const word of TRIGGER_WORDS) {
    const idx = findWord(text, word);
    if (idx >= 0) {
      const question = (text.slice(0, idx) + " " + text.slice(idx + word.length))
        .replace(/\s+/g, " ")
        .trim();
      return {
        kind: "trigger",
        trigger: word,
        providerName: resolveProvider(word, triggerMap),
        question,
      };
    }
  }

  return null;
}

/**
 * 查某个触发词绑定的提供方。@ai 未绑定时回退到默认提供方；其余未绑定返回 null。
 */
export function resolveProvider(trigger, triggerMap = {}) {
  if (triggerMap && typeof triggerMap[trigger] === "string" && triggerMap[trigger]) {
    return triggerMap[trigger];
  }
  if (trigger === DEFAULT_TRIGGER) return DEFAULT_PROVIDER;
  return null;
}

/**
 * 判断文本是不是号主命令：以 “@ai ” 开头（号主身份由调用方另行校验）。
 * 返回去掉前缀后的命令正文；不是命令则返回 null。
 */
export function parseOwnerCommand(text) {
  if (!text || typeof text !== "string") return null;
  const prefix = `${DEFAULT_TRIGGER} `;
  if (!text.startsWith(prefix)) return null;
  const body = text.slice(prefix.length).trim();
  return body.length > 0 ? body : null;
}

/** 在文本中找独立出现的 word（前后不紧跟 [A-Za-z0-9]），返回下标，找不到返回 -1。 */
function findWord(text, word) {
  let from = 0;
  while (from <= text.length - word.length) {
    const idx = text.indexOf(word, from);
    if (idx < 0) return -1;
    const before = idx > 0 ? text[idx - 1] : "";
    const after = idx + word.length < text.length ? text[idx + word.length] : "";
    if (!/[A-Za-z0-9]/.test(before) && !/[A-Za-z0-9]/.test(after)) return idx;
    from = idx + 1;
  }
  return -1;
}
