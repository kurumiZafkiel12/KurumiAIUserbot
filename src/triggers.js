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
 * 这条消息回复的是不是机器人本账号自己发出的消息（回复续聊的判定）。
 * 满足任一条件即算：被回复消息 out 为 true（本账号发出），
 * 或被回复消息的 senderId 等于本账号 ID。
 *
 * @param {object|null} replied 被回复的消息对象（GramJS Message 或同形对象）
 * @param {string|number} selfId 本账号的数字 ID
 * @returns {boolean}
 */
export function isReplyToSelf(replied, selfId) {
  if (!replied || selfId === undefined || selfId === null || String(selfId) === "") return false;
  if (replied.out === true) return true;
  if (replied.senderId === undefined || replied.senderId === null) return false;
  const sid = String(replied.senderId);
  return sid !== "" && sid === String(selfId);
}

/** 号主命令的两种前缀：触发词式 “@ai ” 与 tgai 时代习惯的 “/ai ”，都认。 */
export const OWNER_COMMAND_PREFIXES = [`${DEFAULT_TRIGGER} `, "/ai "];

/**
 * 判断文本是不是号主命令：以 “@ai ” 或 “/ai ” 开头（号主身份由调用方另行校验）。
 * 返回去掉前缀后的命令正文；不是命令则返回 null。
 */
export function parseOwnerCommand(text) {
  if (!text || typeof text !== "string") return null;
  for (const prefix of OWNER_COMMAND_PREFIXES) {
    if (text.startsWith(prefix)) {
      const body = text.slice(prefix.length).trim();
      return body.length > 0 ? body : null;
    }
  }
  return null;
}

/** 帮助类问题（触发后提取出的问题恰好是这几个写法之一，就走代码写死的帮助，不调模型）。 */
const HELP_QUERIES = new Set(["帮助", "help", "/ai 帮助", "@ai 帮助"]);

/**
 * 判断提取出的问题是不是在要帮助：容忍首尾空格、内部多余空白，英文不分大小写。
 * 只认整句恰好等于上述写法，「帮助我」「请给我帮助」之类不算。
 */
export function isHelpQuery(text) {
  if (!text || typeof text !== "string") return false;
  const normalized = text.trim().replace(/\s+/g, " ").toLowerCase();
  return HELP_QUERIES.has(normalized);
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
