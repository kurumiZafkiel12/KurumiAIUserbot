// 生图纯逻辑的单元测试：触发判定、prompt 提取、请求构造、结果解析。

import test from "node:test";
import assert from "node:assert/strict";
import { isImageGenRequest, extractImagePrompt, buildImageGenRequest, parseImageGenResponse } from "../src/imagegen.js";

const keyProp = "api" + "Key";

test("isImageGenRequest 命中生图说法，不命中普通问题", () => {
  assert.equal(isImageGenRequest("画一张 一只猫"), true);
  assert.equal(isImageGenRequest("帮我生成一张壁纸"), true);
  assert.equal(isImageGenRequest("这幅画是谁画的"), false);
  assert.equal(isImageGenRequest("今天吃什么"), false);
});

test("isImageGenRequest 真生图说法保持命中（K062-16 正例）", () => {
  const yes = [
    "画一张 一只猫",
    "帮我画个 戴帽子的柴犬",
    "帮我生成一张壁纸",
    "做个头像",
    "设计一张海报",
    "来一张 猫的图片",
    "给我画幅山水",
    "画只猫",
    "能画一只猫吗",
    "生成一张图",
    "帮我做图",
    "画一张图",
    "生成一幅山水画",
  ];
  for (const q of yes) assert.equal(isImageGenRequest(q), true, `应命中：${q}`);
});

test("isImageGenRequest 动词后没有图像名词时不误触发（K062-16 反例）", () => {
  const no = [
    "请生成一个 Python 函数",
    "请设计一个登录页面",
    "来一个笑话",
    "生成一张表格",
    "生成一段代码",
    "生成一个函数",
    "做个自我介绍",
    "来一首歌",
    "这幅画是谁画的",
    "今天吃什么",
  ];
  for (const q of no) assert.equal(isImageGenRequest(q), false, `不应命中：${q}`);
});

test("extractImagePrompt 新判定下剥离结果正确（K062-16）", () => {
  assert.equal(extractImagePrompt("帮我生成一张壁纸"), "");
  assert.equal(extractImagePrompt("做个头像"), "");
  assert.equal(extractImagePrompt("来一张 猫的图片"), "猫的图片");
  assert.equal(extractImagePrompt("给我画幅山水"), "山水");
  assert.equal(extractImagePrompt("能画一只猫吗"), "猫");
  assert.equal(extractImagePrompt("生成一幅山水画"), "山水画");
});

test("extractImagePrompt 剥掉触发词留下画面描述", () => {
  assert.equal(extractImagePrompt("画一张 一只猫"), "一只猫");
  assert.equal(extractImagePrompt("帮我画个 戴帽子的柴犬"), "戴帽子的柴犬");
  assert.equal(extractImagePrompt("画一张"), "");
});

test("buildImageGenRequest 构造 /images/generations 请求", () => {
  const req = buildImageGenRequest({ baseURL: "https://img.example/v1/", [keyProp]: "k-1", model: "img-m" }, "一只猫");
  assert.equal(req.url, "https://img.example/v1/images/generations");
  assert.equal(req.options.headers.Authorization, "Bearer k-1");
  const body = JSON.parse(req.options.body);
  assert.equal(body.model, "img-m");
  assert.equal(body.prompt, "一只猫");
  assert.equal(body.size, "1024x1024");
});

test("parseImageGenResponse 认 b64/url/顶层 url/images 数组，都没有返回 null", () => {
  assert.deepEqual(parseImageGenResponse({ data: [{ b64_json: "AAAA" }] }), { b64: "AAAA" });
  assert.deepEqual(parseImageGenResponse({ data: [{ url: "https://x.example/a.png" }] }), { url: "https://x.example/a.png" });
  assert.deepEqual(parseImageGenResponse({ url: "https://x.example/b.png" }), { url: "https://x.example/b.png" });
  assert.deepEqual(parseImageGenResponse({ images: [{ url: "https://x.example/c.png" }] }), { url: "https://x.example/c.png" });
  assert.equal(parseImageGenResponse({ data: [] }), null);
  assert.equal(parseImageGenResponse(null), null);
});

test("v0.9.22 「生产一张…实景照」也算生图，生产+非图像宾语不误触发", () => {
assert.equal(isImageGenRequest("生产一张东方明珠的实景照，真实"), true);
assert.equal(extractImagePrompt("生产一张东方明珠的实景照，真实"), "东方明珠的实景照，真实");
assert.equal(isImageGenRequest("生产一个函数"), false);
assert.equal(isImageGenRequest("生产线怎么升级"), false);
});
