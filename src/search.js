// 联网搜索：问题先过搜索引擎，把结果拼进问题文本再让模型作答。
// 接口线（与 tgai 时代的机制等价）：
// - 问题里带「联网搜索」字样 → Tavily（深度搜索），关键词是去掉该字样后的问题；
// - 其余非「本地型」问题（天气/时间/群信息/自我介绍这类不用搜的）→ Serper（Google 结果）。
// 没有配搜索 key 时接口线不启用。
// 第三条线（v0.9.6）：searchProvider=lightpanda 时走本机 Lightpanda 抓搜索引擎结果页，
// 免 key、无额度；执行（拉起 Lightpanda 进程）在 handlers 里，结果页解析在本文件。
// 引擎顺序（v0.9.8）：Brave 优先、Bing 兜底——Bing 对机房 IP + 中英混排问题
// （如「Spx收盘价」）会给不相关结果，Brave 自有索引在这类问题上可靠得多。
// 请求构造与结果解析都是纯函数，可单测。

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
// 指令词清洗（v0.9.11）：用户常把「去网上搜kazumi」「介绍下X」整句发来，直接拿整句当
// 查询词，引擎会按指令词分词（「去网上搜kazumi」被按「去」搜出字典页）。剥掉开头的
// 指令短语，只留真正要搜的内容；整句只剩指令时返回空串，交给话题兜底。
const SEARCH_INSTRUCTION_PREFIXES = [
"去网上搜", "上网搜", "网上搜", "帮我搜索", "帮忙搜", "帮我搜", "搜索一下", "搜一下", "搜搜",
"去搜", "去查", "帮我查", "查一下", "查查", "介绍一下", "介绍下", "讲一讲", "讲讲", "说说", "一下",
];

export function cleanSearchQuery(question) {
let q = String(question || "").trim().replace(/联网搜索/g, "").trim();
let changed = true;
while (changed && q) {
changed = false;
for (const p of SEARCH_INSTRUCTION_PREFIXES) {
if (q.startsWith(p)) {
q = q.slice(p.length).trim();
changed = true;
break;
}
}
const stripped = q.replace(/^[\s，,、：:；;]+/, "");
if (stripped !== q) {
q = stripped;
changed = true;
}
}
return q;
}

