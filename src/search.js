// 联网搜索：问题先过搜索引擎，把结果拼进问题文本再让模型作答。
// 两条线（与 tgai 时代的机制等价）：
// - 问题里带「联网搜索」字样 → Tavily（深度搜索），关键词是去掉该字样后的问题；
// - 其余非「本地型」问题（天气/时间/群信息/自我介绍这类不用搜的）→ Serper（Google 结果）。
// 没有配搜索 key 时整条链不启用。请求构造与结果解析都是纯函数，可单测。

export const DEFAULT_SERPER_BASE = "https://google.serper.dev/search";
export const DEFAULT_TAVILY_BASE = "https://api.tavily.com/search";

/** 本地型问题关键词：命中就不联网搜（天气和时间另有注入、群信息靠群接口、自我介绍靠人设）。 */
const LOCAL_ONLY_KEYWORDS = [
"天气",
"几点",
"几号",
"星期几",
"礼拜几",
"什么群",
"哪个群",
"群名",
"群规",
"群介绍",
"管理员",
"群管",
"成员名单",
"你能做什么",
"你会什么",
"自我介绍",
];

/**
* 判断这个问题要不要联网搜、用哪条线。
* @param {string} question
* @param {object} [options]
* @param {boolean} [options.hasPhoto] 带图问题不搜
* @param {boolean} [options.hasKey] 没配 key 时一律不搜
* @returns {{mode: "tavily", query: string} | {mode: "serper", query: string} | null}
*/
export function planSearch(question, options = {}) {
if (!options.hasKey) return null;
if (options.hasPhoto) return null;
const q = String(question || "").trim();
if (!q) return null;
if (q.includes("联网搜索")) {
const query = q.replace(/联网搜索/g, "").trim();
return { mode: "tavily", query: query || q};
}
if (LOCAL_ONLY_KEYWORDS.some((k) => q.includes(k))) return null;
return { mode: "serper", query: q};
}

/** 构造 Serper 请求（纯函数）。 */
export function buildSerperRequest(base, key, query) {
return {
url: base || DEFAULT_SERPER_BASE,
options: {
method: "POST",
headers: { "X-API-KEY": key, "Content-Type": "application/json"},
body: JSON.stringify({ q: query, gl: "cn", hl: "zh-cn", num: 5}),
},
};
}

/** 解析 Serper 返回：拼成「直接回答 + 编号结果」的文本，并收集链接。 */
export function parseSerperResults(data) {
const urls = [];
let text = "";
if (!data || typeof data!== "object") return { text, urls};
const ab = data.answerBox;
if (ab && typeof ab === "object") {
const ans = ab.answer || ab.snippet || ab.title || "";
if (ans) text += `【直接回答】${ans}\n\n`;
}
const organic = Array.isArray(data.organic)? data.organic: [];
if (organic.length > 0) {
text += organic
.slice(0, 5)
.map((r, i) => {
const title = (r && r.title) || "无标题";
const link = (r && r.link) || "";
const snippet = String((r && r.snippet) || "").slice(0, 200);
if (link) urls.push(link);
return `${i + 1}. ${title}\n ${link}\n ${snippet}`;
})
.join("\n");
}
return { text: text.trim(), urls};
}

/** 构造 Tavily 请求（纯函数）。 */
export function buildTavilyRequest(base, key, query) {
return {
url: (String(base || "").replace(/\/+$/, "") || DEFAULT_TAVILY_BASE).replace(/\/search$/, "") + "/search",
options: {
method: "POST",
headers: { "Content-Type": "application/json"},
body: JSON.stringify({ api_key: key, query, max_results: 5}),
},
};
}

/** 解析 Tavily 返回：拼成「内容」的文本，并收集链接。 */
export function parseTavilyResults(data) {
if (!data || typeof data!== "object" ||!Array.isArray(data.results)) return { text: "", urls: []};
const urls = [];
const text = data.results
.map((r) => {
if (r && r.url) urls.push(r.url);
return `【${(r && r.title) || ""}】\n${(r && r.content) || ""}`;
})
.join("\n\n");
return { text: text.trim(), urls};
}

/** 把搜索结果拼进问题文本（模型看到的是带出处材料的问题）。 */
export function formatSearchContext(mode, resultText, question) {
const label = mode === "tavily"? "联网搜索结果": "搜索结果";
return `【${label}】\n${resultText}\n\n【用户的问题】\n${question}`;
}

/** 搜索 key 打码展示：只露最后 4 位；没配返回空串（调用方据此提示未配置）。 */
export function maskSearchKey(key) {
const k = String(key || "").trim();
if (!k) return "";
return `****${k.slice(-4)}`;
}
