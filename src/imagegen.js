// 生图：带 image 标记的提供方不进聊天池，只用来生图。
// 触发条件与 tgai 时代等价：问题里带「画一张/生成图片/帮我画」这类明确的生图说法。
// 请求构造与结果解析是纯函数，可单测。

/** 生图触发词（命中任一即视为生图请求）。 */
export const GENERATE_KEYWORDS = [
  "生成图片", "生成图", "生成一张", "生成一幅", "生成个", "生成张", "生成一个", "生成一下",
  "生成照片", "生成头像", "生成壁纸", "生成封面", "生成海报", "帮我生成", "帮我做图",
  "帮我弄张", "帮我弄个", "帮我搞张", "帮我搞个", "画一张", "画一幅", "画一个", "画一下",
  "画个", "画张", "画幅", "画只", "画一画", "帮我画", "帮我画个", "帮我画张", "帮我画幅",
  "给我画", "给我画个", "给我画张", "给我画幅", "来一张", "来一幅", "来一个", "来张",
  "来幅", "来只", "能画", "能生成", "能帮我画", "能不能画", "可以画", "可以生成",
  "作图", "做一张图", "做张图", "做个图", "做一幅图", "弄一张", "弄一幅", "弄个图",
  "搞一张", "搞个图", "设计一张", "设计一个", "画图", "出图",
];

/** 是不是生图请求。 */
export function isImageGenRequest(question) {
  const q = String(question || "");
  if (!q) return false;
  return GENERATE_KEYWORDS.some((k) => q.includes(k));
}

/**
 * 从问题里剥掉生图触发词，剩下的就是画面描述（prompt）。
 * 长词优先剥，避免「帮我画个」只剥掉「画个」留下残句。
 */
export function extractImagePrompt(question) {
  let out = String(question || "");
  const sorted = [...GENERATE_KEYWORDS].sort((a, b) => b.length - a.length);
  for (const k of sorted) out = out.split(k).join(" ");
  return out.replace(/\s+/g, " ").replace(/^[\s，。：:、]+|[\s，。、]+$/g, "").trim();
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