export function planSearch(question, options = {}) {
const viaLightpanda = options.provider === "lightpanda";
if (!viaLightpanda && !options.hasKey) return null;
if (options.hasPhoto) return null;
const q = String(question || "").trim();
if (!q) return null;
const mode = viaLightpanda ? "lightpanda" : "serper";
if (q.includes("联网搜索")) {
// 显式指令：清洗后直接搜，不走本地关键词拦截；清洗为空时拿上文话题兜底。
const query = cleanSearchQuery(q) || cleanSearchQuery(options.fallbackQuery || "");
return { mode: viaLightpanda ? "lightpanda" : "tavily", query: query || q };
}
if (LOCAL_ONLY_KEYWORDS.some((k) => q.includes(k))) return null;
const query = cleanSearchQuery(q);
if (query) return { mode, query };
// 整句只剩指令词（如单独一句「去网上搜」）：拿上一条用户问题当主题搜。
const fallback = cleanSearchQuery(options.fallbackQuery || "");
if (fallback) return { mode, query: fallback };
return null;
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

export const BRAVE_SEARCH_BASE = "https://search.brave.com/search";

/** 构造 Brave 搜索页地址（Lightpanda 抓取用）。 */
export function buildBraveSearchUrl(query) {
return `${BRAVE_SEARCH_BASE}?q=${encodeURIComponent(String(query || ""))}`;
}

/** Brave 结果的展示地址（example.com › path › page）还原成真实地址。 */
function braveDisplayUrlToReal(line) {
const parts = cleanBingText(line).split("›").map((s) => s.trim()).filter(Boolean);
if (!parts.length || !/^https?:\/\//.test(parts[0])) return "";
return parts.join("/");
}

/**
 * 解析 Lightpanda 抓回的 Brave 结果页 Markdown。
 * 每条结果以 `[https://search.brave.com/go/...]` 跟踪链接为锚：
 * 往上两行是展示地址与标题，往下一行是摘要（可能带「1 day ago - 」时间前缀）。
 */
export function parseBraveMarkdown(md, limit = 5) {
const lines = String(md || "").split("\n");
const prevTwo = (idx) => {
const out = [];
for (let j = idx - 1; j >= 0 && out.length < 2; j--) if (lines[j].trim()) out.push(lines[j].trim());
return out;
};
const items = [];
const seen = new Set();
for (let i = 0; i < lines.length && items.length < limit; i++) {
if (!lines[i].includes("search.brave.com/go/")) continue;
const [titleRaw, urlLine] = prevTwo(i);
const url = braveDisplayUrlToReal(urlLine || "");
const title = cleanBingText(titleRaw || "");
if (!url || !title || seen.has(url)) continue;
let snippet = "";
for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
if (lines[j].trim()) {
snippet = lines[j].trim();
break;
}
}
snippet = cleanBingText(snippet)
.replace(/^(?:\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago|[A-Z][a-z]+ \d{1,2}, \d{4})\s*-\s*/, "")
.slice(0, 200);
seen.add(url);
items.push({ title, url, snippet });
}
const text = items.map((r, i) => `${i + 1}. ${r.title}\n ${r.url}\n ${r.snippet}`).join("\n");
return { text: text.trim(), urls: items.map((r) => r.url) };
}

export const BING_SEARCH_BASE = "https://www.bing.com/search";

/** 构造 Bing 搜索页地址（Lightpanda 抓取用）。必须带中文市场参数：
 * 不带时 Bing 按机房 IP 的市场出结果，中文问题会给一堆不相关页面（实测踩坑）。 */
export function buildBingSearchUrl(query) {
return `${BING_SEARCH_BASE}?q=${encodeURIComponent(String(query || ""))}&mkt=zh-CN&setlang=zh-CN`;
}

/**
 * 解码 Bing 结果的跳转链接：ck/a 地址的 u 参数是 "a1" + base64（真实地址）。
 * 解不出或不是 http(s) 时返回空串。
 */
export function decodeBingRedirect(url) {
try {
const u = new URL(String(url || "")).searchParams.get("u");
if (!u || !u.startsWith("a1")) return "";
const b64 = u.slice(2).replace(/-/g, "+").replace(/_/g, "/");
const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
const real = Buffer.from(padded, "base64").toString("utf-8");
return /^https?:\/\//.test(real) ? real : "";
} catch {
return "";
}
}

/** 清理 Bing Markdown 里的加粗标记与转义符。 */
function cleanBingText(s) {
return String(s || "")
.replace(/\*\*/g, "")
.replace(/\\(.)/g, "$1")
.replace(/\s+/g, " ")
.trim();
}

/**
 * 解析 Lightpanda 抓回的 Bing 结果页 Markdown。
 * 结果标题是 `## [标题](ck/a 跳转链接)`，跳转参数里藏着真实地址；
 * 标题后到下一条结果之间的正文是摘要。解析不出返回空文本（调用方降级为不搜）。
 */
export function parseBingMarkdown(md, limit = 5) {
const lines = String(md || "").split("\n");
const items = [];
const seen = new Set();
let cur = null;
const flush = () => {
if (!cur) return;
const snippet = cleanBingText(cur.snippetLines.join(" ").replace(/\[Read more\]\([^)]*\)/g, "")).slice(0, 200);
items.push({ title: cur.title, url: cur.url, snippet });
cur = null;
};
for (const line of lines) {
const h = line.match(/^## \[(.+)\]\((https?:\/\/[^)\s]+)\)\s*$/);
if (h) {
flush();
const raw = h[2];
let url = "";
if (raw.includes("/ck/a?")) url = decodeBingRedirect(raw);
else if (!/(?:^|\.)bing\.com\//.test(raw) && !/microsoft\.com\//.test(raw)) url = raw;
if (url && /\.(?:woff2?|ttf|css|js|png|jpe?g|gif|svg|ico|webp|mp4|zip)(?:[?#]|$)/i.test(url)) url = "";
if (url && !seen.has(url)) {
seen.add(url);
cur = { title: cleanBingText(h[1]), url, snippetLines: [] };
}
continue;
}
if (/^\d+\.\s*$/.test(line)) {
flush();
continue;
}
if (cur) cur.snippetLines.push(line);
}
flush();
const picked = items.slice(0, limit);
const text = picked.map((r, i) => `${i + 1}. ${r.title}\n ${r.url}\n ${r.snippet}`).join("\n");
return { text: text.trim(), urls: picked.map((r) => r.url) };
}

/** 把搜索结果拼进问题文本（模型看到的是带出处材料的问题）。 */
export function formatSearchContext(mode, resultText, question) {
const label = mode === "tavily"? "联网搜索结果": "搜索结果";
return `【${label}】\n${resultText}\n\n【说明】优先依据上面资料回答，资料没覆盖的不要编；标注来源时写完整链接（带 https://）并与前后文字留空格，不要把域名用括号贴在名称后面。\n\n【用户的问题】\n${question}`;
}

/** 搜索 key 打码展示：只露最后 4 位；没配返回空串（调用方据此提示未配置）。 */
export function maskSearchKey(key) {
const k = String(key || "").trim();
if (!k) return "";
return `****${k.slice(-4)}`;
}
