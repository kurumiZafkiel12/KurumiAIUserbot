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
 * @param {string} [options.defaultProvider] 默认提供方名字（号主用 /ai 换模型 设的，
 *   未显式绑定触发词时优先用它；缺省回退到名为 "default" 的提供方）
 * @param {boolean} [options.usernameTrigger] 用户名触发开关（默认开）。
 *   关时普通用户（role="user"）的 @用户名 提及不触发；号主/管理员不受影响。
 * @param {string} [options.role] 发言者档位："owner" / "admin" / "user"，只影响上面的开关判定
 * @returns {null | {kind: "mention"|"trigger", trigger: string, providerName: string|null, question: string}}
 *   providerName 为 null 表示该触发词尚未绑定任何提供方。
 */
export function parseTrigger(text, options = {}) {
  const { username = "", triggerMap = {}, defaultProvider = "", usernameTrigger = true, role = "owner" } = options;
  if (!text || typeof text !== "string") return null;

  const mention = username ? `@${username}` : null;

  // 1) 提及用户名：出现在消息任意位置都算触发，问题是去掉提及后的剩余文本。
  //    用户名触发被号主关掉时，普通用户的提及不算触发（继续往下看有没有触发词命中）。
  const mentionBlocked = usernameTrigger === false && role === "user";
  if (mention && !mentionBlocked && text.includes(mention)) {
    const question = text.split(mention).join(" ").replace(/\s+/g, " ").trim();
    return {
      kind: "mention",
      trigger: mention,
      providerName: resolveProvider(DEFAULT_TRIGGER, triggerMap, defaultProvider),
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
        providerName: resolveProvider(word, triggerMap, defaultProvider),
        question,
      };
    }
  }

  return null;
}

/**
 * 查某个触发词绑定的提供方。
 * 显式绑定最优先；@ai 未绑定时回退到 defaultProvider（号主设的默认提供方），
 * 再没有就回退到名为 "default" 的提供方；其余未绑定返回 null。
 */
export function resolveProvider(trigger, triggerMap = {}, defaultProvider = "") {
  if (triggerMap && typeof triggerMap[trigger] === "string" && triggerMap[trigger]) {
    return triggerMap[trigger];
  }
  if (trigger === DEFAULT_TRIGGER) {
    if (typeof defaultProvider === "string" && defaultProvider) return defaultProvider;
    return DEFAULT_PROVIDER;
  }
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

/** 号主命令前缀：只认 “/ai ”（用户定版规矩）。“@ai” 只是聊天触发词，绝不当命令前缀。 */
export const OWNER_COMMAND_PREFIX = "/ai ";

/**
 * 判断文本是不是号主命令：以 “/ai ” 开头（号主身份由调用方另行校验）。
 * 返回去掉前缀后的命令正文；不是命令则返回 null。
 * 注意：“@ai …” 是触发词聊天，不是命令，这里一律返回 null。
 */
export function parseOwnerCommand(text) {
  if (!text || typeof text !== "string") return null;
  if (!text.startsWith(OWNER_COMMAND_PREFIX)) return null;
  const body = text.slice(OWNER_COMMAND_PREFIX.length).trim();
  return body.length > 0 ? body : null;
}

/**
 * 群里「@机器人用户名 /ai 命令」的解析：消息不以 /ai 开头、而是以 @用户名 提及开头，
 * 剥掉开头的提及（及随后的空格）后，余下文本若以 “/ai ” 开头，就按号主命令解析。
 * 只供号主使用（调用方先验身份）：普通用户 @机器人发 /ai 帮助 仍走公开帮助，不会升成命令。
 * @param {string} text 消息全文
 * @param {string} username 机器人用户名（不带 @）
 * @returns {string|null} 命令正文（去掉 “/ai ” 前缀）；不是这种形态返回 null
 */
export function parseMentionOwnerCommand(text, username) {
  if (!text || typeof text !== "string" || !username) return null;
  const mention = `@${username}`;
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(mention)) return null;
  const rest = trimmed.slice(mention.length).trimStart();
  return parseOwnerCommand(rest);
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
