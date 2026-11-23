// 联网搜索纯逻辑的单元测试：触发判定、请求构造、结果解析、拼装、key 打码。

import test from "node:test";
import assert from "node:assert/strict";
import {
planSearch,
buildSerperRequest,
parseSerperResults,
buildTavilyRequest,
parseTavilyResults,
cleanSearchQuery,
buildYahooSearchUrl,
parseYahooMarkdown,
buildYahooImageSearchUrl,
parseYahooImageResults,
sanitizeRewrittenQuery,
buildBraveSearchUrl,
parseBraveMarkdown,
buildBingSearchUrl,
decodeBingRedirect,
parseBingMarkdown,
formatSearchContext,
maskSearchKey,
} from "../src/search.js";

test("planSearch：没 key 或带图一律不搜", () => {
assert.equal(planSearch("今天有什么新闻", { hasKey: false}), null);
assert.equal(planSearch("这是什么", { hasKey: true, hasPhoto: true}), null);
assert.equal(planSearch(" ", { hasKey: true}), null);
});

test("planSearch：带「联网搜索」走 Tavily 并剥掉字样，其余走 Serper", () => {
assert.deepEqual(planSearch("联网搜索 最近的 AI 新闻", { hasKey: true}), { mode: "tavily", query: "最近的 AI 新闻"});
assert.deepEqual(planSearch("最近的 AI 新闻", { hasKey: true}), { mode: "serper", query: "最近的 AI 新闻"});
});

test("planSearch：本地型问题（天气/时间/群信息/自我介绍）不搜", () => {
assert.equal(planSearch("上海今天天气怎么样", { hasKey: true}), null);
assert.equal(planSearch("现在几点", { hasKey: true}), null);
assert.equal(planSearch("你能做什么", { hasKey: true}), null);
});

test("buildSerperRequest 构造 X-API-KEY 请求", () => {
const req = buildSerperRequest("", "k-1", "问题");
assert.equal(req.url, "https://google.serper.dev/search");
assert.equal(req.options.headers["X-API-KEY"], "k-1");
assert.deepEqual(JSON.parse(req.options.body), { q: "问题", gl: "cn", hl: "zh-cn", num: 5});
});

test("parseSerperResults 拼直接回答与编号结果并收集链接", () => {
const { text, urls} = parseSerperResults({
answerBox: { answer: "42"},
organic: [
{ title: "标题一", link: "https://a.example", snippet: "摘要一"},
{ title: "标题二", link: "https://b.example", snippet: "摘要二"},
],
});
assert.ok(text.includes("42"));
assert.ok(text.includes("1. 标题一"));
assert.deepEqual(urls, ["https://a.example", "https://b.example"]);
assert.deepEqual(parseSerperResults(null), { text: "", urls: []});
});

test("buildTavilyRequest 与 parseTavilyResults", () => {
const req = buildTavilyRequest("https://api.tavily.com", "k-2", "问题");
assert.equal(req.url, "https://api.tavily.com/search");
assert.equal(buildTavilyRequest("", "k-2", "问题").url, "https://api.tavily.com/search");
assert.equal(buildTavilyRequest("https://api.tavily.com/search", "k-2", "问题").url, "https://api.tavily.com/search");
assert.equal(JSON.parse(req.options.body).api_key, "k-2");
const { text, urls} = parseTavilyResults({ results: [{ title: "T", content: "正文", url: "https://c.example"}]});
assert.ok(text.includes("【T】"));
assert.ok(text.includes("正文"));
assert.deepEqual(urls, ["https://c.example"]);
});

test("formatSearchContext 把结果拼在问题前；maskSearchKey 只露尾 4 位", () => {
const out = formatSearchContext("serper", "结果文本", "原问题");
assert.ok(out.startsWith("【搜索结果】"));
assert.ok(out.endsWith("原问题"));
assert.ok(out.includes("不是让你转发的"), "搜索说明须含链接克制（v0.9.18）");
assert.ok(!out.includes("标注来源时写完整链接"), "旧的鼓励标注来源措辞须已删除");
assert.equal(maskSearchKey("abcdefgh1234"), "****1234");
assert.equal(maskSearchKey(""), "");
});

test("planSearch：lightpanda 后端免 key 也能计划，本地型问题与带图照样不搜", () => {
assert.deepEqual(planSearch("今天有什么新闻", { hasKey: false, provider: "lightpanda" }), { mode: "lightpanda", query: "今天有什么新闻" });
assert.deepEqual(planSearch("联网搜索 明天东京天气", { provider: "lightpanda" }), { mode: "lightpanda", query: "明天东京天气" });
assert.equal(planSearch("今天天气怎么样", { provider: "lightpanda" }), null);
assert.equal(planSearch("这是什么", { provider: "lightpanda", hasPhoto: true }), null);
});

