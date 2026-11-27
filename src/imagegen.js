// 生图：带 image 标记的提供方不进聊天池，只用来生图。
// 触发判定（审计 K062-16 收紧）：旧版是几十个子串触发词，太宽——「生成一个」
// 会命中「生成一个 Python 函数」、「来一个」会命中「来一个笑话」。新版按句式判定：
// ① 固定短语（画图/生成图片等整词就是生图说法）；
// ② 生成类动词（生成/做/设计/来/弄…）后面必须带图像类名词（图/图片/壁纸/头像…），
//    可以隔着量词与少量字（如「生成一张 猫的图片」）；
// ③ 画/绘制自带产出图像的语义，动词+量词（如「画一张」「画只猫」）即算生图。
// 请求构造与结果解析是纯函数，可单测。

/** 图像类名词：生成类动词后面必须出现它才算生图。 */
const IMAGE_NOUNS = [
  "证件照", "表情包", "实景照",
  "图片", "图像", "图画", "照片", "相片", "壁纸", "头像", "封面", "海报",
  "插画", "插图", "漫画", "贴纸", "图标", "画作", "油画", "水彩画", "素描",
  "原画", "立绘", "自拍", "图", "画",
];

/** 固定短语：整词命中即生图。 */
const FIXED_PHRASES = [
  "生成图片", "生成图像", "生成照片", "生成头像", "生成壁纸", "生成封面", "生成海报",
  "画图", "作图", "出图", "做图",
];

/** 生成类动词（长词在前，匹配时优先）。 */
const VERBS = ["生成", "生产", "制作", "设计", "绘制", "做", "弄", "搞", "来", "出", "整", "画", "创作"];

/** 画/绘制：动词+量词即成立，不必再出现图像名词。 */
const DRAW_VERBS = new Set(["画", "绘制"]);

/** 量词（长词在前）。 */
const QUANTIFIERS = ["一张", "一幅", "一个", "一只", "一份", "一副", "张", "幅", "个", "只", "份", "副"];

/** 有量词时，图像名词可以隔着这么多字出现（如「生成一张 猫的图片」）。 */
const NOUN_WINDOW = 6;

/** 在 rest 开头附近找图像名词：返回 {index, noun} 或 null。 */
function findImageNoun(rest) {
  let best = null;
  for (const noun of IMAGE_NOUNS) {
    const idx = rest.indexOf(noun);
    if (idx >= 0 && idx <= NOUN_WINDOW && (!best || idx < best.index || (idx === best.index && noun.length > best.noun.length))) {
      best = { index: idx, noun };
    }
  }
  return best;
}

/**
 * 在问题里找生图触发片段，返回 {start, end}（end 为剥离 prompt 时要删掉的右界）或 null。
 * 判定规则见文件头注释。
 */
function findImageGenTrigger(q) {
  for (const p of FIXED_PHRASES) {
    const i = q.indexOf(p);
    if (i >= 0) return { start: i, end: i + p.length };
  }
  for (let i = 0; i < q.length; i++) {
    for (const verb of VERBS) {
      if (!q.startsWith(verb, i)) continue;
      let j = i + verb.length;
      let quantifier = "";
      for (const qt of QUANTIFIERS) {
        if (q.startsWith(qt, j)) {
          quantifier = qt;
          j += qt.length;
          break;
        }
      }
      // 画/绘制 + 量词：宾语可以是任意内容物（画一张猫、画只柴犬都算）。
      if (DRAW_VERBS.has(verb) && quantifier) return { start: i, end: j };
      const hit = findImageNoun(q.slice(j));
      if (!hit) continue;
      if (hit.index === 0) {
        // 图像名词紧跟动词/量词：整段都是触发语，prompt 剥离时一并去掉。
        return { start: i, end: j + hit.noun.length };
      }
      if (quantifier) {
        // 隔着几个字才出现图像名词（如「生成一张 猫的图片」）：只剥动词+量词，
        // 后面的描述（猫的图片）留作 prompt。
        return { start: i, end: j };
      }
      // 无量词又隔着字才出现图像名词（如「来看看图片」）：不算生图，太容易误伤。
    }
  }
  return null;
}

/** 是不是生图请求。 */
export function isImageGenRequest(question) {
  const q = String(question || "");
  if (!q) return false;
  return findImageGenTrigger(q) !== null;
}

/**
 * 带图消息专用的宽松生图判定。严格判定要求动词与图像名词紧贴或隔着量词，
 * 「生成同样的图片」（动词后隔着「同样的」、又没量词）会被判否——2026-11-27
 * 群里实测：用户给图配字「生成同样的图片」，整条被识图通道吞掉，识图模型没有
 * 生图工具、只能回「没有可用的生图工具」。消息本身带着图时语境已经明确：
 * 动词后在窗口内出现图像名词就算生图意图，不再要求量词。纯文字消息不用这个
 * （无图时「生成一个函数的图片说明」之类说法太多，仍走严格判定防误伤）。
 */
const LOOSE_NOUN_WINDOW = 16; // 宽松判定扫得远些：「生成把肥鱼的改成另一种风格的图片」名词离动词 11 字
const TEXT_OBJECT_WORDS = ["说明", "文字", "文案", "介绍", "描述", "标题"];

