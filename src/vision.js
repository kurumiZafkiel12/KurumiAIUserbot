// 识图池：config.visionPool = { apiName: [{ model, weight }] }。
// 发图提问时从池里按权重挑一个条目，用该 API 的连接、以条目的模型名发带图请求。
// 这里是池的规范化、展开与加权挑选纯逻辑，可单测。

/**
 * 把 config.json 里写得五花八门的 visionPool 规范成 { apiName: [{model, weight}] }。
 * 容忍的历史写法：值是单个对象 {model, weight}、是字符串（模型名）、
 * 或数组里混着字符串/对象。没有模型名的条目丢弃；权重非法时默认 7。
 */
export function normalizeVisionPool(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [apiName, value] of Object.entries(raw)) {
    const name = String(apiName || "").trim();
    if (!name) continue;
    const list = Array.isArray(value) ? value : [value];
    const items = [];
    for (const item of list) {
      if (typeof item === "string") {
        const model = item.trim();
        if (model) items.push({ model, weight: 7 });
      } else if (item && typeof item === "object") {
        const model = String(item.model || "").trim();
        if (!model) continue;
        const w = Number(item.weight);
        items.push({ model, weight: Number.isFinite(w) && w > 0 ? w : 7 });
      }
    }
    if (items.length > 0) out[name] = items;
  }
  return out;
}

/**
 * 把池展开成一维条目列表：[{ apiName, model, weight }]，顺序稳定
 * （按 apiName 的键序、再按数组序），编号列表与按序号删除都以它为准。
 */
export function flattenVisionPool(pool) {
  const out = [];
  if (!pool || typeof pool !== "object") return out;
  for (const [apiName, items] of Object.entries(pool)) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (item && item.model) out.push({ apiName, model: item.model, weight: item.weight > 0 ? item.weight : 7 });
    }
  }
  return out;
}

/**
 * 按权重随机挑一个条目。
 * @param {Array<{apiName, model, weight}>} entries flattenVisionPool 的结果（可预先过滤掉不可用的）
 * @param {() => number} [rng] 随机源，返回 [0,1)，测试注入用
 * @returns {object|null}
 */
export function pickVisionEntry(entries, rng = Math.random) {
  const list = (entries || []).filter((e) => e && e.model);
  if (list.length === 0) return null;
  const total = list.reduce((sum, e) => sum + (e.weight > 0 ? e.weight : 7), 0);
  let r = rng() * total;
  for (const e of list) {
    r -= e.weight > 0 ? e.weight : 7;
    if (r <= 0) return e;
  }
  return list[list.length - 1];
}

/**
 * 按模型名猜它支不支持识图（只给加识图时的列表打个参考标记，最终以实测为准）。
 * 覆盖主流多模态系列的命名特征；没命中的不代表不能识图，命中的也可能被
 * 某个中转渠道阉割——所以这只是导航提示，不是判定。
 */
const VISION_NAME_HINTS = [
  /gemini/i, /claude/i, /grok/i, /vision/i, /llava/i, /internvl/i, /qvq/i,
  /gpt-4o/i, /gpt-4-turbo/i, /gpt-5/i, /gpt-6/i, /chatgpt-4o/i,
  /qwen[-\w.]*vl/i, /glm-4v/i, /minicpm-v/i, /step-1v/i, /yi-vision/i,
  /doubao[-\w.]*vision/i, /hunyuan[-\w.]*vision/i, /moonshot[-\w.]*vision/i,
];

export function looksVisionCapable(model) {
  const s = String(model || "");
  return VISION_NAME_HINTS.some((re) => re.test(s));
}

/** 识图池的编号列表文本（识图列表命令与删/改权重的选项共用）。 */
export function visionListText(pool) {
  const items = flattenVisionPool(pool);
  if (items.length === 0) return "";
  return items.map((it, i) => `${i + 1}. ${it.apiName} → ${it.model}（权重 ${it.weight}）`).join("\n");
}