test("Lightpanda 线：Bing 地址构造、Bing 跳转解码、Bing Markdown 解析", () => {
assert.ok(buildBingSearchUrl("a b&c").includes("q=a%20b%26c"));
assert.ok(buildBingSearchUrl("x").includes("mkt=zh-CN"));
const real = "https://chat.deepseek.com/sign_in";
const u = "a1" + Buffer.from(real, "utf-8").toString("base64").replace(/=+$/, "");
const ck = `https://www.bing.com/ck/a?!&&p=xyz&u=${u}&ntb=1`;
assert.equal(decodeBingRedirect(ck), real);
assert.equal(decodeBingRedirect("https://example.com/nope"), "");
assert.equal(decodeBingRedirect("not a url"), "");

const u2 = "a1" + Buffer.from("https://www.deepseek.com/", "utf-8").toString("base64").replace(/=+$/, "");
const uAsset = "a1" + Buffer.from("https://example.com/font.woff2", "utf-8").toString("base64").replace(/=+$/, "");
const md = [
"Skip to content",
"2. ",
"deepseek.com",
"https://chat.**deepseek**.com",
"",
`## [**DeepSeek** \\- Into the Unknown](${ck})`,
"",
"Chat with **DeepSeek** AI, your assistant. [Read more](https://www.bing.com/ck/a?x=1)",
"3. ",
"deepseek.com",
"",
`## [**DeepSeek** 官网](https://www.bing.com/ck/a?!&&p=abc&u=${u2}&ntb=1)`,
"",
"深度求索官方网站。",
`## [字体文件不该收录](https://www.bing.com/ck/a?!&&p=zz&u=${uAsset}&ntb=1)`,
"资源文件行。",
"## [原神官网](https://www.yuanshen.com/)",
"米哈游开放世界冒险 RPG。",
"## [必应首页](https://www.bing.com/)",
"这行不该被收录。",
].join("\n");
const { text, urls } = parseBingMarkdown(md);
assert.deepEqual(urls, [real, "https://www.deepseek.com/", "https://www.yuanshen.com/"]);
assert.ok(text.includes("1. DeepSeek - Into the Unknown"));
assert.ok(text.includes("Chat with DeepSeek AI, your assistant."));
assert.ok(text.includes("3. 原神官网"));
assert.ok(!text.includes("Read more"));
assert.ok(!text.includes("字体文件"));
assert.ok(!text.includes("必应首页"));
assert.deepEqual(parseBingMarkdown(""), { text: "", urls: [] });
});

test("Lightpanda 线：Brave 地址构造与 Brave Markdown 解析", () => {
assert.ok(buildBraveSearchUrl("Spx 收盘价").includes("search.brave.com/search?q=Spx%20"));
const md = [
"![🌐](https://imgs.search.brave.com/xxx/rs:fit:32:32)",
"CNBC",
"https://cnbc.com › quotes › .SPX ",
"Check out S&P 500 INDEX's stock price \\(.SPX\\) in real time",
"[https://search.brave.com/go/v1#AekwEA](https://search.brave.com/go/v1#AekwEA)",
"1 day ago \\- Get S&P 500 Index \\(.SPX:INDEX\\) real\\-time stock quotes, news, price and financial information from CNBC.",
"![🌐](https://imgs.search.brave.com/yyy/rs:fit:32:32)",
"Futubull",
"https://futunn.com › index › .SPX\\-US ",
"标普500指数\\(.SPX\\) 股价、新闻、报价和图表 \\- 富途牛牛",
"[https://search.brave.com/go/v1#Bbekw](https://search.brave.com/go/v1#Bbekw)",
"纳指一周蒸发逾4万亿美元，市场开始憧憬AI产业链超跌反弹",
].join("\n");
const { text, urls } = parseBraveMarkdown(md);
assert.deepEqual(urls, ["https://cnbc.com/quotes/.SPX", "https://futunn.com/index/.SPX-US"]);
assert.ok(text.includes("1. Check out S&P 500 INDEX's stock price (.SPX) in real time"));
assert.ok(text.includes("Get S&P 500 Index (.SPX:INDEX) real-time stock quotes"));
assert.ok(!text.includes("1 day ago"));
assert.ok(text.includes("2. 标普500指数(.SPX) 股价、新闻、报价和图表 - 富途牛牛"));
assert.deepEqual(parseBraveMarkdown(""), { text: "", urls: [] });
});

test("查询词清洗：剥指令短语只留主题；整句只剩指令时为空", () => {
assert.equal(cleanSearchQuery("去网上搜kazumi"), "kazumi");
assert.equal(cleanSearchQuery("去网上搜"), "");
assert.equal(cleanSearchQuery("介绍下kazumi"), "kazumi");
assert.equal(cleanSearchQuery("帮我搜一下最近的显卡价格"), "最近的显卡价格");
assert.equal(cleanSearchQuery("联网搜索 明天东京天气"), "明天东京天气");
assert.equal(cleanSearchQuery("Spx收盘价是多少"), "Spx收盘价是多少");
assert.equal(cleanSearchQuery("今天有什么科技新闻"), "今天有什么科技新闻");
});

