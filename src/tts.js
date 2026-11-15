// 语音（TTS）：音色库 voiceBook（名字 -> 音色 ID）、人格 voicePersona（音色名 -> 人格提示词）、
// 每群开关 saySwitch（开启说）/ voiceSwitch（开启换音色）、
// 当前音色 voiceByChat（群级）/ voiceByChatUser（个人级）。
// 这里是请求构造、音色选择、朗读文本清洗与「换音色」句式识别的纯逻辑，可单测。

/**
 * 构造 TTS 请求（与 tgai 时代的自定义 TTS 接口等价）：
 * 直接 POST 到 ttsApiBase（它就是完整端点地址，用 /ai 换tts接口 设置），
 * body { text, format: "mp3", reference_id: 音色ID }，key 走 Bearer。
 * @returns {{url: string, options: object} | null} base 或 key 没配时返回 null
 */
export function buildTtsRequest(base, key, text, voiceId) {
  const url = String(base || "").trim();
  const k = String(key || "").trim();
  if (!url || !k) return null;
  const body = { text: String(text || ""), format: "mp3" };
  if (voiceId) body.reference_id = voiceId;
  return {
    url,
    options: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${k}`,
        "Content-Type": "application/json",
        model: "s2.1-pro-free",
      },
      body: JSON.stringify(body),
    },
  };
}

/**
 * 挑当前生效的音色：个人音色 > 群音色 > 音色库第一个。
 * @param {object} config 含 voiceBook / voiceByChat / voiceByChatUser 的配置视图
 * @param {string|number} chatId
 * @param {string|number} senderId
 * @returns {{name: string, id: string}} 都没有时 name/id 为空串
 */
export function pickVoiceName(config, chatId, senderId) {
  const book = (config && config.voiceBook) || {};
  const personal = config && config.voiceByChatUser ? config.voiceByChatUser[`${chatId}_${senderId}`] : "";
  const group = config && config.voiceByChat ? config.voiceByChat[chatId] : "";
  let name = personal || group || "";
  if (!name) {
    const first = Object.keys(book)[0];
    if (first) name = first;
  }
  if (!name) return { name: "", id: "" };
  return { name, id: book[name] || "" };
}

/** 把模型回答清洗成适合朗读的纯文本：去掉 Markdown 标记与多余空白。 */
export function cleanSpeechText(text) {
  return String(text || "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
    .replace(/```[a-zA-Z]*\n?/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 识别群友在聊天里换音色的说法（触发后、去掉触发词的问题文本）。
 * 认这些句式：「换音色 <名字>」「切换音色 <名字>」「音色换成 <名字>」「把我的音色换成 <名字>」等。
 * @returns {string|null} 想换的音色名；不是换音色句式返回 null
 */
export function parseVoiceSwitch(question) {
  const q = String(question || "").trim();
  if (!q) return null;
  const patterns = [
    /^(?:请|帮我|麻烦|给我|我想|我要|把)?\s*(?:把我的音色|把我的声音|我的音色|我的声音|音色|声音)\s*(?:给)?\s*(?:切换为|切换成|切换|换成|换为|换到|换|改为|改成|设置为|设置成|设为|设置|用|变成|变为)\s*[:：]?\s*(\S.*)$/,
    /^(?:请|帮我|麻烦|给我|我想|我要)?\s*(?:切换为|切换成|切换|换成|换为|换到|换|改为|改成|设置为|设置成|设为|设置|变成|变为|换个)\s*(?:我的)?\s*(?:音色|声音)\s*(?:为|成|到)?\s*[:：]?\s*(\S.*)$/,
    /^换音色\s*[:：]?\s*(\S.*)$/,
  ];
  for (const re of patterns) {
    const m = q.match(re);
    if (m && m[1] && m[1].trim()) return m[1].trim();
  }
  return null;
}

/** 是不是在问音色列表 / 当前音色（公开小命令，不走模型）。 */
export function voiceQueryKind(question) {
  const q = String(question || "").trim();
  if (/^(音色列表|所有音色|查看音色)$/.test(q)) return "list";
  if (/^(当前音色|现在用什么音色|本群音色|我的音色)$/.test(q)) return "current";
  return null;
}
