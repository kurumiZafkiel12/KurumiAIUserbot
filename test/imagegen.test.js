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