test("planSearch：清洗后的主题做查询；无主题时拿上文兜底", () => {
assert.deepEqual(planSearch("去网上搜kazumi", { provider: "lightpanda" }), { mode: "lightpanda", query: "kazumi" });
assert.deepEqual(planSearch("介绍下kazumi", { provider: "lightpanda" }), { mode: "lightpanda", query: "kazumi" });
assert.deepEqual(planSearch("去网上搜", { provider: "lightpanda", fallbackQuery: "介绍下kazumi" }), { mode: "lightpanda", query: "kazumi" });
assert.equal(planSearch("去网上搜", { provider: "lightpanda" }), null);
assert.deepEqual(planSearch("去网上搜", { hasKey: true, fallbackQuery: "介绍下kazumi" }), { mode: "serper", query: "kazumi" });
});

test("Yahoo 地址构造", () => {
assert.equal(buildYahooSearchUrl("kazumi"), "https://search.yahoo.com/search?p=kazumi");
});

test("parseYahooMarkdown：裸链接锚点解析，过滤 Yahoo 自家 Scout 区块", () => {
const md = [
"## Search Results",
"1. ",
"kazumi.apphttps://kazumi.app",
"",
"### Kazumi 官网 \\- 跨平台番剧采集与在线观看应用",
"[https://kazumi.app/](https://kazumi.app/)",
"",
"**Kazumi** 是使用 Flutter 开发的基于自定义规则的番剧采集与在线观看程序，支持弹幕。",
"2. ",
"example.comhttps://example.com",
"",
"### Example Page",
"[https://example.com/](https://example.com/)",
"",
"Example snippet line.",
"3. ",
"",
"### People also ask Yahoo Scout",
"",
"#### What is Kazumi's real name?",
"[https://search.yahoo.com/scout/chat?p=kazumi](https://search.yahoo.com/scout/chat?p=kazumi)",
].join("\n");
const r = parseYahooMarkdown(md);
assert.equal(r.urls.length, 2);
assert.equal(r.urls[0], "https://kazumi.app/");
assert.ok(r.text.includes("Kazumi 官网 - 跨平台番剧采集与在线观看应用"), r.text);
assert.ok(r.text.includes("Flutter"), r.text);
assert.ok(!r.text.includes("scout"), r.text);
});

test("Yahoo 图片搜索：地址构造 + imgurl 原图提取", () => {
assert.equal(buildYahooImageSearchUrl("時崎狂三"), "https://images.search.yahoo.com/search/images?p=%E6%99%82%E5%B4%8E%E7%8B%82%E4%B8%89");
const md = [
"[图](https://images.search.yahoo.com/search/images?p=x&imgurl=https%3A%2F%2Fdate-a-live5th-anime.com%2Fcommon%2Fimages%2Fcharacter%2Fcharacter06.png)",
"[图](https://images.search.yahoo.com/search/images?p=x&imgurl=https%3A%2F%2Fexample.com%2Fa.jpg)",
"[图](https://images.search.yahoo.com/search/images?p=x&imgurl=https%3A%2F%2Fexample.com%2Fa.jpg)",
"[图](https://images.search.yahoo.com/search/images?p=x&imgurl=https%3A%2F%2Fexample.com%2Fpage.html)",
].join("\n");
assert.deepEqual(parseYahooImageResults(md), [
"https://date-a-live5th-anime.com/common/images/character/character06.png",
"https://example.com/a.jpg",
]);
});

test("sanitizeRewrittenQuery：取首行剥引号，空/过长回落兜底", () => {
assert.equal(sanitizeRewrittenQuery("X 玉米须 用户 黑历史\n这是多余的第二行", "兜底"), "X 玉米须 用户 黑历史");
assert.equal(sanitizeRewrittenQuery("「kazumi 追番播放器」", "兜底"), "kazumi 追番播放器");
assert.equal(sanitizeRewrittenQuery("", "兜底"), "兜底");
assert.equal(sanitizeRewrittenQuery("好", "兜底"), "兜底");
assert.equal(sanitizeRewrittenQuery("x".repeat(90), "兜底"), "兜底");
});

test("planSearch 短消息续聊不搜（v0.9.18）：有历史的 4 字内短回复跳过搜索", () => {
assert.equal(planSearch("抽", { provider: "lightpanda", hasHistory: true }), null);
assert.equal(planSearch("再来一个", { provider: "lightpanda", hasHistory: true }), null);
assert.ok(planSearch("抽", { provider: "lightpanda" }), "无历史的首条短消息照常搜");
assert.ok(planSearch("X上的玉米须有没有黑历史", { provider: "lightpanda", hasHistory: true }), "长问题照常搜");
assert.ok(planSearch("联网搜索 抽", { provider: "lightpanda", hasHistory: true }), "显式联网搜索优先放行");
});

test("v0.9.24 formatSearchContext 说明含时效纪律：旧资料不许当现状、不许断言没发生", () => {
const out = formatSearchContext("lightpanda", "旧结果", "今天有什么进展");
assert.ok(out.includes("不许拿旧资料当现状"), "须含旧资料不当现状");
assert.ok(out.includes("更不许断言事情没发生"), "须含不断言没发生");
assert.ok(out.includes("以资料为准"), "须含资料优先于旧知识");
});
