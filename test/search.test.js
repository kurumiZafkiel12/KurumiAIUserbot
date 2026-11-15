// 联网搜索纯逻辑的单元测试：触发判定、请求构造、结果解析、拼装、key 打码。

import test from "node:test";
import assert from "node:assert/strict";
import {
planSearch,
buildSerperRequest,
parseSerperResults,
buildTavilyRequest,
parseTavilyResults,
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
assert.equal(maskSearchKey("abcdefgh1234"), "****1234");
assert.equal(maskSearchKey(""), "");
});
