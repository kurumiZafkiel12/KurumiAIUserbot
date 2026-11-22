// 模型自动识别的单元测试：挑选规则是纯函数；detectModel 用假 fetch 不打真网络。
import test from "node:test";
import assert from "node:assert/strict";
import { pickModel, detectModel, ensureProviderModels, inheritModels } from "../src/modeldetect.js";

test("pickModel：优先带 chat 的，其次轻量档，过滤非聊天模型", () => {
  assert.equal(pickModel(["deepseek-reasoner", "deepseek-chat"]), "deepseek-chat");
  assert.equal(pickModel(["deepseek-v4-pro", "deepseek-flash"]), "deepseek-flash");
  assert.equal(pickModel(["text-embedding-3-small", "gpt-4o"]), "gpt-4o");
  assert.equal(pickModel(["whisper-1", "dall-e-3"]), null);
  assert.equal(pickModel([]), null);
  assert.equal(pickModel(null), null);
});

test("detectModel：解析 /models 的 data 列表并挑模型；HTTP 失败返回 null", async () => {
  const okFetch = async (url, opts) => {
    assert.match(url, /\/models$/);
    assert.equal(opts.headers.Authorization, "Bearer test-key");
    return { ok: true, json: async () => ({ data: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }] }) };
  };
  assert.equal(await detectModel("https://api.example/v1/", "test-key", okFetch), "deepseek-flash");
  const badFetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  assert.equal(await detectModel("https://api.example/v1", "k", badFetch), null);
  const throwFetch = async () => { throw new Error("network down"); };
  assert.equal(await detectModel("https://api.example/v1", "k", throwFetch), null);
});

test("ensureProviderModels：只补空模型，识别失败退回 gpt-4o-mini 并标警告路径", async () => {
  const providers = [
    { name: "a", baseURL: "https://api.example/v1", apiKey: "k", model: "" },
    { name: "b", baseURL: "https://api.example/v1", apiKey: "k", model: "already-set" },
    { name: "c", baseURL: "https://bad.example/v1", apiKey: "k", model: "" },
  ];
  const fetchImpl = async (url) => {
    if (url.includes("bad.example")) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, json: async () => ({ data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }] }) };
  };
  const logs = { info: [], warn: [] };
  const logger = { info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m) };
  await ensureProviderModels(providers, logger, fetchImpl);
  assert.equal(providers[0].model, "deepseek-chat");
  assert.equal(providers[0].modelAuto, true);
  assert.equal(providers[1].model, "already-set");
  assert.equal(providers[2].model, "gpt-4o-mini");
  assert.equal(logs.info.length, 1);
  assert.equal(logs.warn.length, 1);
});

test("inheritModels：按提供方名继承旧模型（含自动标记），无可继承时退回默认", () => {
  const fresh = [{ name: "default", model: "" }, { name: "newone", model: "" }];
  const prev = [{ name: "default", model: "deepseek-flash", modelAuto: true }];
  inheritModels(fresh, prev, null);
  assert.equal(fresh[0].model, "deepseek-flash");
  assert.equal(fresh[0].modelAuto, true);
  assert.equal(fresh[1].model, "gpt-4o-mini");
});