/** 宽松版找图像名词（在 slice 开头 LOOSE_NOUN_WINDOW 字内）：名词后面紧跟说明/文字等
 * 词时，它只是修饰语（真对象是文字），跳过不算。 */
function findLooseImageNoun(slice) {
  const end = Math.min(slice.length, LOOSE_NOUN_WINDOW);
  for (let i = 0; i < end; i++) {
    const noun = IMAGE_NOUNS.find((n) => slice.startsWith(n, i));
    if (!noun) continue;
    let after = slice.slice(i + noun.length, i + noun.length + 3);
    if (after.startsWith("的")) after = after.slice(1);
    if (TEXT_OBJECT_WORDS.some((w) => after.startsWith(w))) continue;
    return noun;
  }
  return null;
}

/** 「生成一张图片说明」这类句式：图像名词只是修饰语、真对象是文字。名词前有生成
 * 类动词、名词后紧跟（可隔「的」）说明/文字等词时命中——严格判定会先被
 * 「生成+量词+图片」骗到，所以要在宽松入口先拦。 */
function isTextObjectRequest(q) {
  for (const noun of IMAGE_NOUNS) {
    let idx = q.indexOf(noun);
    while (idx !== -1) {
      let after = q.slice(idx + noun.length, idx + noun.length + 3);
      if (after.startsWith("的")) after = after.slice(1);
      if (TEXT_OBJECT_WORDS.some((w) => after.startsWith(w))) {
        const before = q.slice(0, idx);
        if (VERBS.some((v) => before.includes(v))) return true;
      }
      idx = q.indexOf(noun, idx + noun.length);
    }
  }
  return false;
}

export function isLooseImageGenRequest(question) {
  const q = String(question || "");
  if (!q) return false;
  if (isTextObjectRequest(q)) return false;
  if (isImageGenRequest(q)) return true;
  for (let i = 0; i < q.length; i++) {
    for (const verb of VERBS) {
      if (!q.startsWith(verb, i)) continue;
      let j = i + verb.length;
      for (const qt of QUANTIFIERS) {
        if (q.startsWith(qt, j)) {
          j += qt.length;
          break;
        }
      }
      if (findLooseImageNoun(q.slice(j))) return true;
    }
  }
  return false;
}

/**
 * 从问题里剥掉生图触发片段，剩下的就是画面描述（prompt）。
 * 顺带清掉残留的请求前缀（帮我/给我/能…）与句尾语气词（吗/么）。
 */
export function extractImagePrompt(question) {
  const q = String(question || "");
  const trigger = findImageGenTrigger(q);
  if (!trigger) return q.trim();
  let out = `${q.slice(0, trigger.start)} ${q.slice(trigger.end)}`;
  out = out.replace(/\s+/g, " ").trim();
  out = out.replace(/^(帮我|给我|请帮我|请给我|请|麻烦|能不能|能|可以)+/, "").trim();
  out = out.replace(/(吗|么)+$/, "").trim();
  return out.replace(/^[\s，。：:、]+|[\s，。、]+$/g, "").trim();
}

/**
 * 提取出的生图提示词是不是只剩一个指代词（「这个」「按照这个」「那张」）：
 * 这类说法本身没有画面内容，指代的是上一条描述或被回复的那条消息。快线拿它
 * 当提示词只会生成莫名其妙的图（实测拿「按照这个」生成出一张游戏广告海报），
 * 应交给聊天模型结合上下文调用 generate_image。
 */
export function isReferentialImagePrompt(prompt) {
  const t = String(prompt || "").replace(/[\s，。、！？!?；;：:]/g, "");
  if (!t || t.length > 6) return false;
  return /^(按照|照着|就按|就照)?(这个|那个|它|这张照片|那张照片|这张图片|那张图片|这张|那张|这幅|那幅|上面那个|刚才那个|前面那个)$/.test(t);
}

/** 构造 /images/generations 请求（纯函数）。 */
export function buildImageGenRequest(provider, prompt) {
  const base = String((provider && provider.baseURL) || "").replace(/\/$/, "");
  const keyProp = "api" + "Key";
  return {
    url: `${base}/images/generations`,
    options: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${(provider && provider[keyProp]) || ""}`,
      },
      body: JSON.stringify({ model: provider && provider.model, prompt, n: 1, size: "1024x1024" }),
    },
  };
}

/**
 * 解析生图返回：优先 b64_json，其次 url（data[0]、顶层 url、images[0] 都认）。
 * @returns {{b64: string} | {url: string} | null}
 */
export function parseImageGenResponse(data) {
  if (!data || typeof data !== "object") return null;
  const item = (Array.isArray(data.data) && data.data[0]) || data;
  if (item && typeof item === "object") {
    if (item.b64_json) return { b64: item.b64_json };
    if (item.url) return { url: item.url };
  }
  if (data.url) return { url: data.url };
  if (Array.isArray(data.images) && data.images[0]) {
    const im = data.images[0];
    if (im && im.url) return { url: im.url };
    if (im && im.b64_json) return { b64: im.b64_json };
  }
  return null;
}
